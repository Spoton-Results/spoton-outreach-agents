/**
 * SubDraw SMS Blast — Smart Queue Sender
 * 
 * Sends to all gc-prospect contacts with phones.
 * Respects GHL rate limits, SMS daily cap, retries on 429/5xx.
 * Tags each contact sms-sent after success.
 * Skips DND, unsubscribed, already sent.
 * Logs every send/skip/fail to console for Railway visibility.
 * 
 * Usage:
 *   node scripts/sms-blast.js                    # dry run (default)
 *   node scripts/sms-blast.js --send             # live send
 *   node scripts/sms-blast.js --send --limit=100 # send first 100 only
 *   node scripts/sms-blast.js --send --tag=ca-gc # CA only
 *   node scripts/sms-blast.js --send --tag=ut-gc # UT only
 */

require('dotenv').config({ path: './config/.env' });

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ── CONFIG ──────────────────────────────────────────────────────────────────
const GHL_API_KEY   = process.env.GHL_API_KEY;
const GHL_LOCATION  = process.env.GHL_LOCATION_ID || 'oe1TpmlDynQGFNdYLkaK';
const FROM_NUMBER   = '+14352911877';

const SMS_MESSAGE   = (firstName) =>
  `Hey ${firstName || 'there'}, quick question — are your subs billing you accurately on every draw? Most GCs lose $8-15K per job without knowing it. Check it free: subdraw.com/login –Shawn`;

// Safety limits
const SMS_DAILY_CAP       = 1700; // hard stop — covers all 1,627 with buffer (account limit: 20,000/day)
const API_CALLS_PER_10S   = 80;   // under 100/10s limit
const DELAY_BETWEEN_MS    = 1200; // ~50/min — smooth carrier throughput
const MAX_RETRIES         = 3;
const RETRY_BACKOFF_MS    = 3000;

// Parse CLI args
const args = process.argv.slice(2);
const DRY_RUN  = !args.includes('--send');
const TAG_FILTER = (args.find(a => a.startsWith('--tag=')) || '').replace('--tag=', '') || 'gc-prospect';
const LIMIT    = parseInt((args.find(a => a.startsWith('--limit=')) || '').replace('--limit=', '') || '99999');

// ── STATE ────────────────────────────────────────────────────────────────────
let sentToday    = 0;
let skipped      = 0;
let failed       = 0;
let rateLimitHits = 0;
const failedContacts = [];

// ── GHL HELPER ───────────────────────────────────────────────────────────────
let rateLimitRemaining = 100;
let dailyRemaining     = 200000;

async function ghlRequest(method, endpoint, body = null, retries = 0) {
  const url = `https://services.leadconnectorhq.com${endpoint}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Content-Type': 'application/json',
      'Version': '2021-07-28'
    }
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);

  // Read rate limit headers
  const rl = res.headers.get('X-RateLimit-Remaining');
  const dl = res.headers.get('X-RateLimit-Daily-Remaining');
  if (rl) rateLimitRemaining = parseInt(rl);
  if (dl) dailyRemaining = parseInt(dl);

  if (res.status === 429) {
    rateLimitHits++;
    const retryAfter = parseInt(res.headers.get('Retry-After') || '10');
    log(`⚠️  Rate limited — waiting ${retryAfter}s (hit #${rateLimitHits})`);
    await sleep(retryAfter * 1000);
    if (retries < MAX_RETRIES) return ghlRequest(method, endpoint, body, retries + 1);
    throw new Error('Rate limit retries exhausted');
  }

  if (res.status >= 500) {
    if (retries < MAX_RETRIES) {
      log(`⚠️  Server error ${res.status} — retry ${retries + 1}/${MAX_RETRIES}`);
      await sleep(RETRY_BACKOFF_MS * (retries + 1));
      return ghlRequest(method, endpoint, body, retries + 1);
    }
    throw new Error(`GHL ${res.status}`);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL ${res.status}: ${text.substring(0, 200)}`);
  }

  return res.json();
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(msg) {
  const ts = new Date().toISOString().substring(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function logStats() {
  log(`📊 Stats: sent=${sentToday} skipped=${skipped} failed=${failed} rateLimitHits=${rateLimitHits} API-remaining=${rateLimitRemaining} daily-remaining=${dailyRemaining}`);
}

// ── FETCH ALL CONTACTS BY TAG ─────────────────────────────────────────────────
async function fetchAllContacts(tag) {
  const contacts = [];
  let startAfter = null;
  let startAfterId = null;
  let page = 1;

  log(`📋 Fetching all contacts with tag: ${tag}`);

  while (true) {
    let url = `/contacts/?locationId=${GHL_LOCATION}&query=${encodeURIComponent(tag)}&limit=100`;
    if (startAfter)   url += `&startAfter=${startAfter}`;
    if (startAfterId) url += `&startAfterId=${startAfterId}`;

    const data = await ghlRequest('GET', url);
    const batch = data.contacts || [];
    contacts.push(...batch);

    log(`  Page ${page}: ${batch.length} contacts (total so far: ${contacts.length} / ${data.meta?.total || '?'})`);

    if (!data.meta?.nextPage || batch.length < 100) break;
    startAfter   = data.meta.startAfter;
    startAfterId = data.meta.startAfterId;
    page++;
    await sleep(500); // be gentle on pagination
  }

  log(`✅ Fetched ${contacts.length} total contacts`);
  return contacts;
}

// ── SEND SMS TO ONE CONTACT ───────────────────────────────────────────────────
async function sendSMS(contact) {
  const firstName = contact.firstNameRaw || contact.firstName || 'there';
  const phone     = contact.phone;
  const message   = SMS_MESSAGE(firstName);

  if (DRY_RUN) {
    log(`[DRY RUN] → ${firstName} (${contact.companyName || ''}) ${phone} — "${message.substring(0, 60)}..."`);
    return true;
  }

  // Send via GHL conversations API
  await ghlRequest('POST', '/conversations/messages', {
    type: 'SMS',
    contactId: contact.id,
    fromNumber: FROM_NUMBER,
    toNumber: phone,
    message
  });

  // Tag as sms-sent so we never double-send
  await ghlRequest('POST', `/contacts/${contact.id}/tags`, {
    tags: ['sms-sent', 'sms-blast-2026-06-22']
  });

  return true;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!GHL_API_KEY) {
    console.error('❌ GHL_API_KEY not set');
    process.exit(1);
  }

  console.log('\n' + '═'.repeat(60));
  console.log('  SubDraw SMS Blast');
  console.log(`  Mode: ${DRY_RUN ? '🔍 DRY RUN (no SMS sent)' : '🚀 LIVE SEND'}`);
  console.log(`  Tag filter: ${TAG_FILTER}`);
  console.log(`  Daily cap: ${SMS_DAILY_CAP}`);
  console.log(`  Limit: ${LIMIT}`);
  console.log(`  From: ${FROM_NUMBER}`);
  console.log('═'.repeat(60) + '\n');

  if (!DRY_RUN) {
    log('⏳ Starting in 5 seconds — Ctrl+C to abort...');
    await sleep(5000);
  }

  // Fetch all contacts
  const all = await fetchAllContacts(TAG_FILTER);

  // Filter eligible contacts
  const SKIP_TAGS = ['sms-sent', 'unsubscribed', 'sms-unsubscribed', 'do-not-contact'];
  const eligible = all.filter(c => {
    if (!c.phone) { skipped++; return false; }
    if (c.dnd)    { skipped++; return false; }
    const tags = c.tags || [];
    if (SKIP_TAGS.some(t => tags.includes(t))) { skipped++; return false; }
    return true;
  }).slice(0, LIMIT);

  log(`\n📱 Eligible to receive SMS: ${eligible.length} (skipped ${skipped} ineligible)`);
  log(`   Will send up to: ${Math.min(eligible.length, SMS_DAILY_CAP)} today (cap: ${SMS_DAILY_CAP})\n`);

  if (!DRY_RUN && eligible.length === 0) {
    log('Nothing to send. Exiting.');
    return;
  }

  // Send loop
  for (let i = 0; i < eligible.length; i++) {
    const contact = eligible[i];

    // Hard stop at daily SMS cap
    if (sentToday >= SMS_DAILY_CAP) {
      log(`\n🛑 Daily SMS cap hit (${SMS_DAILY_CAP}). Stopping.`);
      log(`   Remaining contacts will be sent tomorrow after ramp unlocks.`);
      log(`   Resume with: node scripts/sms-blast.js --send --tag=${TAG_FILTER}`);
      break;
    }

    // Throttle if API rate limit is getting low
    if (rateLimitRemaining < 20) {
      log(`⏸  API rate limit low (${rateLimitRemaining} remaining) — pausing 12s`);
      await sleep(12000);
    }

    const name = contact.firstNameRaw || contact.firstName || 'unknown';
    const company = contact.companyName || '';

    try {
      await sendSMS(contact);
      sentToday++;
      log(`✅ [${sentToday}/${Math.min(eligible.length, SMS_DAILY_CAP)}] ${name} · ${company} · ${contact.phone}`);
    } catch (e) {
      failed++;
      failedContacts.push({ id: contact.id, name, company, error: e.message });
      log(`❌ FAILED: ${name} · ${company} — ${e.message}`);
    }

    // Log stats every 25 sends
    if (sentToday > 0 && sentToday % 25 === 0) {
      logStats();
    }

    // Delay between sends
    await sleep(DELAY_BETWEEN_MS);
  }

  // Final report
  console.log('\n' + '═'.repeat(60));
  console.log('  BLAST COMPLETE');
  console.log('═'.repeat(60));
  log(`✅ Sent:    ${sentToday}`);
  log(`⏭  Skipped: ${skipped}`);
  log(`❌ Failed:  ${failed}`);
  log(`🔁 Rate limit hits: ${rateLimitHits}`);
  if (DRY_RUN) log('\n⚠️  DRY RUN — no SMS were actually sent. Run with --send to go live.');
  if (failedContacts.length) {
    log('\nFailed contacts:');
    failedContacts.forEach(f => log(`  ${f.name} (${f.company}) — ${f.error}`));
  }
  console.log('═'.repeat(60) + '\n');
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
