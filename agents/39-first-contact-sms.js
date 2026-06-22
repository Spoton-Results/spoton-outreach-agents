/**
 * Agent 39: First Contact SMS
 *
 * Watches for new GHL contacts tagged gc-prospect that haven't been texted yet.
 * During prime window sends ONE personalized SMS then tags sms-sent.
 * Agent 38 handles all replies after that.
 *
 * Prime window: Tue–Thu, 10:00am–5:00pm Mountain Time
 * Runs every 5 min via orchestrator (same tick as prospect finder)
 *
 * Tags used:
 *   gc-prospect    → contact is a target (set by Agent 01)
 *   sms-sent       → contact has received first SMS (set by this agent)
 *   sms-queued     → contact is waiting for prime window
 *   do-not-contact → never text (set by Agent 38 on STOP)
 */

require('dotenv').config({ path: './config/.env' });
const { callGHL, callClaude, logRun, notifyDashboard } = require('../utils/helpers');

const FROM_NUMBER  = process.env.FROM_NUMBER    || '+14352911877';
const LOCATION_ID  = process.env.GHL_LOCATION_ID || 'oe1TpmlDynQGFNdYLkaK';
const BATCH_SIZE   = 20; // max sends per run to stay controlled
const DELAY_MS     = 1500;

// ── PRIME WINDOW ──────────────────────────────────────────────────────────────
// Tue(2) Wed(3) Thu(4) — 10:00am to 5:00pm Mountain Time (UTC-6 in summer)
function isPrimeWindow() {
  const now    = new Date();
  const utcDay = now.getUTCDay();
  const utcH   = now.getUTCHours();
  const utcMin  = now.getUTCMinutes();
  const utcMins = utcH * 60 + utcMin;

  // Tue/Wed/Thu only
  return false; // DISABLED

  // 10:00am Mountain = 16:00 UTC | 5:00pm Mountain = 23:00 UTC
  return utcMins >= 960 && utcMins < 1380;
}

// ── PHONE VALIDATION ──────────────────────────────────────────────────────────
function isRealPhone(phone) {
  if (!phone) return false;
  const digits = phone.replace(/\D/g, '');
  if (digits.length !== 10 && !(digits.length === 11 && digits[0] === '1')) return false;
  const area = digits.length === 11 ? digits.substring(1, 4) : digits.substring(0, 3);
  if (area === '555') return false;
  return true;
}

// ── BUILD SMS MESSAGE ─────────────────────────────────────────────────────────
function buildSMS(contact) {
  const first = contact.firstNameRaw || contact.firstName || null;
  const name  = first ? `Hey ${first}` : 'Hey';
  return `${name}, quick question — are your subs billing you accurately on every draw? Most GCs lose $8-15K per job without knowing it. Check it free: subdraw.com/login –Shawn`;
}

// ── FETCH UNSENT LEADS ────────────────────────────────────────────────────────
async function fetchUnsentLeads() {
  const contacts = [];
  let startAfter = null, startAfterId = null, page = 1;

  while (true) {
    let url = `/contacts/?locationId=${LOCATION_ID}&limit=100&query=gc-prospect`;
    if (startAfter)   url += `&startAfter=${startAfter}`;
    if (startAfterId) url += `&startAfterId=${startAfterId}`;

    const data = await callGHL('GET', url);
    const batch = data.contacts || [];
    if (!batch.length) break;

    for (const c of batch) {
      const tags = c.tags || [];
      // Skip if already texted, opted out, or DND
      if (tags.includes('sms-sent'))        continue;
      if (tags.includes('do-not-contact'))  continue;
      if (tags.includes('sms-unsubscribed')) continue;
      if (c.dnd)                            continue;
      // Must have a real phone
      if (!isRealPhone(c.phone))            continue;
      contacts.push(c);
    }

    if (!data.meta?.nextPage) break;
    startAfter   = data.meta.startAfter;
    startAfterId = data.meta.startAfterId;
    page++;

    await new Promise(r => setTimeout(r, 300));

    // Safety cap — don't load more than 500 at a time
    if (contacts.length >= 500) break;
  }

  return contacts;
}

// ── SEND ONE SMS ──────────────────────────────────────────────────────────────
async function sendFirstSMS(contact) {
  const message = buildSMS(contact);

  await callGHL('POST', '/conversations/messages', {
    type: 'SMS',
    contactId: contact.id,
    fromNumber: FROM_NUMBER,
    toNumber: contact.phone,
    message
  });

  // Tag as sent so nothing else touches this contact
  await callGHL('POST', `/contacts/${contact.id}/tags`, {
    tags: ['sms-sent', `sms-first-contact-${new Date().toISOString().split('T')[0]}`]
  });

  return message;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function runFirstContactSMS() {
  const inWindow = isPrimeWindow();

  if (!inWindow) {
    console.log('[Agent 39] Outside prime window — skipping sends');
    return { sent: 0, queued: 0, reason: 'outside_window' };
  }

  console.log('[Agent 39] Prime window active — checking for unsent leads...');

  let unsent = [];
  try {
    unsent = await fetchUnsentLeads();
  } catch(e) {
    console.error('[Agent 39] Fetch error:', e.message);
    return { sent: 0, error: e.message };
  }

  console.log(`[Agent 39] Found ${unsent.length} unsent leads`);

  if (!unsent.length) {
    console.log('[Agent 39] No new leads to contact');
    return { sent: 0, queued: 0 };
  }

  // Cap per run so we don't spam if a huge batch comes in
  const batch = unsent.slice(0, BATCH_SIZE);
  let sent = 0, failed = 0;
  const sentPhones = new Set(); // dedup within this run

  for (const contact of batch) {
    const normalizedPhone = contact.phone.replace(/\D/g, '');

    // Skip if we already sent to this number this run
    if (sentPhones.has(normalizedPhone)) {
      console.log(`[Agent 39] Skipping duplicate phone ${contact.phone}`);
      continue;
    }

    try {
      const msg = await sendFirstSMS(contact);
      sentPhones.add(normalizedPhone);
      sent++;

      const name = contact.firstNameRaw || contact.companyName || contact.phone;
      console.log(`[Agent 39] ✅ Sent to ${name} (${contact.companyName})`);

      await notifyDashboard('sms_sent', {
        contact: name,
        company: contact.companyName,
        phone: contact.phone,
        trigger: 'first_contact'
      }).catch(() => {});

    } catch(e) {
      failed++;
      console.error(`[Agent 39] Failed ${contact.phone}: ${e.message}`);
    }

    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  const remaining = unsent.length - batch.length;

  logRun('39-first-contact-sms', {
    sent,
    failed,
    remaining,
    window: 'prime'
  });

  console.log(`[Agent 39] Done — sent: ${sent}, failed: ${failed}, remaining queue: ${remaining}`);
  return { sent, failed, remaining };
}

module.exports = { runFirstContactSMS };
if (require.main === module) {
  runFirstContactSMS()
    .then(r => console.log('[Agent 39] Complete:', r))
    .catch(e => console.error('[Agent 39] Fatal:', e.message));
}
