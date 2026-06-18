/**
 * Agent 01: Prospect Finder — The Orchestrator
 * 
 * This is the brain. It decides WHERE to find GCs, pulls from ALL sources
 * simultaneously, deduplicates, and hands a clean batch to the pipeline.
 * 
 * Sources it orchestrates:
 *   1. Apollo.io       — B2B database, title/industry filters
 *   2. Vibe            — Enriched contacts with emails/phones
 *   3. Firecrawl       — Any URL: directories, license boards, association pages
 *   4. Google CSE      — Searches 12 city+keyword combos automatically
 *   5. GHL dedup check — Never returns someone already in the pipeline
 * 
 * It decides:
 *   - Which state to target this run (rotates CA→UT→TX→FL→AZ)
 *   - Which cities in that state to hit
 *   - Which sources to use (skips sources with no key or exhausted credits)
 *   - How many prospects to pull per source
 *   - How to merge and deduplicate across sources
 * 
 * The continuous prospector just calls this. One function. Done.
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, logRun, notifyDashboard } = require('../utils/helpers');

// Source clients
const apollo    = require('../utils/apollo-client');
const vibe      = require('../utils/vibe-client');

// State rotation
const STATE_ROTATION = [
  { state: 'California', code: 'CA', campaign: process.env.INSTANTLY_CA_CAMPAIGN_ID || process.env.INSTANTLY_CAMPAIGN_ID },
  { state: 'Utah',       code: 'UT', campaign: process.env.INSTANTLY_UT_CAMPAIGN_ID },
  { state: 'Texas',      code: 'TX', campaign: process.env.INSTANTLY_TX_CAMPAIGN_ID },
  { state: 'Florida',    code: 'FL', campaign: process.env.INSTANTLY_FL_CAMPAIGN_ID },
  { state: 'Arizona',    code: 'AZ', campaign: process.env.INSTANTLY_AZ_CAMPAIGN_ID },
];

const CITIES = {
  California: ['Los Angeles','San Diego','San Jose','San Francisco','Sacramento','Fresno','Long Beach','Oakland','Bakersfield','Anaheim','Riverside','Stockton','Irvine','Modesto'],
  Utah:       ['Salt Lake City','St. George','Provo','Ogden','Orem','Sandy','West Jordan','West Valley City','Lehi','Murray'],
  Texas:      ['Houston','Dallas','Austin','San Antonio','Fort Worth','El Paso','Arlington','Corpus Christi','Plano','Lubbock'],
  Florida:    ['Miami','Orlando','Tampa','Jacksonville','Fort Lauderdale','Tallahassee','St. Petersburg','Hialeah','Port St. Lucie','Cape Coral'],
  Arizona:    ['Phoenix','Tucson','Mesa','Chandler','Scottsdale','Glendale','Gilbert','Tempe','Peoria','Surprise'],
};

// Directories to scrape per state — Firecrawl handles all blocking
const SCRAPE_URLS = {
  California: [
    'https://www.buildzoom.com/contractors/california',
    'https://www.angieslist.com/companylist/general-contractor/california.htm',
    'https://www2.cslb.ca.gov/OnlineServices/CheckLicenseII/LicenseSearch.aspx',
  ],
  Utah: [
    'https://www.buildzoom.com/contractors/utah',
    'https://www.angieslist.com/companylist/general-contractor/utah.htm',
  ],
  Texas: [
    'https://www.buildzoom.com/contractors/texas',
    'https://www.angieslist.com/companylist/general-contractor/texas.htm',
  ],
  Florida: [
    'https://www.buildzoom.com/contractors/florida',
  ],
  Arizona: [
    'https://www.buildzoom.com/contractors/arizona',
  ],
};

let stateIndex = 0;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Pull prospects from Apollo
 */
async function fromApollo(state, limit = 15) {
  try {
    const results = await apollo.searchProspects({ state, limit });
    console.log('[Agent 01] Apollo: ' + results.length + ' prospects');
    return results.map(p => ({ ...p, _source: 'apollo' }));
  } catch(e) {
    console.log('[Agent 01] Apollo failed:', e.message);
    return [];
  }
}

/**
 * Pull prospects from Vibe
 */
async function fromVibe(state, limit = 15) {
  try {
    const results = await vibe.searchProspects({ state, limit });
    console.log('[Agent 01] Vibe: ' + results.length + ' prospects');
    return results.map(p => ({ ...p, _source: 'vibe' }));
  } catch(e) {
    console.log('[Agent 01] Vibe failed:', e.message);
    return [];
  }
}

/**
 * Scrape a directory URL using Firecrawl + Claude extraction
 */
async function fromFirecrawl(url, state) {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return [];

  try {
    const fetch = (await import('node-fetch')).default;

    console.log('[Agent 01] Firecrawl scraping:', url);

    // Scrape the page
    const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: false, waitFor: 2000 }),
      timeout: 45000
    });

    const data = await r.json();
    if (!data.success || !data.data?.markdown) {
      console.log('[Agent 01] Firecrawl no content from:', url);
      return [];
    }

    const markdown = data.data.markdown.substring(0, 20000);

    // Claude extracts GC contacts from the markdown
    const prompt = `You are extracting General Contractor leads for SubDraw — a subcontractor invoice management SaaS.

Target: GCs who manage multiple subcontractors. They need SubDraw to catch invoice overruns.
Skip: Specialty trades (electricians, plumbers, roofers, HVAC, painters, landscapers) unless they do general contracting too.

Source URL: ${url}
State: ${state}

Page content:
${markdown}

Extract every GC company. Return a JSON array:
[{
  "organization_name": "company name",
  "first_name": "", "last_name": "", "name": "owner name if found",
  "email": "email or null", "phone": "phone or null",
  "website": "website or null", "city": "city or null", "state": "${state.substring(0,2).toUpperCase()}",
  "license_number": "license # or null", "rating": "stars or null", "reviews": "count or null"
}]

Return [] if no GCs found. JSON only, no markdown.`;

    const raw = await callClaude(
      'Extract General Contractor contacts from web pages. Return JSON arrays only.',
      prompt
    );

    const contacts = JSON.parse(raw.replace(/```json|```/g, '').trim());
    if (!Array.isArray(contacts)) return [];

    console.log('[Agent 01] Firecrawl extracted ' + contacts.length + ' from ' + url.split('/')[2]);
    return contacts.map(c => ({ ...c, _source: 'firecrawl', source_url: url }));

  } catch(e) {
    console.log('[Agent 01] Firecrawl error for ' + url + ':', e.message);
    return [];
  }
}

/**
 * Google Custom Search — 100 free queries/day
 */
async function fromGoogle(state, cities) {
  const apiKey = process.env.GOOGLE_CSE_API_KEY;
  const cx     = process.env.GOOGLE_CSE_CX;
  if (!apiKey || !cx) return [];

  const results = [];
  const queries = cities.slice(0, 5).map(city => `general contractor ${city} ${state}`);

  for (const query of queries) {
    try {
      const fetch = (await import('node-fetch')).default;
      const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(query)}&num=10`;
      const r = await fetch(url);
      const data = await r.json();

      for (const item of (data.items || [])) {
        const skip = ['yelp','houzz','homeadvisor','angieslist','wikipedia','youtube','facebook','linkedin'];
        if (skip.some(s => item.link.includes(s))) continue;

        const name = item.title.replace(/\s*[-|:]\s*.*$/, '').trim();
        if (name.length < 3) continue;

        results.push({
          organization_name: name,
          website: item.link,
          city: query.split(' ')[2] || '',
          state: state.substring(0,2).toUpperCase(),
          _source: 'google_cse'
        });
      }
      await sleep(200);
    } catch(e) {
      console.log('[Agent 01] Google CSE error:', e.message);
    }
  }

  console.log('[Agent 01] Google CSE: ' + results.length + ' prospects');
  return results;
}

/**
 * Check GHL for existing contacts to avoid duplicates
 */
async function getExistingGHLCompanies() {
  try {
    const locId = process.env.GHL_LOCATION_ID;
    const existing = new Set();
    const tags = ['ca-gc', 'ut-gc', 'gc-prospect'];

    for (const tag of tags) {
      const r = await callGHL('GET', `/contacts/?locationId=${locId}&query=${tag}&limit=100`);
      (r.contacts || []).forEach(c => {
        if (c.companyName) existing.add(c.companyName.toLowerCase().replace(/[^a-z0-9]/g, ''));
      });
    }
    return existing;
  } catch(e) {
    return new Set();
  }
}

/**
 * Main orchestration function — called by continuous prospector
 */
async function findProspects(options = {}) {
  // Get current state target
  const targets = STATE_ROTATION.filter(s => s.campaign);
  if (!targets.length) {
    console.log('[Agent 01] No campaigns configured — set INSTANTLY_CA_CAMPAIGN_ID');
    return [];
  }

  const target = targets[stateIndex % targets.length];
  stateIndex++;

  const { state, code } = target;
  const cities = CITIES[state] || [];
  const scrapeUrls = SCRAPE_URLS[state] || [];
  const limit = options.limit || parseInt(process.env.BATCH_SIZE || '15');

  console.log('\n[Agent 01] Orchestrating prospect hunt');
  console.log('[Agent 01] State: ' + state + ' | Target: ' + limit + ' prospects');
  console.log('[Agent 01] Sources: Apollo, Vibe, Firecrawl (' + scrapeUrls.length + ' URLs), Google CSE');

  // Get existing GHL contacts to deduplicate
  const existing = await getExistingGHLCompanies();
  console.log('[Agent 01] GHL dedup set: ' + existing.size + ' known companies');

  // Fire ALL sources in parallel
  const [apolloResults, vibeResults, googleResults, ...scrapeResults] = await Promise.all([
    fromApollo(state, limit),
    fromVibe(state, limit),
    fromGoogle(state, cities),
    ...scrapeUrls.map(url => fromFirecrawl(url, state))
  ]);

  // Merge all sources
  const allRaw = [
    ...apolloResults,
    ...vibeResults,
    ...googleResults,
    ...scrapeResults.flat()
  ];

  console.log('[Agent 01] Raw total from all sources: ' + allRaw.length);

  // Deduplicate by company name
  const seen = new Set();
  const deduped = allRaw.filter(p => {
    const key = (p.organization_name || p.company || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (key.length < 2 || seen.has(key) || existing.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log('[Agent 01] After dedup: ' + deduped.length + ' unique new prospects');

  // Notify dashboard
  await notifyDashboard('prospect_found', {
    state,
    sources: { apollo: apolloResults.length, vibe: vibeResults.length, google: googleResults.length, firecrawl: scrapeResults.flat().length },
    total: deduped.length
  });

  logRun('01-prospect-finder', {
    state,
    apollo: apolloResults.length,
    vibe: vibeResults.length,
    google: googleResults.length,
    firecrawl: scrapeResults.flat().length,
    total_raw: allRaw.length,
    after_dedup: deduped.length
  });

  // Return normalized contacts for the pipeline
  return deduped.map(p => ({
    name: p.name || p.first_name + ' ' + p.last_name || '',
    first_name: p.first_name || '',
    last_name: p.last_name || '',
    title: p.title || 'Owner',
    email: p.email || '',
    phone: p.phone || '',
    organization_name: p.organization_name || p.company || '',
    website: p.website || '',
    city: p.city || '',
    state: p.state || code,
    license_number: p.license_number || '',
    rating: p.rating || '',
    reviews: p.reviews || '',
    source: p._source || 'unknown',
    source_url: p.source_url || '',
    campaign_id: target.campaign
  }));
}

module.exports = { findProspects };
