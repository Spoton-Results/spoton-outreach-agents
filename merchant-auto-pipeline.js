#!/usr/bin/env node
/**
 * SpotOn Results — Merchant Lead Pipeline Scraper
 *
 * Railway cron job (daily at 7am UTC) that:
 *   1. Scrapes Yellow Pages for merchant leads by business type & city
 *   2. Enriches leads with email via Hunter.io domain-search API
 *   3. Deduplicates against existing GHL contacts
 *   4. Creates GHL contacts tagged for merchant outreach
 *   5. Assigns each contact to the Merchant Services pipeline (Cold stage)
 *   6. Agent 39 SMS fires automatically on new contacts
 *
 * Run manually: node merchant-auto-pipeline.js
 * Scheduled:    Railway cron — daily at 7am UTC (0 7 * * *)
 *
 * Required env vars:
 *   GHL_API_KEY, GHL_LOCATION_ID,
 *   GHL_MERCHANT_PIPELINE_ID, GHL_MERCHANT_STAGE_COLD
 *
 * Optional env vars:
 *   HUNTER_API_KEY  — Hunter.io key for email enrichment (in Railway shared env)
 */
require('dotenv').config({ path: './config/.env' });
const { callGHL, logRun, sleep } = require('./utils/helpers');

// ── Target business categories on Yellow Pages ────────────────────────────────────────────────
const YP_CATEGORIES = [
  'restaurants',
  'retail-stores',
  'hair-salons',
  'auto-repair',
  'dental-offices',
  'gyms',
  'coffee-shops',
  'bars',
  'spas',
  'boutiques'
];

// ── Target cities (national spread, high SMB density) ───────────────────────────────────────
const TARGET_CITIES = [
  'new-york-ny',
  'los-angeles-ca',
  'chicago-il',
  'houston-tx',
  'phoenix-az',
  'philadelphia-pa',
  'san-antonio-tx',
  'san-diego-ca',
  'dallas-tx',
  'austin-tx',
  'jacksonville-fl',
  'fort-worth-tx',
  'columbus-oh',
  'charlotte-nc',
  'indianapolis-in',
  'san-francisco-ca',
  'seattle-wa',
  'denver-co',
  'nashville-tn',
  'las-vegas-nv'
];

// ── Hunter.io email enrichment ────────────────────────────────────────────────────────────────────────────────────
const HUNTER_API_KEY  = process.env.HUNTER_API_KEY || null;
const GENERIC_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'icloud.com', 'aol.com', 'me.com', 'live.com', 'msn.com'
]);

function extractDomain(url) {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

async function getEmailFromHunter(domain) {
  if (!HUNTER_API_KEY || !domain || GENERIC_DOMAINS.has(domain)) return null;

  const fetch = (await import('node-fetch')).default;
  const params = new URLSearchParams({
    domain,
    api_key: HUNTER_API_KEY,
    limit:   '5',
    type:    'personal'
  });

  try {
    const res = await fetch(`https://api.hunter.io/v2/domain-search?${params}`, {
      timeout: 8000
    });

    if (res.status === 404) return null;
    if (res.status === 429) {
      console.log(`[Hunter] Rate limit — skipping email for ${domain}`);
      return null;
    }
    if (!res.ok) return null;

    const data = await res.json();
    const emails = data?.data?.emails || [];
    if (!emails.length) return null;

    const ownerTitles = ['owner', 'manager', 'director', 'president', 'ceo', 'founder'];
    const verified = emails.filter(e => e.confidence >= 70);
    const pool = verified.length ? verified : emails;

    pool.sort((a, b) => {
      const aOwner = ownerTitles.some(t => (a.position || '').toLowerCase().includes(t)) ? 1 : 0;
      const bOwner = ownerTitles.some(t => (b.position || '').toLowerCase().includes(t)) ? 1 : 0;
      if (bOwner !== aOwner) return bOwner - aOwner;
      return (b.confidence || 0) - (a.confidence || 0);
    });

    return pool[0]?.value || null;
  } catch (err) {
    console.log(`[Hunter] Error (${domain}): ${err.message}`);
    return null;
  }
}

// ── Scrape Yellow Pages for a given category + city ───────────────────────────────────────────────
async function scrapeYellowPages(category, city) {
  const fetch = (await import('node-fetch')).default;
  const url = `https://www.yellowpages.com/${city}/${category}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });

  if (!res.ok) throw new Error(`YP ${res.status} — ${category}/${city}`);
  const html = await res.text();

  const leads = [];

  const namePattern    = /<a\s+class="business-name"[^>]*>\s*<span[^>]*>([^<]+)<\/span>/gi;
  const phonePattern   = /<div\s+class="phones[^"]*"[^>]*>\s*<a[^>]*>([^<]+)<\/a>/gi;
  const streetPattern  = /<span\s+itemprop="streetAddress"[^>]*>([^<]+)<\/span>/gi;
  const localityPattern =
    /<span\s+itemprop="addressLocality"[^>]*>([^<]+)<\/span>.*?<span\s+itemprop="addressRegion"[^>]*>([^<]+)<\/span>.*?<span\s+itemprop="postalCode"[^>]*>([^<]+)<\/span>/gis;
  const websitePattern = /<a\s+class="track-visit-website"[^>]*href="([^"]+)"/gi;

  const names      = [];
  const phones     = [];
  const streets    = [];
  const localities = [];
  const websites   = [];

  let m;
  while ((m = namePattern.exec(html))    !== null) names.push(m[1].trim());
  while ((m = phonePattern.exec(html))   !== null) phones.push(m[1].trim());
  while ((m = streetPattern.exec(html))  !== null) streets.push(m[1].trim());
  while ((m = localityPattern.exec(html)) !== null)
    localities.push({ city: m[1].trim(), state: m[2].trim(), zip: m[3].trim() });
  while ((m = websitePattern.exec(html)) !== null) websites.push(m[1].trim());

  for (let i = 0; i < names.length; i++) {
    if (!names[i] || names[i].length < 2) continue;
    leads.push({
      organization_name: names[i],
      phone:    phones[i]      || '',
      street:   streets[i]     || '',
      city:     localities[i]?.city  || city.replace(/-[a-z]{2}$/, '').replace(/-/g, ' '),
      state:    localities[i]?.state || '',
      zip:      localities[i]?.zip   || '',
      website:  websites[i]    || '',
      category,
      source:   'yellowpages'
    });
  }

  return leads;
}

// ── Check if a business already exists in GHL ─────────────────────────────────────────────────────────────────────────
async function existsInGHL(businessName) {
  try {
    const locId = process.env.GHL_LOCATION_ID;
    const res = await callGHL(
      'GET',
      `/contacts/?locationId=${locId}&query=${encodeURIComponent(businessName)}&limit=1`
    );
    return (res.contacts || []).length > 0;
  } catch {
    return false;
  }
}

// ── Create GHL contact + Merchant Services pipeline opportunity ───────────────────────────────────────────
async function pushToMerchantPipeline(lead, email) {
  const locId      = process.env.GHL_LOCATION_ID;
  const pipelineId = process.env.GHL_MERCHANT_PIPELINE_ID || process.env.GHL_PIPELINE_ID;
  const stageId    = process.env.GHL_MERCHANT_STAGE_COLD  || process.env.GHL_STAGE_COLD;

  const contactPayload = {
    locationId:  locId,
    name:        lead.organization_name,
    companyName: lead.organization_name,
    phone:       lead.phone   || '',
    website:     lead.website || '',
    address1:    lead.street  || '',
    city:        lead.city    || '',
    state:       lead.state   || '',
    postalCode:  lead.zip     || '',
    source:      'YP Merchant Scraper',
    tags: [
      'merchant-prospect',
      'yp-scrape',
      'cold-outreach',
      'merchant-services',
      lead.category || 'unknown-category'
    ],
    customFields: [
      { key: 'scrape_source',   field_value: 'yellowpages' },
      { key: 'scrape_category', field_value: lead.category || '' },
      { key: 'scrape_city',     field_value: lead.city     || '' }
    ]
  };

  if (email) contactPayload.email = email;

  const contactRes = await callGHL('POST', '/contacts/', contactPayload);
  if (!contactRes.contact?.id) return null;

  await callGHL('POST', '/opportunities/', {
    pipelineId,
    pipelineStageId: stageId,
    contactId:       contactRes.contact.id,
    locationId:      locId,
    name:            lead.organization_name + ' — Merchant Outreach',
    status:          'open',
    source:          'YP Scraper'
  });

  return contactRes.contact.id;
}

// ── Main ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🏪  SpotOn Results — Merchant Lead Pipeline Scraper');
  console.log('    ' + new Date().toISOString());
  console.log('    Categories : ' + YP_CATEGORIES.length);
  console.log('    Cities     : ' + TARGET_CITIES.length);
  console.log('    Pairs      : ' + YP_CATEGORIES.length * TARGET_CITIES.length);
  console.log('    Hunter.io  : ' + (HUNTER_API_KEY ? 'enabled (email enrichment)' : 'disabled') + '\n');

  const allLeads = [];
  const seen     = new Set();

  for (const category of YP_CATEGORIES) {
    for (const city of TARGET_CITIES) {
      try {
        const results = await scrapeYellowPages(category, city);

        for (const lead of results) {
          const key = lead.organization_name.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (key.length > 2 && !seen.has(key)) {
            seen.add(key);
            allLeads.push(lead);
          }
        }

        console.log(`[YP] ${category}/${city}: ${results.length} leads`);
      } catch (e) {
        console.log(`[YP] ${category}/${city} failed: ${e.message}`);
      }

      await sleep(1500);
    }
  }

  console.log(`\n📊 Total unique leads scraped: ${allLeads.length}`);

  let pushed       = 0;
  let skipped      = 0;
  let failed       = 0;
  let emailsFound  = 0;

  for (const lead of allLeads) {
    const exists = await existsInGHL(lead.organization_name);
    if (exists) {
      skipped++;
      continue;
    }

    let email = null;
    if (HUNTER_API_KEY && lead.website) {
      const domain = extractDomain(lead.website);
      email = await getEmailFromHunter(domain);
      if (email) {
        emailsFound++;
        console.log(`[Hunter] 📧 ${email} → ${lead.organization_name}`);
      }
      await sleep(200);
    }

    const id = await pushToMerchantPipeline(lead, email).catch(e => {
      console.log(`[GHL] Failed for "${lead.organization_name}": ${e.message}`);
      failed++;
      return null;
    });

    if (id) {
      pushed++;
      if (pushed % 25 === 0) {
        console.log(`[GHL] ✓ ${pushed} contacts pushed to Merchant Services pipeline...`);
      }
    }

    await sleep(400);
  }

  console.log('\n✅ Merchant pipeline scraper complete');
  console.log(`   Scraped:  ${allLeads.length}`);
  console.log(`   Pushed:   ${pushed}  → Merchant Services pipeline (Cold)`);
  console.log(`   Emails:   ${emailsFound} / ${pushed} leads enriched (${pushed ? Math.round(emailsFound/pushed*100) : 0}%)`);
  console.log(`   Skipped:  ${skipped} (already in GHL)`);
  console.log(`   Failed:   ${failed}`);

  logRun('merchant-auto-pipeline', {
    total_scraped:  allLeads.length,
    pushed,
    emails_found:   emailsFound,
    skipped,
    failed,
    categories:     YP_CATEGORIES.length,
    cities:         TARGET_CITIES.length
  });
}

main().catch(e => {
  console.error('❌ Merchant pipeline scraper error:', e.message);
  console.error(e.stack);
  process.exit(1);
});
