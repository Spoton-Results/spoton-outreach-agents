#!/usr/bin/env node
/**
 * SpotOn Results — Push GHL Contacts → Instantly Campaign
 * --------------------------------------------------------
 * ONE-TIME manual trigger on Railway.
 * Reads ALL GHL contacts that have an email address and have NOT
 * been tagged `outreach-email-queued`, then bulk-adds them to
 * the Instantly "SpotOn Merchant Services — Cold Outreach" campaign.
 *
 * Supports both GHL API v1 (rest.gohighlevel.com) and
 * v2 (services.leadconnectorhq.com) — auto-detects based on which works.
 *
 * Required env vars (all in Railway shared env):
 *   GHL_API_KEY, GHL_LOCATION_ID
 *   INSTANTLY_API_KEY     — Instantly.ai API key
 *   INSTANTLY_CAMPAIGN_ID — ID of the Instantly campaign to load into
 *
 * Optional:
 *   BATCH_SIZE   — contacts per GHL page (default 100)
 *   PUSH_SIZE    — Instantly bulk add size per call (default 100)
 *   DRY_RUN      — set to "true" to log without pushing
 *   GHL_VERSION  — force "v1" or "v2" (default: auto-detect)
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
const GHL_VERSION_OVERRIDE  = process.env.GHL_VERSION; // 'v1' or 'v2' or unset
const SKIP_TAG              = 'outreach-email-queued';
const SENT_TAG              = 'outreach-email-queued';

if (!GHL_API_KEY)       { console.error('FATAL: Missing GHL_API_KEY');       process.exit(1); }
if (!INSTANTLY_API_KEY) { console.error('FATAL: Missing INSTANTLY_API_KEY'); process.exit(1); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg)  { console.log(`[${new Date().toISOString()}] ${msg}`); }

function ghlError(err) {
  const status = err.response?.status;
  const data   = err.response?.data;
  return `HTTP ${status} — ${JSON.stringify(data)}`;
}

// ── GHL v2 client ─────────────────────────────────────────────────────────────

const ghlV2 = axios.create({
  baseURL: 'https://services.leadconnectorhq.com',
  headers: {
    'Authorization': `Bearer ${GHL_API_KEY}`,
    'Version':       '2021-07-28',
    'Content-Type':  'application/json'
  },
  timeout: 20000
});

// ── GHL v1 client ─────────────────────────────────────────────────────────────

const ghlV1 = axios.create({
  baseURL: 'https://rest.gohighlevel.com/v1',
  headers: {
    'Authorization': `Bearer ${GHL_API_KEY}`,
    'Content-Type':  'application/json'
  },
  timeout: 20000
});

// ── Auto-detect which GHL API version works ───────────────────────────────────

async function detectGHLVersion() {
  if (GHL_VERSION_OVERRIDE === 'v1') { log('GHL version forced: v1'); return 'v1'; }
  if (GHL_VERSION_OVERRIDE === 'v2') { log('GHL version forced: v2'); return 'v2'; }

  log('Auto-detecting GHL API version...');

  // Try v2 first
  try {
    const r = await ghlV2.get('/contacts/', {
      params: { locationId: GHL_LOCATION_ID, limit: 1, skip: 0 }
    });
    log(`  v2 OK — total contacts: ${r.data?.total}`);
    return 'v2';
  } catch (err) {
    log(`  v2 failed: ${ghlError(err)}`);
  }

  // Try v1
  try {
    const r = await ghlV1.get('/contacts/', { params: { limit: 1 } });
    log(`  v1 OK — total contacts: ${r.data?.meta?.total || r.data?.total}`);
    return 'v1';
  } catch (err) {
    log(`  v1 failed: ${ghlError(err)}`);
  }

  throw new Error('Both GHL API v1 and v2 failed. Check GHL_API_KEY.');
}

// ── Page through all GHL contacts (v2) ───────────────────────────────────────

async function* getAllContactsV2() {
  let page = 1;
  let total = 0;
  let fetched = 0;

  while (true) {
    const resp = await ghlV2.get('/contacts/', {
      params: {
        locationId: GHL_LOCATION_ID,
        limit:      BATCH_SIZE,
        skip:       (page - 1) * BATCH_SIZE
      }
    });

    const contacts = resp.data?.contacts || [];
    total = resp.data?.total || total;

    if (!contacts.length) break;

    for (const c of contacts) {
      yield c;
      fetched++;
    }

    log(`  Fetched v2 page ${page} (${fetched}/${total})`);
    if (fetched >= total || contacts.length < BATCH_SIZE) break;
    page++;
    await sleep(300);
  }
}

// ── Page through all GHL contacts (v1) ───────────────────────────────────────

async function* getAllContactsV1() {
  let startAfterId = null;
  let total = 0;
  let fetched = 0;
  let page = 1;

  while (true) {
    const params = { limit: BATCH_SIZE };
    if (startAfterId) params.startAfterId = startAfterId;

    const resp = await ghlV1.get('/contacts/', { params });
    const contacts = resp.data?.contacts || [];
    total = resp.data?.meta?.total || resp.data?.total || total;

    if (!contacts.length) break;

    for (const c of contacts) {
      yield c;
      fetched++;
    }

    log(`  Fetched v1 page ${page} (${fetched}/${total})`);

    // v1 uses cursor-based pagination
    const lastContact = contacts[contacts.length - 1];
    startAfterId = lastContact?.id || null;

    if (contacts.length < BATCH_SIZE) break;
    page++;
    await sleep(300);
  }
}

// ── Tag a contact in GHL ──────────────────────────────────────────────────────

async function tagContact(id, version) {
  try {
    if (version === 'v2') {
      await ghlV2.post(`/contacts/${id}/tags`, { tags: [SENT_TAG] });
    } else {
      // v1 uses PUT and 'tags' array directly
      await ghlV1.put(`/contacts/${id}/tags/`, { tags: [SENT_TAG] });
    }
  } catch (err) {
    log(`  WARN: Could not tag ${id}: ${ghlError(err)}`);
  }
}

async function tagContactsBatch(ids, version) {
  for (const id of ids) {
    await tagContact(id, version);
    await sleep(100);
  }
}

// ── Instantly bulk add ────────────────────────────────────────────────────────

const instantly = axios.create({
  baseURL: 'https://api.instantly.ai/api/v1',
  headers: { 'Content-Type': 'application/json' },
  timeout: 20000
});

async function pushToInstantly(leads) {
  if (DRY_RUN) {
    log(`[DRY RUN] Would push ${leads.length} leads`);
    return leads.length;
  }

  const resp = await instantly.post('/lead/add', {
    api_key:              INSTANTLY_API_KEY,
    campaign_id:          INSTANTLY_CAMPAIGN_ID,
    skip_if_in_workspace: true,
    leads: leads.map(l => ({
      email:        l.email,
      first_name:   l.firstName   || l.first_name  || 'there',
      last_name:    l.lastName    || l.last_name   || '',
      company_name: l.companyName || l.company     || '',
      phone:        l.phone       || '',
      custom_variables: {
        city:     l.city     || '',
        state:    l.state    || '',
        category: (l.tags || []).find(t =>
          t !== SKIP_TAG && t !== 'outreach-sms-sent' &&
          t !== 'yp-scrape' && t !== 'cold-outreach' &&
          !t.startsWith('merchant')
        ) || ''
      }
    }))
  });

  return resp.data?.leads_added ?? leads.length;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log('=======================================================');
  log(' SpotOn Results — Push GHL Contacts to Instantly');
  log(` Campaign ID : ${INSTANTLY_CAMPAIGN_ID}`);
  log(` Location ID : ${GHL_LOCATION_ID}`);
  log(` DRY_RUN     : ${DRY_RUN}`);
  log(` Push batch  : ${PUSH_SIZE}`);
  log('=======================================================\n');

  const version = await detectGHLVersion();
  log(`\nUsing GHL API ${version}\n`);

  const contactIterator = version === 'v2' ? getAllContactsV2() : getAllContactsV1();

  let buffer  = [];
  let pushed  = 0;
  let skipped = 0;
  let noEmail = 0;
  let total   = 0;

  for await (const contact of contactIterator) {
    total++;

    const tags = contact.tags || [];
    if (tags.includes(SKIP_TAG)) {
      skipped++;
      continue;
    }

    const email = contact.email;
    if (!email || !email.includes('@')) {
      noEmail++;
      continue;
    }

    buffer.push(contact);

    if (buffer.length >= PUSH_SIZE) {
      try {
        const added = await pushToInstantly(buffer);
        const ids   = buffer.map(c => c.id);
        await tagContactsBatch(ids, version);
        pushed += added;
        log(`✓ ${pushed} leads pushed to Instantly`);
      } catch (err) {
        log(`  ERROR batch push: ${ghlError(err) || err.message}`);
      }
      buffer = [];
      await sleep(500);
    }
  }

  // Flush remaining
  if (buffer.length > 0) {
    try {
      const added = await pushToInstantly(buffer);
      const ids   = buffer.map(c => c.id);
      await tagContactsBatch(ids, version);
      pushed += added;
    } catch (err) {
      log(`  ERROR final batch: ${err.message}`);
    }
  }

  log('\n=======================================================');
  log(` DONE`);
  log(` GHL version        : ${version}`);
  log(` Total contacts     : ${total}`);
  log(` Pushed to Instantly: ${pushed}`);
  log(` Already queued     : ${skipped} (skipped)`);
  log(` No email           : ${noEmail} (skipped)`);
  log('=======================================================');
}

main().catch(e => {
  const detail = e.response
    ? `HTTP ${e.response.status} — ${JSON.stringify(e.response.data)}`
    : e.message;
  console.error(`FATAL: ${detail}`);
  process.exit(1);
});
