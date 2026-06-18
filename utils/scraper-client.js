/**
 * GC Web Scraper — Agent 01 Layer 3
 * Free prospect discovery with zero API credits
 * 
 * Sources:
 * 1. CSLB (CA Contractors State License Board) — public license database
 * 2. Google Maps / Places via SerpAPI — "general contractor [city] CA"
 * 3. BBB (Better Business Bureau) — construction company listings
 * 4. Yelp business search — GC companies in target cities
 * 
 * All scraping is of publicly available business directories.
 * Returns same normalized format as apollo-client.js
 */
require('dotenv').config({ path: './config/.env' });

const CA_CITIES = [
  'Los Angeles', 'San Diego', 'San Jose', 'San Francisco', 'Fresno',
  'Sacramento', 'Long Beach', 'Oakland', 'Bakersfield', 'Anaheim',
  'Santa Ana', 'Riverside', 'Stockton', 'Irvine', 'Chula Vista',
  'Fremont', 'San Bernardino', 'Modesto', 'Fontana', 'Moreno Valley'
];

const TX_CITIES = [
  'Houston', 'Dallas', 'Austin', 'San Antonio', 'Fort Worth',
  'El Paso', 'Arlington', 'Corpus Christi', 'Plano', 'Lubbock'
];

const FL_CITIES = [
  'Miami', 'Orlando', 'Tampa', 'Jacksonville', 'Fort Lauderdale',
  'Hialeah', 'Tallahassee', 'Cape Coral', 'St. Petersburg', 'Pembroke Pines'
];

const CITIES_BY_STATE = {
  'California': CA_CITIES,
  'Texas': TX_CITIES,
  'Florida': FL_CITIES
};

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Source 1: SerpAPI Google Search
 * Searches Google for GC companies in target cities
 * Requires SERP_API_KEY env var ($50/mo for 5000 searches)
 */
async function scrapeGoogleMaps(city, state) {
  if (!process.env.SERP_API_KEY) return [];
  
  const fetch = (await import('node-fetch')).default;
  const query = encodeURIComponent(`general contractor ${city} ${state}`);
  
  try {
    const res = await fetch(
      `https://serpapi.com/search?engine=google_maps&q=${query}&type=search&api_key=${process.env.SERP_API_KEY}`,
      { timeout: 10000 }
    );
    if (!res.ok) return [];
    const data = await res.json();
    
    return (data.local_results || []).map(r => ({
      organization_name: r.title,
      website: r.website || '',
      phone: r.phone || '',
      city,
      state,
      address: r.address || '',
      rating: r.rating,
      reviews: r.reviews,
      source: 'google_maps'
    })).filter(r => r.organization_name);
    
  } catch(e) {
    console.log('[Scraper] Google Maps error for ' + city + ':', e.message);
    return [];
  }
}

/**
 * Source 2: Yelp Fusion API  
 * Searches for GC businesses — free tier: 500 calls/day
 * Requires YELP_API_KEY env var (free at yelp.com/developers)
 */
async function scrapeYelp(city, state) {
  if (!process.env.YELP_API_KEY) return [];
  
  const fetch = (await import('node-fetch')).default;
  
  try {
    const params = new URLSearchParams({
      term: 'general contractor',
      location: city + ', ' + state,
      categories: 'contractors,generalcontractors',
      limit: '20',
      sort_by: 'review_count'
    });
    
    const res = await fetch('https://api.yelp.com/v3/businesses/search?' + params, {
      headers: { 'Authorization': 'Bearer ' + process.env.YELP_API_KEY },
      timeout: 10000
    });
    
    if (!res.ok) return [];
    const data = await res.json();
    
    return (data.businesses || []).map(b => ({
      organization_name: b.name,
      website: b.url || '',
      phone: b.display_phone || b.phone || '',
      city: b.location?.city || city,
      state: b.location?.state || state,
      address: b.location?.display_address?.join(', ') || '',
      rating: b.rating,
      reviews: b.review_count,
      yelp_url: b.url,
      source: 'yelp'
    })).filter(r => r.organization_name && !r.organization_name.toLowerCase().includes('home depot'));
    
  } catch(e) {
    console.log('[Scraper] Yelp error for ' + city + ':', e.message);
    return [];
  }
}

/**
 * Source 3: CSLB License Lookup (CA only)
 * CA Contractors State License Board has public license data
 * Scrapes the public search — no API needed
 */
async function scrapeCLSB(city) {
  const fetch = (await import('node-fetch')).default;
  
  try {
    const params = new URLSearchParams({
      CITY: city,
      LICENSE_TYPE: 'B', // B = General Building Contractor
      CONTRACTORS_COUNT: '50'
    });
    
    const res = await fetch('https://www2.cslb.ca.gov/OnlineServices/CheckLicenseII/LicenseSearch.aspx?' + params, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; research bot)',
        'Accept': 'text/html'
      },
      timeout: 15000
    });
    
    if (!res.ok) return [];
    const html = await res.text();
    
    // Parse business names from CSLB HTML response
    const companies = [];
    const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
    
    for (const row of rows) {
      const nameMatch = row.match(/BusinessName[^>]*>([^<]+)</i);
      const licMatch = row.match(/LicenseNumber[^>]*>([^<]+)</i);
      const cityMatch = row.match(/City[^>]*>([^<]+)</i);
      
      if (nameMatch && nameMatch[1].trim().length > 2) {
        companies.push({
          organization_name: nameMatch[1].trim(),
          license_number: licMatch?.[1]?.trim() || '',
          city: cityMatch?.[1]?.trim() || city,
          state: 'California',
          source: 'cslb'
        });
      }
    }
    
    return companies.slice(0, 20);
    
  } catch(e) {
    console.log('[Scraper] CSLB error for ' + city + ':', e.message);
    return [];
  }
}

/**
 * Source 4: Direct website scraping via Claude
 * Given a company name and website, Claude extracts contact info
 */
async function extractContactFromWebsite(company, callClaude) {
  if (!company.website) return company;
  
  const fetch = (await import('node-fetch')).default;
  
  try {
    const res = await fetch(company.website, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; research bot)' },
      timeout: 8000
    });
    if (!res.ok) return company;
    
    const html = await res.text();
    // Extract just text content, strip HTML
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .substring(0, 3000); // First 3000 chars
    
    const prompt = `Extract contact information from this GC company website text.
Company: ${company.organization_name}
Website text: ${text}

Return JSON only:
{
  "owner_name": "first and last name of owner/president if found, or null",
  "first_name": "first name or null",
  "last_name": "last name or null", 
  "title": "their title or 'Owner'",
  "email": "business email if found or null",
  "phone": "phone number if found or null",
  "description": "one sentence about what they build (residential/commercial/industrial)"
}`;

    const { callClaude: cc } = require('./helpers');
    const SYSTEM = 'Extract business contact information from website text. Return JSON only. If info not found return null for that field.';
    const extracted = JSON.parse(await cc(SYSTEM, prompt));
    
    return {
      ...company,
      name: extracted.owner_name || company.organization_name,
      first_name: extracted.first_name || '',
      last_name: extracted.last_name || '',
      title: extracted.title || 'Owner',
      email: extracted.email || company.email || '',
      phone: extracted.phone || company.phone || '',
      description: extracted.description || ''
    };
    
  } catch(e) {
    return company; // Return unchanged if scrape fails
  }
}

/**
 * Main scrape function — runs all sources for a state
 * Returns normalized prospects ready for Agent 02
 */
async function scrapeProspects(options = {}) {
  const { state = 'California', limit = 50 } = options;
  const cities = CITIES_BY_STATE[state] || CA_CITIES;
  
  console.log('[Scraper] Starting web scrape for ' + state + ' GCs...');
  
  const allCompanies = [];
  const seen = new Set();
  
  // Scrape multiple cities in parallel batches of 3
  const cityBatches = [];
  for (let i = 0; i < cities.length; i += 3) {
    cityBatches.push(cities.slice(i, i + 3));
  }
  
  for (const batch of cityBatches) {
    if (allCompanies.length >= limit * 2) break; // Have enough to work with
    
    const results = await Promise.all(batch.map(async city => {
      const [yelp, google, cslb] = await Promise.all([
        scrapeYelp(city, state),
        scrapeGoogleMaps(city, state),
        state === 'California' ? scrapeCLSB(city) : Promise.resolve([])
      ]);
      return [...yelp, ...google, ...cslb];
    }));
    
    for (const batch of results) {
      for (const company of batch) {
        const key = company.organization_name.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!seen.has(key) && key.length > 3) {
          seen.add(key);
          allCompanies.push(company);
        }
      }
    }
    
    await sleep(500); // Be polite between batches
  }
  
  console.log('[Scraper] Found ' + allCompanies.length + ' unique companies across all sources');
  
  // Normalize to standard prospect format
  const normalized = allCompanies.slice(0, limit * 2).map(c => ({
    id: 'scrape_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
    name: c.name || c.organization_name,
    first_name: c.first_name || '',
    last_name: c.last_name || '',
    title: c.title || 'Owner',
    email: c.email || '',
    phone: c.phone || '',
    linkedin_url: '',
    organization_name: c.organization_name,
    website: c.website || '',
    industry: 'construction',
    employees: '',
    city: c.city || '',
    state: c.state || state,
    rating: c.rating || null,
    reviews: c.reviews || null,
    source: c.source || 'scrape',
    license_number: c.license_number || ''
  }));
  
  // Filter: must have company name, ideally have phone or website
  const valid = normalized.filter(p => 
    p.organization_name && 
    p.organization_name.length > 2 &&
    (p.phone || p.website || p.email)
  );
  
  console.log('[Scraper] ' + valid.length + ' valid after filtering');
  return valid;
}

module.exports = { scrapeProspects, extractContactFromWebsite, CA_CITIES, TX_CITIES, FL_CITIES };
