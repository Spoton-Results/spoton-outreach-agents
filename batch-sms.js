#!/usr/bin/env node
/**
 * SpotOn Results — Batch SMS Outreach
 * ------------------------------------
 * ONE-TIME manual trigger on Railway.
 * Pages through ALL GHL contacts and sends merchant services
 * cold SMS to every contact with a phone number that hasn't
 * already been contacted (no `outreach-sms-sent` tag).
 *
 * Rate: ~1 SMS/second — 10k contacts takes ~3 hours
 *
 * Required env vars (Railway shared env):
 *   GHL_API_KEY, GHL_LOCATION_ID
 *
 * Optional:
 *   SMS_BATCH_SIZE   contacts per GHL page (default 100)
 *   SMS_DELAY_MS     ms between sends (default 1100)
 *   DRY_RUN          set to "true" to log without sending
 */

require('dotenv').config({ path: './config/.env' });
const axios = require('axios');

const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'oe1TpmlDynQGFNdYLkaK';
const BATCH_SIZE      = parseInt(process.env.SMS_BATCH_SIZE || '100');
const DELAY_MS        = parseInt(process.env.SMS_DELAY_MS   || '1100');
const DRY_RUN         = process.env.DRY_RUN === 'true';
const SKIP_TAG        = 'outreach-sms-sent';
const SENT_TAG        = 'outreach-sms-sent';

if (!GHL_API_KEY) { console.error('Missing GHL_API_KEY'); process.exit(1); }

const ghl = axios.create({
  baseURL: 'https://services.leadconnectorhq.com',
  headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' },
  timeout: 15000
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg)  { console.log(`[${new Date().toISOString()}] ${msg}`); }

function buildSMS(contact) {
  const biz = contact.companyName || '';
  if (biz && biz.toLowerCase() !== 'business owner') {
    return `${biz} — quick question. Are you happy with your card processing rates? Most businesses save $400+/mo after switching. Worth 5 min? Reply YES -Shawn`;
  }
  return `Hey — quick question. Are you happy with your card processing rates? Most small businesses save $400+/mo after switching. Worth 5 min? Reply YES -Shawn`;
}

async function sendSMS(contact, message) {
  if (DRY_RUN) { log(`[DRY RUN] Would SMS ${contact.phone} -> ${contact.companyName || contact.id}`); return true; }
  const resp = await ghl.post('/conversations/messages', {
    type: 'SMS', contactId: contact.id, locationId: GHL_LOCATION_ID, message
  });
  return resp.status === 200 || resp.status === 201;
}

async function tagContact(contactId, tag) {
  try { await ghl.post(`/contacts/${contactId}/tags`, { tags: [tag] }); }
  catch (err) { log(`  WARN: Could not tag ${contactId}: ${err.message}`); }
}

function alreadySent(contact) { return (contact.tags || []).includes(SKIP_TAG); }

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
    log(`  Fetched page ${page} (${fetched}/${total})`);
    if (fetched >= total || contacts.length < BATCH_SIZE) break;
    page++;
    await sleep(300);
  }
}

async function main() {
  log('===================================================');
  log(' SpotOn Results — Batch SMS Outreach');
  log(` DRY_RUN: ${DRY_RUN} | Delay: ${DELAY_MS}ms`);
  log('===================================================');
  let sent = 0, skipped = 0, noPhone = 0, failed = 0, total = 0;
  for await (const contact of getAllContacts()) {
    total++;
    if (alreadySent(contact)) { skipped++; continue; }
    const phone = contact.phone;
    if (!phone || phone.replace(/\D/g, '').length < 10) { noPhone++; continue; }
    try {
      const ok = await sendSMS(contact, buildSMS(contact));
      if (ok) {
        await tagContact(contact.id, SENT_TAG);
        sent++;
        if (sent % 50 === 0) log(`SUCCESS ${sent} sent | ${skipped} skipped | ${failed} failed | ${total} total`);
      } else { log(`  WARN: bad response for ${contact.id}`); failed++; }
    } catch (err) {
      log(`  ERROR (${contact.companyName || contact.id}): ${err.response?.data?.message || err.message}`);
      failed++;
    }
    await sleep(DELAY_MS);
  }
  log(`\nDONE — sent:${sent} skipped:${skipped} noPhone:${noPhone} errors:${failed}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
