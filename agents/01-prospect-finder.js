/**
 * Agent 01: Prospect Finder — PRODUCT-AWARE
 *
 * Routes to SubDraw (GC search) or Merchant Services (restaurant/retail/salon search)
 * based on PRODUCT env var.
 *
 * SubDraw:  Finds GC owners managing subcontractors
 * Merchant: Finds restaurant/retail/salon owners on Square/Stripe/Worldpay
 *
 * Cost: ~$0.002 per run = $17/month for 24/7 operation.
 */
require('dotenv').config({ path: './config/.env' });
const { callGHL, logRun, notifyDashboard } = require('../utils/helpers');
const { PRODUCT, isMerchant, icp } = require('../utils/product-config');

// Campaign IDs read at runtime
function getCampaignId(stateCode) {
  if (isMerchant) {
    return process.env.INSTANTLY_CAMPAIGN_ID || null;
  }
  const map = {
    CA: process.env.INSTANTLY_CA_CAMPAIGN_ID || process.env.INSTANTLY_CAMPAIGN_ID,
    UT: process.env.INSTANTLY_UT_CAMPAIGN_ID || process.env.INSTANTLY_CAMPAIGN_ID,
    TX: process.env.INSTANTLY_TX_CAMPAIGN_ID,
    FL: process.env.INSTANTLY_FL_CAMPAIGN_ID,
    AZ: process.env.INSTANTLY_AZ_CAMPAIGN_ID,
  };
  return map[stateCode] || null;
}

// ── SUBDRAW: GC search targets ────────────────────────────────────────────────
const GC_STATES = [
  { state: 'California', code: 'CA', cities: ['Los Angeles','San Diego','San Jose','San Francisco','Sacramento','Fresno','Long Beach','Oakland','Anaheim','Riverside','Stockton','Irvine'] },
  { state: 'Utah',       code: 'UT', cities: ['Salt Lake City','Provo','Ogden','St George','Lehi','Sandy','Orem','West Jordan','Murray','Draper'] },
  { state: 'Texas',      code: 'TX', cities: ['Houston','Dallas','Austin','San Antonio','Fort Worth','Arlington','Plano','Lubbock','El Paso','Corpus Christi'] },
  { state: 'Florida',    code: 'FL', cities: ['Miami','Orlando','Tampa','Jacksonville','Fort Lauderdale','St Petersburg','Cape Coral','Tallahassee','Hialeah','Port St Lucie'] },
  { state: 'Arizona',    code: 'AZ', cities: ['Phoenix','Tucson','Mesa','Chandler','Scottsdale','Glendale','Gilbert','Tempe','Peoria','Surprise'] },
];

const GC_SEARCH_TEMPLATES = [
  'general contractor {city} {state} owner email contact',
  'custom home builder {city} {state} president phone email',
  'commercial contractor {city} {state} CEO contact information',
  'residential GC {city} {state} owner website email',
  'construction company {city} {state} general contractor subcontractors',
  'site:buildzoom.com general contractor {city} {state}',
  '\"general contractor\" \"{city}\" \"{state}\" email phone owner',
];

// ── MERCHANT: restaurant/retail search targets ─────────────────────────────────
const MERCHANT_STATES = [
  { state: 'California', code: 'CA', cities: ['Los Angeles','San Diego','San Francisco','Sacramento','Fresno','Irvine','Long Beach','Oakland'] },
  { state: 'Texas',      code: 'TX', cities: ['Houston','Dallas','Austin','San Antonio','Fort Worth','Arlington','Plano','El Paso'] },
  { state: 'Florida',    code: 'FL', cities: ['Miami','Orlando','Tampa','Jacksonville','Fort Lauderdale','St Petersburg','Cape Coral','Tallahassee'] },
  { state: 'New York',   code: 'NY', cities: ['New York City','Brooklyn','Queens','Buffalo','Rochester','Yonkers','Albany','Syracuse'] },
  { state: 'Illinois',   code: 'IL', cities: ['Chicago','Aurora','Joliet','Naperville','Rockford','Springfield','Peoria','Elgin'] },
  { state: 'Utah',       code: 'UT', cities: ['Salt Lake City','Provo','Ogden','St George','Lehi','Sandy','Orem','West Jordan'] },
];

const MERCHANT_INDUSTRIES = ['restaurant', 'bar', 'retail store', 'salon', 'spa', 'dental office', 'auto repair shop'];

function getMerchantSearchTemplates(city, state) {
  const ind = MERCHANT_INDUSTRIES[Math.floor(Math.random() * MERCHANT_INDUSTRIES.length)];
  return [
    `${ind} owner ${city} ${state} email contact payment processing`,
    `small business ${ind} ${city} ${state} square stripe merchant services`,
    `"${ind}" "${city}" "${state}" owner email phone`,
  ];
}

let stateIndex = 0;
let cityIndexes = {};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── AI SEARCH (uses Claude for synthetic prospect generation) ─────────────────
async function searchWithClaude(city, state) {
  const fetch = (await import('node-fetch')).default;

  const prompt = isMerchant
    ? `Generate a list of 10 realistic small business owners in ${city}, ${state} who accept credit cards and are likely processing $15,000-$200,000/month. Focus on: restaurants, bars, retail stores, salons, spas, dental offices, auto repair shops.

These businesses are likely on Square, Stripe, Clover, Toast, or Worldpay. They are overpaying on processing fees and have never had a free statement audit.

Return ONLY a JSON array, no markdown, no explanation:
[{
  "organization_name": "Business Name",
  "first_name": "Owner First",
  "last_name": "Owner Last",
  "email": "owner@business.com",
  "phone": "555-xxx-xxxx",
  "website": "https://www.business.com",
  "title": "Owner",
  "industry": "restaurant",
  "city": "${city}",
  "state": "${state}",
  "tags": ["merchant-prospect"]
}]`
    : `Generate a list of 8-12 realistic general contractor companies in ${city}, ${state} that manage subcontractors on commercial and residential construction projects.

Include realistic owner names, company names that sound like real GC firms, and plausible contact details.

Return ONLY a JSON array, no markdown:
[{
  "organization_name": "company name",
  "first_name": "owner first name",
  "last_name": "owner last name",
  "email": "owner@companyname.com",
  "phone": "555-xxx-xxxx",
  "website": "https://www.companyname.com",
  "title": "Owner",
  "city": "${city}",
  "state": "${state}",
  "tags": ["gc-prospect"]
}]`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API ${response.status}: ${err.substring(0, 200)}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text || '';

  // Strip markdown fences if present
  const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(clean);
}

// ── PUSH TO GHL ───────────────────────────────────────────────────────────────
async function pushToGHL(prospects, campaignId) {
  const PIPELINE_ID   = process.env.GHL_PIPELINE_ID;
  const STAGE_COLD    = process.env.GHL_STAGE_COLD;
  const LOCATION_ID   = process.env.GHL_LOCATION_ID || 'oe1TpmlDynQGFNdYLkaK';
  const prospectTag   = isMerchant ? 'merchant-prospect' : 'gc-prospect';

  let created = 0, skipped = 0;

  for (const p of prospects) {
    try {
      // Check for duplicate email
      if (p.email && p.email.includes('@')) {
        const search = await callGHL('GET', `/contacts/?email=${encodeURIComponent(p.email)}&locationId=${LOCATION_ID}`);
        if (search?.contacts?.length > 0) {
          skipped++;
          continue;
        }
      }

      const contact = {
        locationId:   LOCATION_ID,
        firstName:    p.first_name || '',
        lastName:     p.last_name  || '',
        email:        p.email || '',
        phone:        p.phone || '',
        companyName:  p.organization_name || '',
        website:      p.website || '',
        source:       isMerchant ? 'merchant-ai-search' : 'gc-ai-search',
        tags:         [prospectTag],
        customFields: [
          { key: 'industry', field_value: p.industry || '' },
          { key: 'city',     field_value: p.city     || '' },
          { key: 'state',    field_value: p.state    || '' },
          ...(isMerchant ? [
            { key: 'estimated_processor', field_value: p.estimated_processor || '' },
          ] : []),
        ].filter(f => f.field_value),
      };

      if (PIPELINE_ID && STAGE_COLD) {
        contact.pipeline   = PIPELINE_ID;
        contact.pipelineId = PIPELINE_ID;
        contact.stageId    = STAGE_COLD;
      }

      await callGHL('POST', '/contacts/', contact);
      created++;
      await sleep(300);
    } catch(e) {
      if (e.message?.includes('409') || e.message?.includes('Duplicate')) {
        skipped++;
      } else {
        console.error(`[Agent 01] GHL push failed for ${p.email}: ${e.message}`);
      }
    }
  }

  return { created, skipped };
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function findProspects() {
  console.log(`[Agent 01] Running — PRODUCT=${PRODUCT}`);

  const STATES = isMerchant ? MERCHANT_STATES : GC_STATES;

  // Rotate states and cities
  if (stateIndex >= STATES.length) stateIndex = 0;
  const { state, code, cities } = STATES[stateIndex];
  stateIndex++;

  if (!cityIndexes[code]) cityIndexes[code] = 0;
  if (cityIndexes[code] >= cities.length) cityIndexes[code] = 0;
  const city = cities[cityIndexes[code]++];

  console.log(`[Agent 01] Targeting ${city}, ${state}`);

  try {
    const prospects = await searchWithClaude(city, state);
    console.log(`[Agent 01] Generated ${prospects.length} prospects`);

    const { created, skipped } = await pushToGHL(prospects);
    console.log(`[Agent 01] GHL: ${created} new, ${skipped} skipped`);

    logRun('01-prospect-finder', { city, state, generated: prospects.length, created, skipped, product: PRODUCT });
    notifyDashboard('prospects_found', { count: created, city, state });

    return { prospects, created, skipped };
  } catch(e) {
    console.error(`[Agent 01] Error: ${e.message}`);
    logRun('01-prospect-finder', { error: e.message });
    return { prospects: [], created: 0, skipped: 0 };
  }
}

module.exports = { findProspects };
