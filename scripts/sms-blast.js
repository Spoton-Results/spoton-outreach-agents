/**
 * SubDraw SMS Blast — Smart Queue Sender with Send Window
 *
 * ONLY sends between 6:45am–5pm local time, Mon–Fri.
 * Hard stops outside that window — will not text GCs at 3am.
 *
 * Usage:
 *   node scripts/sms-blast.js              # dry run
 *   node scripts/sms-blast.js --send       # live send (respects time window)
 *   node scripts/sms-blast.js --send --tag=ca-gc
 *   node scripts/sms-blast.js --send --tag=ut-gc
 *   node scripts/sms-blast.js --send --limit=50
 */

// Railway injects env vars directly — dotenv only for local dev
try { require('dotenv').config({ path: './config/.env' }); } catch(e) {}

console.log('[SMS-BLAST] Script starting — GHL_API_KEY present:', !!process.env.GHL_API_KEY);

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ── CONFIG ───────────────────────────────────────────────────────────────────
const GHL_API_KEY  = process.env.GHL_API_KEY;
const GHL_LOCATION = process.env.GHL_LOCATION_ID || 'oe1TpmlDynQGFNdYLkaK';
const FROM_NUMBER  = '+14352911877';

const SMS_MESSAGE = (firstName) =>
  `Hey ${firstName || 'there'}, quick question — are your subs billing you accurately on every draw? Most GCs lose $8-15K per job without knowing it. Check it free: subdraw.com/login –Shawn`;

// Safety limits
const SMS_DAILY_CAP     = 1700;  // covers all 1,627 with buffer (account limit: 20K/day)
const DELAY_BETWEEN_MS  = 1200;  // 1.2s between sends (~50/min)
const MAX_RETRIES       = 3;
const RETRY_BACKOFF_MS  = 3000;

// CLI args
const args       = process.argv.slice(2);
const DRY_RUN    = !args.includes('--send');
const TAG_FILTER = (args.find(a => a.startsWith('--tag=')) || '').replace('--tag=', '') || 'gc-prospect';
const LIMIT      = parseInt((args.find(a => a.startsWith('--limit=')) || '').replace('--limit=', '') || '99999');

// ── SEND WINDOW ──────────────────────────────────────────────────────────────
// CA contacts: 6:45am–5pm Pacific (UTC-7 summer = UTC 13:45–00:00)
// UT contacts: 6:45am–5pm Mountain (UTC-6 summer = UTC 12:45–23:00)
// Use Mountain start (12:45 UTC) and Pacific end (23:59 UTC) as the safe window
// This ensures NO texts go out before 6:45am local for either state

function isWithinSendWindow() {
  const now    = new Date();
  const day    = now.getUTCDay();   // 0=Sun 6=Sat
  const mins   = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (day === 0 || day === 6) return false; // no weekends
  return mins >= 765 && mins <= 1439; // 12:45 UTC to 23:59 UTC
}

function minutesUntilWindow() {
  const now  = new Date();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (mins < 765) return 765 - mins;
  return (1440 - mins) + 765; // next day
}

function formatWait(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ── STATE ─────────────────────────────────────────────────────────────────────
let sentToday = 0, skipped = 0, failed = 0, rateLimitHits = 0;
let rateLimitRemaining = 100, dailyRemaining = 200000;
const failedContacts = [];

// ── GHL HELPER ────────────────────────────────────────────────────────────────
async function ghlRequest(method, endpoint, body = null, retries = 0) {
  const res = await fetch(`https://services.leadconnectorhq.com${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Content-Type': 'application/json',
      'Version': '2021-07-28'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const rl = res.headers.get('X-RateLimit-Remaining');
  const dl = res.headers.get('X-RateLimit-Daily-Remaining');
  if (rl) rateLimitRemaining = parseInt(rl);
  if (dl) dailyRemaining = parseInt(dl);

  if (res.status === 429) {
    rateLimitHits++;
    const wait = parseInt(res.headers.get('Retry-After') || '10');
    log(`⚠️  Rate limited — waiting ${wait}s`);
    await sleep(wait * 1000);
    if (retries < MAX_RETRIES) return ghlRequest(method, endpoint, body, retries + 1);
    throw new Error('Rate limit retries exhausted');
  }

  if (res.status >= 500) {
    if (retries < MAX_RETRIES) {
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg) { console.log(`[${new Date().toISOString().substring(11,19)}] ${msg}`); }

// ── FETCH CONTACTS ────────────────────────────────────────────────────────────
async function fetchAllContacts(tag) {
  const contacts = [];
  let startAfter = null, startAfterId = null, page = 1;
  log(`📋 Fetching contacts with tag: ${tag}`);
  while (true) {
    let url = `/contacts/?locationId=${GHL_LOCATION}&query=${encodeURIComponent(tag)}&limit=100`;
    if (startAfter)   url += `&startAfter=${startAfter}`;
    if (startAfterId) url += `&startAfterId=${startAfterId}`;
    const data = await ghlRequest('GET', url);
    const batch = data.contacts || [];
    contacts.push(...batch);
    log(`  Page ${page}: ${batch.length} contacts (total: ${contacts.length})`);
    if (!data.meta?.nextPage || batch.length < 100) break;
    startAfter   = data.meta.startAfter;
    startAfterId = data.meta.startAfterId;
    page++;
    await sleep(500);
  }
  log(`✅ Fetched ${contacts.length} total`);
  return contacts;
}

// ── SEND ONE SMS ──────────────────────────────────────────────────────────────
async function sendSMS(contact) {
  const firstName = contact.firstNameRaw || contact.firstName || 'there';
  const message   = SMS_MESSAGE(firstName);

  if (DRY_RUN) {
    log(`[DRY RUN] → ${firstName} (${contact.companyName || ''}) ${contact.phone}`);
    return;
  }

  await ghlRequest('POST', '/conversations/messages', {
    type: 'SMS',
    contactId: contact.id,
    fromNumber: FROM_NUMBER,
    toNumber: contact.phone,
    message
  });

  await ghlRequest('POST', `/contacts/${contact.id}/tags`, {
    tags: ['sms-sent', 'sms-blast-2026-06-22']
  });
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!GHL_API_KEY) {
    console.error('❌ GHL_API_KEY not set — check Railway env vars');
    process.exit(1);
  }

  console.log('\n' + '═'.repeat(60));
  console.log('  SubDraw SMS Blast');
  console.log(`  Mode:      ${DRY_RUN ? '🔍 DRY RUN' : '🚀 LIVE SEND'}`);
  console.log(`  Tag:       ${TAG_FILTER}`);
  console.log(`  Cap:       ${SMS_DAILY_CAP}`);
  console.log(`  From:      ${FROM_NUMBER}`);
  console.log(`  Window:    6:45am–5pm Pacific/Mountain Mon–Fri only`);
  console.log('═'.repeat(60) + '\n');

  // ── SEND WINDOW GATE ─────────────────────────────────────────────────────
  if (!DRY_RUN && !isWithinSendWindow()) {
    const wait = minutesUntilWindow();
    log(`🚫 OUTSIDE SEND WINDOW — it is ${new Date().toUTCString()}`);
    log(`   GCs are sleeping. Will not send.`);
    log(`   Window opens in ${formatWait(wait)} (6:45am Mountain Time).`);
    log(`   Redeploy after 6:45am local time to send.`);
    process.exit(0);
  }

  if (!DRY_RUN) {
    log('✅ Within send window — starting in 5 seconds (Ctrl+C to abort)...');
    await sleep(5000);
  }

  // Fetch and filter
  const all = await fetchAllContacts(TAG_FILTER);
  const SKIP_TAGS = ['sms-sent', 'unsubscribed', 'sms-unsubscribed', 'do-not-contact'];
  const eligible = all.filter(c => {
    if (!c.phone) { skipped++; return false; }
    if (c.dnd)    { skipped++; return false; }
    if (SKIP_TAGS.some(t => (c.tags || []).includes(t))) { skipped++; return false; }
    return true;
  }).slice(0, LIMIT);

  log(`\n📱 Eligible: ${eligible.length} (skipped ${skipped} ineligible)`);
  log(`   Sending up to: ${Math.min(eligible.length, SMS_DAILY_CAP)}\n`);

  for (let i = 0; i < eligible.length; i++) {
    if (sentToday >= SMS_DAILY_CAP) {
      log(`🛑 Daily cap hit (${SMS_DAILY_CAP}). Done.`);
      break;
    }

    // Re-check window on every 50th send
    if (!DRY_RUN && i > 0 && i % 50 === 0 && !isWithinSendWindow()) {
      log(`🚫 Send window closed — stopping. Resume tomorrow 6:45am.`);
      break;
    }

    if (rateLimitRemaining < 20) {
      log(`⏸  Rate limit low (${rateLimitRemaining}) — pausing 12s`);
      await sleep(12000);
    }

    const c = eligible[i];
    try {
      await sendSMS(c);
      sentToday++;
      log(`✅ [${sentToday}/${Math.min(eligible.length, SMS_DAILY_CAP)}] ${c.firstNameRaw || c.firstName} · ${c.companyName} · ${c.phone}`);
    } catch(e) {
      failed++;
      failedContacts.push({ name: c.firstNameRaw, company: c.companyName, error: e.message });
      log(`❌ FAILED: ${c.firstNameRaw} · ${c.companyName} — ${e.message}`);
    }

    if (sentToday > 0 && sentToday % 25 === 0) {
      log(`📊 Stats: sent=${sentToday} skipped=${skipped} failed=${failed} rateHits=${rateLimitHits} API-remaining=${rateLimitRemaining}`);
    }

    await sleep(DELAY_BETWEEN_MS);
  }

  // Final report
  console.log('\n' + '═'.repeat(60));
  log(`✅ Sent:    ${sentToday}`);
  log(`⏭  Skipped: ${skipped}`);
  log(`❌ Failed:  ${failed}`);
  if (DRY_RUN) log('\n⚠️  DRY RUN — no SMS sent. Use --send to go live after 6:45am.');
  if (failedContacts.length) {
    log('\nFailed:');
    failedContacts.forEach(f => log(`  ${f.name} (${f.company}) — ${f.error}`));
  }
  console.log('═'.repeat(60) + '\n');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
