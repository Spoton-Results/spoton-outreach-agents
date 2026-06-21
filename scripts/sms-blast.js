/**
 * SubDraw SMS Blast — Smart Queue Sender
 *
 * Fixes:
 * 1. Time window gate — only sends 6:45am-5pm local Mon-Fri
 * 2. Pre-send dedup check — verifies sms-sent tag NOT on contact before EVERY send
 * 3. Skips 555 numbers (AI-generated fake placeholders)
 * 4. Skips numbers that aren't 10-11 digits (invalid format)
 * 5. In-memory sent set — prevents double-send even if tag write lags
 */

try { require('dotenv').config({ path: './config/.env' }); } catch(e) {}

console.log('[SMS-BLAST] Script starting — GHL_API_KEY present:', !!process.env.GHL_API_KEY);

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ── CONFIG ───────────────────────────────────────────────────────────────────
const GHL_API_KEY  = process.env.GHL_API_KEY;
const GHL_LOCATION = process.env.GHL_LOCATION_ID || 'oe1TpmlDynQGFNdYLkaK';
const FROM_NUMBER  = '+14352911877';

const SMS_MESSAGE = (firstName) =>
  `Hey ${firstName || 'there'}, quick question — are your subs billing you accurately on every draw? Most GCs lose $8-15K per job without knowing it. Check it free: subdraw.com/login –Shawn`;

const SMS_DAILY_CAP    = 1700;
const DELAY_BETWEEN_MS = 1500; // bumped to 1.5s to give tag writes time to settle
const MAX_RETRIES      = 3;
const RETRY_BACKOFF_MS = 3000;

const args       = process.argv.slice(2);
const DRY_RUN    = !args.includes('--send');
const TAG_FILTER = (args.find(a => a.startsWith('--tag=')) || '').replace('--tag=', '') || 'gc-prospect';
const LIMIT      = parseInt((args.find(a => a.startsWith('--limit=')) || '').replace('--limit=', '') || '99999');

// ── SEND WINDOW ──────────────────────────────────────────────────────────────
// Mountain 6:45am = UTC 12:45 | Pacific 5pm = UTC 23:59
function isWithinSendWindow() {
  const now  = new Date();
  const day  = now.getUTCDay();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (day === 0 || day === 6) return false;
  return mins >= 765 && mins <= 1439;
}

function minutesUntilWindow() {
  const mins = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  return mins < 765 ? 765 - mins : (1440 - mins) + 765;
}

// ── PHONE VALIDATION ─────────────────────────────────────────────────────────
function isRealPhone(phone) {
  if (!phone) return false;
  const digits = phone.replace(/\D/g, '');
  // Must be 10 digits (US) or 11 digits starting with 1
  if (digits.length !== 10 && !(digits.length === 11 && digits[0] === '1')) return false;
  // Skip 555 area code — AI-generated fake numbers
  const areaCode = digits.length === 11 ? digits.substring(1, 4) : digits.substring(0, 3);
  if (areaCode === '555') return false;
  return true;
}

// ── STATE ─────────────────────────────────────────────────────────────────────
let sentToday = 0, skipped = 0, failed = 0, rateLimitHits = 0;
let rateLimitRemaining = 100, dailyRemaining = 200000;
const sentPhones = new Set();    // in-memory dedup by phone number
const sentIds    = new Set();    // in-memory dedup by contact ID
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
function log(msg)  { console.log(`[${new Date().toISOString().substring(11,19)}] ${msg}`); }

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
    log(`  Page ${page}: ${batch.length} (total: ${contacts.length})`);
    if (!data.meta?.nextPage || batch.length < 100) break;
    startAfter   = data.meta.startAfter;
    startAfterId = data.meta.startAfterId;
    page++;
    await sleep(500);
  }
  log(`✅ Fetched ${contacts.length} total`);
  return contacts;
}

// ── PRE-SEND DEDUP CHECK ─────────────────────────────────────────────────────
// Re-fetch contact right before sending to confirm sms-sent tag not present
async function alreadySent(contactId) {
  try {
    const data = await ghlRequest('GET', `/contacts/${contactId}`);
    const tags = data.contact?.tags || [];
    return tags.includes('sms-sent') || tags.includes('sms-blast-2026-06-22');
  } catch(e) {
    return false; // if check fails, allow send
  }
}

// ── SEND ONE SMS ──────────────────────────────────────────────────────────────
async function sendSMS(contact) {
  const firstName = contact.firstNameRaw || contact.firstName || 'there';
  const message   = SMS_MESSAGE(firstName);

  if (DRY_RUN) {
    log(`[DRY RUN] → ${firstName} · ${contact.companyName} · ${contact.phone}`);
    return;
  }

  // Pre-send live dedup check
  if (await alreadySent(contact.id)) {
    log(`⏭  Skipping ${firstName} — sms-sent tag already present (live check)`);
    skipped++;
    return;
  }

  // In-memory phone dedup — catches same number on multiple contacts
  if (sentPhones.has(contact.phone)) {
    log(`⏭  Skipping ${firstName} — phone ${contact.phone} already sent this run`);
    skipped++;
    return;
  }

  await ghlRequest('POST', '/conversations/messages', {
    type: 'SMS',
    contactId: contact.id,
    fromNumber: FROM_NUMBER,
    toNumber: contact.phone,
    message
  });

  // Tag immediately after send
  await ghlRequest('POST', `/contacts/${contact.id}/tags`, {
    tags: ['sms-sent', 'sms-blast-2026-06-22']
  });

  // Add to in-memory sets
  sentPhones.add(contact.phone);
  sentIds.add(contact.id);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!GHL_API_KEY) {
    console.error('❌ GHL_API_KEY not set');
    process.exit(1);
  }

  console.log('\n' + '═'.repeat(60));
  console.log('  SubDraw SMS Blast');
  console.log(`  Mode:   ${DRY_RUN ? '🔍 DRY RUN' : '🚀 LIVE SEND'}`);
  console.log(`  Tag:    ${TAG_FILTER}`);
  console.log(`  Cap:    ${SMS_DAILY_CAP}`);
  console.log(`  From:   ${FROM_NUMBER}`);
  console.log(`  Window: 6:45am–5pm Pacific/Mountain Mon–Fri only`);
  console.log('═'.repeat(60) + '\n');

  // Time window gate
  if (!DRY_RUN && !isWithinSendWindow()) {
    const wait = minutesUntilWindow();
    const h = Math.floor(wait / 60), m = wait % 60;
    log(`🚫 OUTSIDE SEND WINDOW — GCs are sleeping. Will not send.`);
    log(`   Window opens in ${h}h ${m}m (6:45am Mountain Time).`);
    log(`   Redeploy after 6:45am local time.`);
    process.exit(0);
  }

  if (!DRY_RUN) {
    log('✅ Within send window — starting in 5s (Ctrl+C to abort)...');
    await sleep(5000);
  }

  const all = await fetchAllContacts(TAG_FILTER);

  const SKIP_TAGS = ['sms-sent', 'unsubscribed', 'sms-unsubscribed', 'do-not-contact'];
  let fakeNumbers = 0;

  const eligible = all.filter(c => {
    // Skip bad/fake phone numbers
    if (!isRealPhone(c.phone)) {
      fakeNumbers++;
      skipped++;
      return false;
    }
    if (c.dnd) { skipped++; return false; }
    // Skip if already tagged
    if (SKIP_TAGS.some(t => (c.tags || []).includes(t))) { skipped++; return false; }
    return true;
  }).slice(0, LIMIT);

  log(`\n📱 Eligible: ${eligible.length}`);
  log(`   Skipped:  ${skipped} (${fakeNumbers} fake/555 numbers, rest already sent or DND)`);
  log(`   Sending up to: ${Math.min(eligible.length, SMS_DAILY_CAP)}\n`);

  for (let i = 0; i < eligible.length; i++) {
    if (sentToday >= SMS_DAILY_CAP) {
      log(`🛑 Daily cap hit (${SMS_DAILY_CAP}). Done.`);
      break;
    }

    // Recheck window every 50 sends
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
      if (!DRY_RUN && !sentIds.has(c.id)) {
        // sendSMS already incremented skipped if deduped
      } else if (DRY_RUN || sentIds.has(c.id)) {
        sentToday++;
        log(`✅ [${sentToday}/${Math.min(eligible.length, SMS_DAILY_CAP)}] ${c.firstNameRaw || c.firstName} · ${c.companyName} · ${c.phone}`);
      }
    } catch(e) {
      failed++;
      failedContacts.push({ name: c.firstNameRaw, company: c.companyName, phone: c.phone, error: e.message });
      log(`❌ FAILED: ${c.firstNameRaw} · ${c.companyName} · ${c.phone} — ${e.message}`);
    }

    if (sentToday > 0 && sentToday % 25 === 0) {
      log(`📊 sent=${sentToday} skipped=${skipped} failed=${failed} rateHits=${rateLimitHits} API-remaining=${rateLimitRemaining}`);
    }

    await sleep(DELAY_BETWEEN_MS);
  }

  console.log('\n' + '═'.repeat(60));
  log(`✅ Sent:         ${sentToday}`);
  log(`⏭  Skipped:      ${skipped} (incl. ${fakeNumbers} fake numbers)`);
  log(`❌ Failed:       ${failed}`);
  log(`🔁 Rate hits:    ${rateLimitHits}`);
  if (DRY_RUN) log('\n⚠️  DRY RUN — no SMS sent. Use --send after 6:45am.');
  if (failedContacts.length) {
    log('\nFailed contacts:');
    failedContacts.forEach(f => log(`  ${f.name} (${f.company}) ${f.phone} — ${f.error}`));
  }
  console.log('═'.repeat(60) + '\n');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
