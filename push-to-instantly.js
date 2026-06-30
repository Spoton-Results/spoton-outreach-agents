#!/usr/bin/env node
/**
 * SpotOn Results — Push GHL Contacts to Instantly Campaign
 * ---------------------------------------------------------
 * ONE-TIME manual trigger on Railway.
 * Reads ALL GHL contacts with an email address that haven't been
 * tagged outreach-email-queued, bulk-adds them to the Instantly
 * "SpotOn Results — Merchant Services Cold Outreach" campaign.
 *
 * Required env vars (Railway shared env):
 *   GHL_API_KEY, GHL_LOCATION_ID, INSTANTLY_API_KEY
 *
 * Optional:
 *   INSTANTLY_CAMPAIGN_ID  (defaults to merchant services campaign)
 *   BATCH_SIZE             GHL page size (default 100)
 *   PUSH_SIZE              Instantly bulk add size (default 100)
 *   DRY_RUN                set to "true" to log without pushing
 */

require('dotenv').config({ path: './config/.env' });
const axios = require('axios');

const GHL_API_KEY           = process.env.GHL_API_KEY;
const GHL_LOCATION_ID       = process.env.GHL_LOCATION_ID || 'oe1TpmlDynQGFNdYLkaK';
const INSTANTLY_API_KEY     = process.env.INSTANTLY_API_KEY;
const INSTANTLY_CAMPAIGN_ID = process.env.INSTANTLY_CAMPAIGN_ID || '8b8d1159-ec1c-4982-944d-6dd0be563b50';
const BATCH_SIZE            = parseInt(process.env.BATCH_SIZE || '100');
const PUSH_SIZE             = parseInt(process.env.PUSH_SIZE  || '100');
const DRY_RUN               = process.env.DRY_RUN === 'true';
const SKIP_TAG              = 'outreach-email-queued';
const SENT_TAG              = 'outreach-email-queued';

if (!GHL_API_KEY)       { console.error('Missing GHL_API_KEY');       process.exit(1); }
if (!INSTANTLY_API_KEY) { console.error('Missing INSTANTLY_API_KEY'); process.exit(1); }

const ghl = axios.create({
  baseURL: 'https://services.leadconnectorhq.com',
  headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28', 'Content-Type': 'application/json' },
  timeout: 15000
});

const instantly = axios.create({
  baseURL: 'https://api.instantly.ai/api/v1',
  headers: { 'Content-Type': 'application/json' },
  timeout: 15000
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg)  { console.log(`[${new Date().toISOString()}] ${msg}`); }

function alreadyQueued(contact) { return (contact.tags || []).includes(SKIP_TAG); }

async function* getAllContacts() {
  let page = 1, total = 0, fetched = 0;
  while (true) {
    const resp = await ghl.get('/contacts/', {
      params: { locationId: GHL_LOCATION_ID, limit: BATCH_SIZE, skip: (page - 1) * BATCH_SIZE }
    });
    const contacts = resp.data?.contacts || [];
    total = resp.data?.total || total;
    if (!contacts.length) break;
    for (const c of contacts) { yield c; fetched++; }
    log(`  GHL page ${page} (${fetched}/${total})`);
    if (fetched >= total || contacts.length < BATCH_SIZE) break;
    page++;
    await sleep(300);
  }
}

async function pushToInstantly(leads) {
  if (DRY_RUN) { log(`[DRY RUN] Would push ${leads.length} leads`); return leads.length; }
  const resp = await instantly.post('/lead/add', {
    api_key: INSTANTLY_API_KEY,
    campaign_id: INSTANTLY_CAMPAIGN_ID,
    skip_if_in_workspace: true,
    leads: leads.map(l => ({
      email:        l.email,
      first_name:   l.firstName   || 'there',
      last_name:    l.lastName    || '',
      company_name: l.companyName || '',
      phone:        l.phone       || '',
      custom_variables: { city: l.city || '', state: l.state || '' }
    }))
  });
  return resp.data?.leads_added || leads.length;
}

async function tagContactsBatch(ids) {
  for (const id of ids) {
    try { await ghl.post(`/contacts/${id}/tags`, { tags: [SENT_TAG] }); await sleep(100); }
    catch (err) { log(`  WARN: tag failed ${id}: ${err.message}`); }
  }
}

async function main() {
  log('SpotOn Results — Push GHL Contacts to Instantly');
  log(`Campaign: ${INSTANTLY_CAMPAIGN_ID} | DRY_RUN: ${DRY_RUN}`);
  let buffer = [], pushed = 0, skipped = 0, noEmail = 0, total = 0;
  for await (const contact of getAllContacts()) {
    total++;
    if (alreadyQueued(contact)) { skipped++; continue; }
    if (!contact.email || !contact.email.includes('@')) { noEmail++; continue; }
    buffer.push(contact);
    if (buffer.length >= PUSH_SIZE) {
      try {
        pushed += await pushToInstantly(buffer);
        await tagContactsBatch(buffer.map(c => c.id));
        log(`pushed ${pushed} total`);
      } catch (err) { log(`ERROR: ${err.response?.data?.message || err.message}`); }
      buffer = [];
      await sleep(500);
    }
  }
  if (buffer.length) {
    try { pushed += await pushToInstantly(buffer); await tagContactsBatch(buffer.map(c => c.id)); }
    catch (err) { log(`ERROR final: ${err.message}`); }
  }
  log(`DONE pushed:${pushed} skipped:${skipped} noEmail:${noEmail} total:${total}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
