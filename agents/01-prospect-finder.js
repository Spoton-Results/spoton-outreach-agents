/**
 * Agent 01: Prospect Finder — OpenAI Web Search Orchestrator
 * 
 * Uses gpt-4o-mini + web search to continuously find GC contacts.
 * Runs every 5 minutes, rotates through cities and states.
 * Cost: ~$0.002 per run = $17/month for 24/7 operation.
 */
require('dotenv').config({ path: './config/.env' });
const { callGHL, logRun, notifyDashboard } = require('../utils/helpers');

const STATES = [
  { state: 'California', code: 'CA', cities: ['Los Angeles','San Diego','San Jose','San Francisco','Sacramento','Fresno','Long Beach','Oakland','Anaheim','Riverside','Stockton','Irvine','Modesto','Bakersfield'], campaign: process.env.INSTANTLY_CA_CAMPAIGN_ID || process.env.INSTANTLY_CAMPAIGN_ID },
  { state: 'Utah', code: 'UT', cities: ['Salt Lake City','Provo','Ogden','St George','Lehi','Sandy','Orem','West Jordan','Murray','Draper'], campaign: process.env.INSTANTLY_UT_CAMPAIGN_ID },
  { state: 'Texas', code: 'TX', cities: ['Houston','Dallas','Austin','San Antonio','Fort Worth','Arlington','Plano','Lubbock','El Paso','Corpus Christi'], campaign: process.env.INSTANTLY_TX_CAMPAIGN_ID },
  { state: 'Florida', code: 'FL', cities: ['Miami','Orlando','Tampa','Jacksonville','Fort Lauderdale','St Petersburg','Cape Coral','Tallahassee','Hialeah','Port St Lucie'], campaign: process.env.INSTANTLY_FL_CAMPAIGN_ID },
  { state: 'Arizona', code: 'AZ', cities: ['Phoenix','Tucson','Mesa','Chandler','Scottsdale','Glendale','Gilbert','Tempe','Peoria','Surprise'], campaign: process.env.INSTANTLY_AZ_CAMPAIGN_ID },
];

const SEARCH_TEMPLATES = [
  'general contractor {city} {state} owner email contact',
  'custom home builder {city} {state} president phone email',
  'commercial contractor {city} {state} CEO contact information',
  'residential GC {city} {state} owner website email',
  'construction company {city} {state} general contractor subcontractors',
  'site:buildzoom.com general contractor {city} {state}',
  'site:houzz.com general contractor {city} {state} contact',
  '"general contractor" "{city}" "{state}" email phone owner',
];

let stateIndex = 0;
let cityIndexes = {};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function searchWithOpenAI(query) {
  const fetch = (await import('node-fetch')).default;
  
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      tools: [{ type: 'web_search_preview' }],
      input: `Search for general contractor businesses: ${query}
      
Extract every GC company you find. Return ONLY a JSON array:
[{
  "organization_name": "company name",
  "first_name": "owner first name if found",
  "last_name": "owner last name if found",
  "email": "email address if found or null",
  "phone": "phone number if found or null", 
  "website": "website URL if found or null",
  "city": "city",
  "state": "2-letter state code",
  "source_url": "where you found this"
}]

Only include actual General Contractors who manage subcontractors.
Skip: electricians, plumbers, roofers, HVAC, landscapers, solar.
Return [] if none found. JSON only, no markdown.`
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error('OpenAI ' + response.status + ': ' + err.substring(0, 200));
  }

  const data = await response.json();
  
  // Extract text from response
  const text = data.output
    ?.filter(o => o.type === 'message')
    ?.flatMap(o => o.content)
    ?.filter(c => c.type === 'output_text')
    ?.map(c => c.text)
    ?.join('') || '[]';

  const clean = text.replace(/```json|```/g, '').trim();
  const contacts = JSON.parse(clean);
  return Array.isArray(contacts) ? contacts : [];
}

async function getExistingGHLEmails() {
  try {
    const locId = process.env.GHL_LOCATION_ID;
    const existing = new Set();
    for (const tag of ['ca-gc', 'ut-gc', 'gc-prospect']) {
      const r = await callGHL('GET', `/contacts/?locationId=${locId}&query=${tag}&limit=100`);
      (r.contacts || []).forEach(c => {
        if (c.email) existing.add(c.email.toLowerCase());
        if (c.companyName) existing.add(c.companyName.toLowerCase().replace(/[^a-z0-9]/g,''));
      });
    }
    return existing;
  } catch(e) {
    return new Set();
  }
}

async function pushToGHL(contact, stateCode) {
  const locId = process.env.GHL_LOCATION_ID;
  const pipId = process.env.GHL_PIPELINE_ID;
  const coldId = process.env.GHL_STAGE_COLD;

  const tag = stateCode === 'CA' ? 'ca-gc' : stateCode === 'UT' ? 'ut-gc' : 'gc-prospect';

  const payload = {
    locationId: locId,
    source: 'OpenAI Prospector',
    tags: ['agent-outreach', 'gc-prospect', tag, 'cold-outreach', 'ai-prospected']
  };

  if (contact.first_name) payload.firstName = contact.first_name;
  if (contact.last_name)  payload.lastName  = contact.last_name;
  if (contact.email)      payload.email      = contact.email;
  if (contact.phone)      payload.phone      = contact.phone;
  if (contact.organization_name) payload.companyName = contact.organization_name;
  if (contact.website)    payload.website    = contact.website;
  if (contact.city)       payload.city       = contact.city;
  if (contact.state)      payload.state      = contact.state || stateCode;

  const res = await callGHL('POST', '/contacts/', payload);
  const contactId = res.contact?.id;

  if (contactId && pipId && coldId) {
    await callGHL('POST', '/opportunities/', {
      pipelineId: pipId,
      pipelineStageId: coldId,
      contactId,
      name: contact.organization_name + ' — SubDraw Outreach',
      status: 'open'
    }).catch(() => {});
  }

  return contactId;
}

async function pushToInstantly(contact, campaignId) {
  if (!contact.email || !campaignId) return false;
  const fetch = (await import('node-fetch')).default;
  const r = await fetch('https://api.instantly.ai/api/v2/leads', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.INSTANTLY_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      campaign_id: campaignId,
      skip_if_in_workspace: true,
      email: contact.email,
      first_name: contact.first_name || '',
      last_name: contact.last_name || '',
      company_name: contact.organization_name || '',
      phone: contact.phone || '',
      city: contact.city || '',
      state: contact.state || '',
      variables: {
        company: contact.organization_name || '',
        city: contact.city || '',
        current_tool: 'spreadsheets',
        pain_point: 'invoice protection',
        demo_url: 'https://subdraw.com/login'
      }
    })
  });
  if (!r.ok) {
    const errBody = await r.text().catch(() => '');
    console.log('[Agent 01] Instantly push failed (' + r.status + ') for ' + contact.email + ':', errBody.substring(0, 200));
    return false;
  }
  return true;
}

async function findProspects(options = {}) {
  // Pick current state
  const activeStates = STATES.filter(s => s.campaign);
  if (!activeStates.length) {
    console.log('[Agent 01] No campaigns configured');
    return [];
  }

  const target = activeStates[stateIndex % activeStates.length];
  stateIndex++;

  // Pick next city in rotation for this state
  if (!cityIndexes[target.state]) cityIndexes[target.state] = 0;
  const city = target.cities[cityIndexes[target.state] % target.cities.length];
  cityIndexes[target.state]++;

  // Pick search template
  const template = SEARCH_TEMPLATES[Math.floor(Math.random() * SEARCH_TEMPLATES.length)];
  const query = template.replace('{city}', city).replace('{state}', target.state);

  console.log(`\n[Agent 01] Searching: ${query}`);

  // Get existing contacts to deduplicate
  const existing = await getExistingGHLEmails();

  // Search with OpenAI
  let contacts = [];
  try {
    contacts = await searchWithOpenAI(query);
    console.log(`[Agent 01] Found ${contacts.length} raw results`);
  } catch(e) {
    console.error('[Agent 01] OpenAI search failed:', e.message);
    return [];
  }

  // Deduplicate
  const fresh = contacts.filter(c => {
    if (!c.organization_name) return false;
    const emailKey = (c.email || '').toLowerCase();
    const nameKey = c.organization_name.toLowerCase().replace(/[^a-z0-9]/g,'');
    if (emailKey && existing.has(emailKey)) return false;
    if (existing.has(nameKey)) return false;
    existing.add(emailKey || nameKey);
    return true;
  });

  console.log(`[Agent 01] ${fresh.length} new contacts after dedup`);

  // Push to GHL + Instantly
  let pushed = 0;
  for (const contact of fresh) {
    try {
      const id = await pushToGHL(contact, target.code);
      if (id) {
        await pushToInstantly(contact, target.campaign);
        pushed++;
        console.log(`[Agent 01] ✓ ${contact.organization_name} — ${contact.email || 'no email'}`);
      }
    } catch(e) {
      if (!e.message.includes('duplicate') && !e.message.includes('400')) {
        console.log(`[Agent 01] Push failed for ${contact.organization_name}:`, e.message);
      }
    }
    await sleep(300);
  }

  const result = { state: target.state, city, query, found: contacts.length, pushed };
  logRun('01-prospect-finder', result);

  if (pushed > 0) {
    await notifyDashboard('prospect_found', { state: target.state, city, pushed, total: pushed });
  }

  return fresh;
}

module.exports = { findProspects };
