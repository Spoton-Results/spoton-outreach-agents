/**
 * Agent 01: Prospect Finder
 * 3-layer prospect discovery — scraping + Apollo + Vibe
 * 
 * Layer 1: Web scraping (Yelp + Google Maps + CSLB) — free, unlimited
 * Layer 2: Apollo.io — 210M contacts, paid but comprehensive  
 * Layer 3: Vibe Prospecting — burns remaining credits
 * 
 * All three run in parallel and deduplicate by company name.
 * Scraping gives us companies. Apollo/Vibe give us named contacts.
 * Claude then cross-enriches: finds owner names for scraped companies.
 */
require('dotenv').config({ path: './config/.env' });
const { logRun, callClaude } = require('../utils/helpers');
const icp = require('../config/icp.json');
const apollo = require('../utils/apollo-client');
const vibe = require('../utils/vibe-client');
const { scrapeProspects, extractContactFromWebsite } = require('../utils/scraper-client');

const GC_TITLES = [
  'owner', 'president', 'principal', 'founder', 'co-founder',
  'general contractor', 'project executive', 'vp construction',
  'director of construction', 'construction manager', 'project manager'
];

const GC_KEYWORDS = [
  'general contractor', 'general contracting', 'construction management',
  'commercial construction', 'residential construction', 'building contractor'
];

async function findProspects(options = {}) {
  const { limit = 50, state = 'California' } = options;
  console.log('\n[Agent 01] Finding GC prospects in ' + state + ' (limit: ' + limit + ')');
  console.log('[Agent 01] Running 3 sources in parallel...');

  const results = { scrape: [], apollo: [], vibe: [] };

  // Run all 3 sources simultaneously
  await Promise.all([

    // Layer 1: Web scraping — always runs, no API key required
    scrapeProspects({ state, limit: Math.ceil(limit * 1.5) })
      .then(r => { results.scrape = r; console.log('[Agent 01] Scraper: ' + r.length + ' companies'); })
      .catch(e => console.log('[Agent 01] Scraper error:', e.message)),

    // Layer 2: Apollo — primary paid source
    process.env.APOLLO_API_KEY
      ? apollo.searchPeople({ titles: GC_TITLES, keywords: GC_KEYWORDS, state, limit })
          .then(r => { results.apollo = r; console.log('[Agent 01] Apollo: ' + r.length + ' contacts'); })
          .catch(e => console.log('[Agent 01] Apollo error:', e.message))
      : Promise.resolve(),

    // Layer 3: Vibe — secondary paid source
    process.env.VIBE_API_KEY
      ? vibe.searchProspects({ state, industries: ['construction', 'general contracting'], limit })
          .then(r => { results.vibe = r; console.log('[Agent 01] Vibe: ' + r.length + ' contacts'); })
          .catch(e => console.log('[Agent 01] Vibe error:', e.message))
      : Promise.resolve()

  ]);

  // Deduplicate across all sources by company name
  const seen = new Set();
  const combined = [];

  // Apollo and Vibe contacts first (they have named contacts already)
  for (const p of [...results.apollo, ...results.vibe]) {
    const key = (p.organization_name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (key.length > 2 && !seen.has(key)) {
      seen.add(key);
      combined.push(p);
    }
  }

  // Scraped companies — add if not already found via Apollo/Vibe
  const scrapedNew = [];
  for (const p of results.scrape) {
    const key = (p.organization_name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (key.length > 2 && !seen.has(key)) {
      seen.add(key);
      scrapedNew.push(p);
    }
  }

  console.log('[Agent 01] ' + combined.length + ' from APIs, ' + scrapedNew.length + ' new from scraping');

  // For scraped companies missing contact info, try to extract from their website
  // Only do this for the top 20 scraped companies (rate limit Claude calls)
  if (scrapedNew.length > 0) {
    console.log('[Agent 01] Enriching scraped contacts from websites...');
    const toEnrich = scrapedNew
      .filter(p => p.website && (!p.email || !p.first_name))
      .slice(0, 20);

    const enriched = await Promise.all(
      toEnrich.map(p => extractContactFromWebsite(p, callClaude).catch(() => p))
    );

    // Replace the original scraped entries with enriched versions
    const enrichedMap = new Map(enriched.map(p => [p.organization_name, p]));
    for (let i = 0; i < scrapedNew.length; i++) {
      if (enrichedMap.has(scrapedNew[i].organization_name)) {
        scrapedNew[i] = enrichedMap.get(scrapedNew[i].organization_name);
      }
    }
  }

  // Merge: API contacts + scraped companies
  const all = [...combined, ...scrapedNew];

  // Final filter: must have company name and at least one contact signal
  const valid = all.filter(p =>
    p.organization_name &&
    p.organization_name.length > 2 &&
    (p.email || p.phone || p.website || p.linkedin_url)
  );

  // Sort: contacts with email first (most actionable), then phone, then website only
  valid.sort((a, b) => {
    const score = p => (p.email ? 3 : 0) + (p.phone ? 2 : 0) + (p.website ? 1 : 0);
    return score(b) - score(a);
  });

  const final = valid.slice(0, limit);

  console.log('\n[Agent 01] Summary:');
  console.log('  Apollo/Vibe contacts: ' + combined.length);
  console.log('  New from scraping:    ' + scrapedNew.length);
  console.log('  Total unique:         ' + all.length);
  console.log('  Valid (have contact): ' + valid.length);
  console.log('  Passing to Agent 02:  ' + final.length);
  console.log('  With email:           ' + final.filter(p => p.email).length);
  console.log('  With phone only:      ' + final.filter(p => !p.email && p.phone).length);

  logRun('01-prospect-finder', {
    state, limit,
    apollo: results.apollo.length,
    vibe: results.vibe.length,
    scrape: results.scrape.length,
    scrape_new: scrapedNew.length,
    total_unique: all.length,
    valid: valid.length,
    final: final.length,
    with_email: final.filter(p => p.email).length
  });

  return final;
}

module.exports = { findProspects };
if (require.main === module) {
  findProspects({ limit: 10, state: 'California' })
    .then(r => {
      console.log('\n--- SAMPLE OUTPUT ---');
      r.slice(0, 3).forEach((p, i) => console.log(i+1 + '.', p.organization_name, '|', p.email || 'no email', '|', p.phone || 'no phone', '|', p.source));
    })
    .catch(console.error);
}
