/**
 * Agent 00: Web Intelligence Scraper
 * 
 * Give it any URL and it extracts every GC contact on the page.
 * Handles directories, databases, association lists, permit sites,
 * paginated results, and multi-page crawls.
 * 
 * Sources it works on:
 * - Contractor directories (BuildZoom, Contractors.com, etc.)
 * - State licensing boards (CSLB, DBPR, TDLR, etc.)
 * - Association membership pages (AGC, NAHB chapters, etc.)
 * - Chamber of commerce directories
 * - BBB listings
 * - Permit databases
 * - Any page with a list of contractor company names/phones/emails
 * 
 * Usage:
 *   node agents/00-web-scraper.js https://example.com/contractors
 *   or via dashboard URL input
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, logRun, notifyDashboard } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are a web scraping intelligence agent for SubDraw, a construction draw management SaaS.
Extract General Contractor business information from web page content.
Focus on: company names, owner/contact names, phone numbers, emails, websites, city, state, license numbers.
Return JSON only. Never invent data — only extract what is explicitly on the page.`;

async function fetchPage(url, options = {}) {
  const fetch = (await import('node-fetch')).default;
  
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
  };

  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + url);
  return res.text();
}

function cleanHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractChunks(text, chunkSize = 6000) {
  // Split into overlapping chunks so contacts near boundaries aren't missed
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize - 500) {
    chunks.push(text.substring(i, i + chunkSize));
    if (i + chunkSize >= text.length) break;
  }
  return chunks;
}

function detectPagination(html, baseUrl) {
  // Detect common pagination patterns
  const patterns = [
    /href="([^"]*[?&]page=(\d+)[^"]*)"/gi,
    /href="([^"]*[?&]p=(\d+)[^"]*)"/gi,
    /href="([^"]*\/page\/(\d+)[^"]*)"/gi,
    /href="([^"]*[?&]offset=(\d+)[^"]*)"/gi,
  ];
  
  const pages = new Set();
  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(html)) !== null) {
      try {
        const fullUrl = new URL(m[1], baseUrl).toString();
        pages.add(fullUrl);
      } catch {}
    }
  }
  return [...pages].slice(0, 10); // Max 10 pages per crawl
}

async function extractContactsFromText(text, url) {
  const chunks = extractChunks(text);
  const allContacts = [];
  const seen = new Set();

  for (const chunk of chunks) {
    if (chunk.trim().length < 100) continue;

    const prompt = `Extract General Contractor business information from this web page content.
Source URL: ${url}

Page content:
${chunk}

Extract every GC company/contractor you can find. For each one return:
{
  "organization_name": "company name",
  "name": "owner/contact name if found",
  "first_name": "first name",
  "last_name": "last name", 
  "title": "Owner/President/etc",
  "email": "email if found or null",
  "phone": "phone number if found or null",
  "website": "website if found or null",
  "city": "city if found",
  "state": "state abbreviation",
  "license_number": "contractor license # if found or null",
  "rating": "rating/stars if found or null",
  "reviews": "review count if found or null"
}

Return a JSON array. If no GC contacts found, return [].
Only include real General Contractors — skip plumbers, electricians, roofers unless they also do general contracting.`;

    try {
      const result = JSON.parse(await callClaude(SYSTEM, prompt));
      const contacts = Array.isArray(result) ? result : [];
      
      for (const c of contacts) {
        if (!c.organization_name) continue;
        const key = c.organization_name.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (key.length > 2 && !seen.has(key)) {
          seen.add(key);
          allContacts.push({
            ...c,
            source: 'web_scrape',
            source_url: url
          });
        }
      }
    } catch(e) {
      console.log('[Agent 00] Parse error on chunk:', e.message);
    }
  }

  return allContacts;
}

async function pushToGHL(contacts) {
  const locId = process.env.GHL_LOCATION_ID;
  const pipId = process.env.GHL_PIPELINE_ID;
  const coldId = process.env.GHL_STAGE_COLD;
  const pushed = [];

  for (const c of contacts) {
    try {
      const res = await callGHL('POST', '/contacts/', {
        locationId: locId,
        firstName: c.first_name || c.name?.split(' ')[0] || '',
        lastName: c.last_name || c.name?.split(' ').slice(1).join(' ') || '',
        name: c.name || c.organization_name,
        companyName: c.organization_name,
        email: c.email || '',
        phone: c.phone || '',
        website: c.website || '',
        city: c.city || '',
        state: c.state || '',
        source: 'Web Scraper — ' + (c.source_url || '').substring(0, 60),
        tags: ['agent-outreach', 'gc-prospect', 'web-scrape', 'cold-outreach',
               c.state === 'CA' ? 'ca-gc' : c.state === 'UT' ? 'ut-gc' : 'gc-prospect'],
        customFields: [
          { key: 'license_number', field_value: c.license_number || '' },
          { key: 'scrape_source', field_value: c.source_url || '' },
          { key: 'csv_rating', field_value: String(c.rating || '') },
          { key: 'csv_reviews', field_value: String(c.reviews || '') }
        ].filter(f => f.field_value)
      });

      if (res.contact?.id) {
        // Add to pipeline
        await callGHL('POST', '/opportunities/', {
          pipelineId: pipId,
          pipelineStageId: coldId,
          contactId: res.contact.id,
          name: c.organization_name + ' — SubDraw Outreach',
          status: 'open',
          source: 'Web Scraper'
        }).catch(() => {});
        
        pushed.push(c);
      }
    } catch(e) {
      // Skip duplicate contacts silently
      if (!e.message.includes('409') && !e.message.includes('duplicate')) {
        console.log('[Agent 00] GHL push failed for', c.organization_name, ':', e.message);
      }
    }
  }

  return pushed;
}

async function scrapeUrl(url, options = {}) {
  const { maxPages = 5, pushToGhlEnabled = true } = options;
  
  console.log('\n[Agent 00] Scraping:', url);
  
  const allContacts = [];
  const seen = new Set();
  const visitedUrls = new Set([url]);

  const processUrl = async (pageUrl) => {
    try {
      console.log('[Agent 00] Fetching:', pageUrl);
      const html = await fetchPage(pageUrl);
      const text = cleanHtml(html);
      
      console.log('[Agent 00] Page text length:', text.length);
      
      const contacts = await extractContactsFromText(text, pageUrl);
      console.log('[Agent 00] Extracted', contacts.length, 'contacts from this page');

      for (const c of contacts) {
        const key = c.organization_name.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!seen.has(key)) {
          seen.add(key);
          allContacts.push(c);
        }
      }

      // Detect and return pagination URLs
      if (visitedUrls.size < maxPages) {
        const nextPages = detectPagination(html, pageUrl)
          .filter(p => !visitedUrls.has(p));
        return nextPages;
      }
      return [];
    } catch(e) {
      console.log('[Agent 00] Error fetching', pageUrl, ':', e.message);
      return [];
    }
  };

  // Process first page
  const nextPages = await processUrl(url);
  
  // Process paginated pages
  for (const nextUrl of nextPages.slice(0, maxPages - 1)) {
    if (visitedUrls.has(nextUrl)) continue;
    visitedUrls.add(nextUrl);
    await processUrl(nextUrl);
    await new Promise(r => setTimeout(r, 1000)); // Polite delay
  }

  console.log('\n[Agent 00] Total unique contacts found:', allContacts.length);
  console.log('[Agent 00] Pages scraped:', visitedUrls.size);

  // Push to GHL
  let pushed = [];
  if (pushToGhlEnabled && allContacts.length > 0) {
    console.log('[Agent 00] Pushing to GHL...');
    pushed = await pushToGHL(allContacts);
    console.log('[Agent 00] Pushed to GHL:', pushed.length);
  }

  const result = {
    url,
    pages_scraped: visitedUrls.size,
    contacts_found: allContacts.length,
    pushed_to_ghl: pushed.length,
    contacts: allContacts
  };

  logRun('00-web-scraper', result);
  
  if (pushed.length > 0) {
    await notifyDashboard('web_scrape', {
      url,
      found: allContacts.length,
      pushed: pushed.length
    });
  }

  return result;
}

module.exports = { scrapeUrl };

// CLI usage: node agents/00-web-scraper.js https://example.com
if (require.main === module) {
  const url = process.argv[2];
  if (!url) {
    console.log('Usage: node agents/00-web-scraper.js <url>');
    console.log('Example: node agents/00-web-scraper.js https://www.buildzoom.com/contractors/california');
    process.exit(1);
  }
  scrapeUrl(url, { maxPages: 5 })
    .then(r => {
      console.log('\n✅ Done');
      console.log('   Found:', r.contacts_found, 'contacts');
      console.log('   Pushed to GHL:', r.pushed_to_ghl);
      if (r.contacts.length > 0) {
        console.log('\nSample:');
        r.contacts.slice(0, 3).forEach(c => 
          console.log(' -', c.organization_name, '|', c.phone || 'no phone', '|', c.email || 'no email', '|', c.city + ', ' + c.state)
        );
      }
    })
    .catch(console.error);
}
