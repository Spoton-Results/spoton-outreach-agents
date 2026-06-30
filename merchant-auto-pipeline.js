#!/usr/bin/env node
/**
 * SpotOn Results — Merchant Lead Pipeline Scraper
 *
 * Railway cron job (weekly) that:
 *   1. Scrapes Yellow Pages for merchant leads by business type & city
 *   2. Deduplicates against existing GHL contacts
 *   3. Creates GHL contacts tagged for merchant outreach
 *   4. Assigns each contact to the Merchant Services pipeline (Cold stage)
 *
 * Run manually: node merchant-auto-pipeline.js
 * Scheduled:    Railway cron — weekly
 *
 * Required env vars (see config/env-merchant.example):
 *   GHL_API_KEY, GHL_LOCATION_ID,
 *   GHL_MERCHANT_PIPELINE_ID, GHL_MERCHANT_STAGE_COLD
 */
require('dotenv').config({ path: './config/.env' });
const { callGHL, logRun, sleep } = require('./utils/helpers');

// ── Target business categories on Yellow Pages ────────────────────────────────
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

// ── Target cities (national spread, high SMB density) ─────────────────────────
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

// ── Scrape Yellow Pages for a given category + city ───────────────────────────
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

  // Business name
  const namePattern = /<a\s+class="business-name"[^>]*>\s*<span[^>]*>([^<]+)<\/span>/gi;
  // Phone
  const phonePattern = /<div\s+class="phones[^"]*"[^>]*>\s*<a[^>]*>([^<]+)<\/a>/gi;
  // Street address
  const streetPattern = /<span\s+itemprop="streetAddress"[^>]*>([^<]+)<\/span>/gi;
  // City/state/zip
  const localityPattern =
    /<span\s+itemprop="addressLocality"[^>]*>([^<]+)<\/span>.*?<span\s+itemprop="addressRegion"[^>]*>([^<]+)<\/span>.*?<span\s+itemprop="postalCode"[^>]*>([^<]+)<\/span>/gis;
  // Website
  const websitePattern = /<a\s+class="track-visit-website"[^>]*href="([^"]+)"/gi;

  const names = [];
  const phones = [];
  const streets = [];
  const localities = [];
  const websites = [];

  let m;
  while ((m = namePattern.exec(html)) !== null) names.push(m[1].trim());
  while ((m = phonePattern.exec(html)) !== null) phones.push(m[1].trim());
  while ((m = streetPattern.exec(html)) !== null) streets.push(m[1].trim());
  while ((m = localityPattern.exec(html)) !== null)
    localities.push({ city: m[1].trim(), state: m[2].trim(), zip: m[3].trim() });
  while ((m = websitePattern.exec(html)) !== null) websites.push(m[1].trim());

  for (let i = 0; i < names.length; i++) {
    if (!names[i] || names[i].length < 2) continue;
    leads.push({
      organization_name: names[i],
      phone: phones[i] || '',
      street: streets[i] || '',
      city: localities[i]?.city || city.replace(/-[a-z]{2}$/, '').replace(/-/g, ' '),
      state: localities[i]?.state || '',
      zip: localities[i]?.zip || '',
      website: websites[i] || '',
      category,
      source: 'yellowpages'
    });
  }

  return leads;
}

// ── Check if a business already exists in GHL ─────────────────────────────────
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

// ── Create GHL contact + Merchant Services pipeline opportunity ───────────────
async function pushToMerchantPipeline(lead) {
  const locId      = process.env.GHL_LOCATION_ID;
  const pipelineId = process.env.GHL_MERCHANT_PIPELINE_ID || process.env.GHL_PIPELINE_ID;
  const stageId    = process.env.GHL_MERCHANT_STAGE_COLD  || process.env.GHL_STAGE_COLD;

  // Create contact
  const contactRes = await callGHL('POST', '/contacts/', {
    locationId:  locId,
    name:        lead.organization_name,
    companyName: lead.organization_name,
    phone:       lead.phone  || '',
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
  });

  if (!contactRes.contact?.id) return null;

  // Add to Merchant Services pipeline at Cold stage
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

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🏪  SpotOn Results — Merchant Lead Pipeline Scraper');
  console.log('    ' + new Date().toISOString());
  console.log('    Categories : ' + YP_CATEGORIES.length);
  console.log('    Cities     : ' + TARGET_CITIES.length);
  console.log('    Pairs      : ' + YP_CATEGORIES.length * TARGET_CITIES.length + '\n');

  const allLeads = [];
  const seen     = new Set();

  // Scrape Yellow Pages — every category × city combination
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

      // Polite delay between requests — avoid rate limiting
      await sleep(1500);
    }
  }

  console.log(`\n📊 Total unique leads scraped: ${allLeads.length}`);

  // Push to GHL — skip duplicates
  let pushed  = 0;
  let skipped = 0;
  let failed  = 0;

  for (const lead of allLeads) {
    const exists = await existsInGHL(lead.organization_name);
    if (exists) {
      skipped++;
      continue;
    }

    const id = await pushToMerchantPipeline(lead).catch(e => {
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

    // Respect GHL API rate limits
    await sleep(400);
  }

  // Summary
  console.log('\n✅ Merchant pipeline scraper complete');
  console.log(`   Scraped:  ${allLeads.length}`);
  console.log(`   Pushed:   ${pushed}  → Merchant Services pipeline (Cold)`);
  console.log(`   Skipped:  ${skipped} (already in GHL)`);
  console.log(`   Failed:   ${failed}`);

  logRun('merchant-auto-pipeline', {
    total_scraped: allLeads.length,
    pushed,
    skipped,
    failed,
    categories: YP_CATEGORIES.length,
    cities:     TARGET_CITIES.length
  });
}

main().catch(e => {
  console.error('❌ Merchant pipeline scraper error:', e.message);
  console.error(e.stack);
  process.exit(1);
});
