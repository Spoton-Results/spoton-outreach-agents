/**
 * GC Standalone Scraper
 * 
 * Runs LOCALLY (not on Railway) or on a free Replit instance.
 * Railway's network egress blocks external scraping.
 * 
 * This script:
 * 1. Scrapes Google Custom Search (100 free searches/day)
 * 2. Scrapes CSLB CA license database
 * 3. Pushes found companies directly into GHL pipeline
 * 4. Deduplicates against existing GHL contacts
 * 
 * Run manually: node scripts/gc-scraper-standalone.js
 * Or schedule via cron on your local machine / Replit
 * 
 * FREE APIs used:
 * - Google Custom Search: 100 queries/day free
 *   Get key: console.cloud.google.com → Enable "Custom Search API"
 *   Get CX:  cse.google.com → Create search engine → set to search whole web
 * 
 * - CSLB: No API key needed, public government database
 */
require('dotenv').config({ path: './config/.env' });
const { callGHL, logRun } = require('../utils/helpers');

const CA_CITIES = [
  'Los Angeles', 'San Diego', 'San Jose', 'San Francisco',
  'Sacramento', 'Fresno', 'Long Beach', 'Oakland', 'Bakersfield',
  'Anaheim', 'Riverside', 'Stockton', 'Irvine', 'Modesto',
  'Fontana', 'Santa Clarita', 'Oxnard', 'Glendale', 'Huntington Beach'
];

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Google Custom Search — 100 free queries/day
 * Returns GC company names, websites, and descriptions
 */
async function searchGoogle(query, apiKey, cx) {
  const fetch = (await import('node-fetch')).default;
  const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&cx=${cx}&key=${apiKey}&num=10`;
  
  const res = await fetch(url);
  if (!res.ok) throw new Error('Google CSE: ' + res.status);
  const data = await res.json();
  
  return (data.items || []).map(item => ({
    organization_name: item.title.replace(/ - .*$/, '').replace(/ \|.*$/, '').trim(),
    website: item.link,
    snippet: item.snippet,
    source: 'google_cse'
  }));
}

/**
 * CSLB License Database — no API key, public government data
 * Lists every Class B (General Building) licensed contractor in CA
 */
async function scrapeCLSB(city) {
  const fetch = (await import('node-fetch')).default;
  
  // CSLB uses a GET request with query params
  const url = `https://www2.cslb.ca.gov/OnlineServices/CheckLicenseII/LicenseSearch.aspx?CITY=${encodeURIComponent(city)}&LICENSE_TYPE=B&CONTRACTORS_COUNT=50`;
  
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Referer': 'https://www2.cslb.ca.gov/'
    }
  });
  
  if (!res.ok) throw new Error('CSLB returned ' + res.status);
  const html = await res.text();
  
  // Extract company info from CSLB HTML table
  const companies = [];
  
  // Match table rows with license data
  const rowPattern = /<tr[^>]*class="[^"]*gridRow[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  
  while ((rowMatch = rowPattern.exec(html)) !== null) {
    const row = rowMatch[1];
    const cells = row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
    const cellTexts = cells.map(c => c.replace(/<[^>]+>/g, '').trim()).filter(Boolean);
    
    if (cellTexts.length >= 2) {
      const name = cellTexts[0];
      const license = cellTexts[1];
      if (name && name.length > 2 && /[A-Z]/.test(name)) {
        companies.push({
          organization_name: name,
          license_number: license,
          city,
          state: 'California',
          source: 'cslb'
        });
      }
    }
  }
  
  // Fallback: simpler pattern if table structure different
  if (companies.length === 0) {
    const namePattern = /BusinessName["\s]+>([A-Z][A-Z\s&.,'-]+)</g;
    let m;
    while ((m = namePattern.exec(html)) !== null) {
      if (m[1].trim().length > 2) {
        companies.push({
          organization_name: m[1].trim(),
          city,
          state: 'California',
          source: 'cslb'
        });
      }
    }
  }
  
  return companies;
}

/**
 * Check if company already exists in GHL to avoid duplicates
 */
async function existsInGHL(companyName) {
  try {
    const locId = process.env.GHL_LOCATION_ID;
    const res = await callGHL('GET', `/contacts/?locationId=${locId}&query=${encodeURIComponent(companyName)}&limit=1`);
    return (res.contacts || []).length > 0;
  } catch {
    return false;
  }
}

/**
 * Push a company into GHL as a cold prospect
 */
async function pushToGHL(company) {
  const locId = process.env.GHL_LOCATION_ID;
  const pipelineId = process.env.GHL_PIPELINE_ID;
  const coldStageId = process.env.GHL_STAGE_COLD;
  
  // Create contact
  const contact = await callGHL('POST', '/contacts/', {
    locationId: locId,
    firstName: company.first_name || '',
    lastName: company.last_name || '',
    name: company.name || company.organization_name,
    companyName: company.organization_name,
    email: company.email || '',
    phone: company.phone || '',
    website: company.website || '',
    source: 'SubDraw Scraper',
    tags: ['scrape-prospect', 'ca-gc', 'cold-outreach', 'agent-outreach', 'gc-prospect', 'subdraw-ca'],
    customFields: [
      { key: 'license_number', field_value: company.license_number || '' },
      { key: 'scrape_source', field_value: company.source || 'scrape' },
      { key: 'scrape_city', field_value: company.city || '' }
    ]
  });
  
  if (!contact.contact?.id) return null;
  
  // Add to pipeline as Cold
  await callGHL('POST', '/opportunities/', {
    pipelineId,
    pipelineStageId: coldStageId,
    contactId: contact.contact.id,
    name: company.organization_name + ' — SubDraw Outreach',
    status: 'open',
    source: 'Scraper'
  });
  
  return contact.contact.id;
}

async function main() {
  console.log('\n🕷️  GC Standalone Scraper — ' + new Date().toISOString());
  
  const googleKey = process.env.GOOGLE_CSE_API_KEY;
  const googleCX = process.env.GOOGLE_CSE_CX;
  const useGoogle = !!(googleKey && googleCX);
  const useCLSB = true; // Always available — no key needed
  
  console.log('Sources: Google CSE=' + (useGoogle ? '✓' : '✗ (no key)') + ', CSLB=✓');
  
  let allCompanies = [];
  const seen = new Set();
  
  // CSLB scrape — all CA cities
  if (useCLSB) {
    console.log('\n[CSLB] Scraping CA contractor license database...');
    for (const city of CA_CITIES) {
      try {
        const results = await scrapeCLSB(city);
        for (const c of results) {
          const key = c.organization_name.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (!seen.has(key)) {
            seen.add(key);
            allCompanies.push(c);
          }
        }
        console.log('[CSLB] ' + city + ': ' + results.length + ' contractors');
        await sleep(1000); // 1 second between requests
      } catch(e) {
        console.log('[CSLB] ' + city + ' failed:', e.message);
      }
    }
  }
  
  // Google CSE scrape
  if (useGoogle) {
    console.log('\n[Google] Searching for GC companies...');
    const queries = CA_CITIES.slice(0, 10).map(city => `general contractor ${city} California`);
    
    for (const query of queries) {
      try {
        const results = await searchGoogle(query, googleKey, googleCX);
        for (const c of results) {
          const key = c.organization_name.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (!seen.has(key) && key.length > 3) {
            seen.add(key);
            allCompanies.push(c);
          }
        }
        await sleep(200); // Respect rate limits
      } catch(e) {
        console.log('[Google] Query failed:', e.message);
      }
    }
  }
  
  console.log('\n📊 Total unique companies found: ' + allCompanies.length);
  
  // Push to GHL — check for duplicates first
  let pushed = 0;
  let skipped = 0;
  
  for (const company of allCompanies) {
    const exists = await existsInGHL(company.organization_name);
    if (exists) {
      skipped++;
      continue;
    }
    
    const id = await pushToGHL(company).catch(e => {
      console.log('GHL push failed for', company.organization_name, ':', e.message);
      return null;
    });
    
    if (id) {
      pushed++;
      if (pushed % 10 === 0) console.log('[GHL] Pushed ' + pushed + ' contacts...');
    }
    
    await sleep(300); // Don't hammer GHL API
  }
  
  console.log('\n✅ Scraper complete');
  console.log('   Found:   ' + allCompanies.length);
  console.log('   Pushed:  ' + pushed);
  console.log('   Skipped: ' + skipped + ' (already in GHL)');
  
  logRun('gc-scraper-standalone', {
    total_found: allCompanies.length,
    pushed,
    skipped,
    sources: { cslb: useCLSB, google: useGoogle }
  });
}

main().catch(console.error);
