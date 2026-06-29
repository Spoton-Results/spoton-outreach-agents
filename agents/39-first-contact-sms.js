/**
 * Agent 39: First Contact SMS — PRODUCT-AWARE
 *
 * SubDraw:  GC invoice protection hook
 * Merchant: Edge 1 (free statement audit) + Edge 3 (multi-processor fit) hook
 *
 * Watches for new GHL contacts tagged for outreach that haven't been texted yet.
 * During prime window sends ONE personalized SMS then tags sent.
 * Agent 38 handles all replies after that.
 *
 * SubDraw prime window:  Tue–Thu 10am–5pm Mountain (construction-specific)
 * Merchant prime window: Mon–Fri 9am–6pm Mountain (broader business hours)
 */

require('dotenv').config({ path: './config/.env' });
const { callGHL, callClaude, logRun, notifyDashboard, pingDashboard } = require('../utils/helpers');
const { isMerchant, PRODUCT, MERCHANT_SMS_TEMPLATES, SUBDRAW_SMS_TEMPLATES } = require('../utils/product-config');

const FROM_NUMBER  = process.env.FROM_NUMBER    || '+14352911877';
const LOCATION_ID  = process.env.GHL_LOCATION_ID || 'oe1TpmlDynQGFNdYLkaK';
const BATCH_SIZE   = 20;
const DELAY_MS     = 1500;
const PROSPECT_TAG = isMerchant ? 'merchant-prospect' : 'gc-prospect';
const SENT_TAG     = isMerchant ? 'merchant-sms-sent' : 'sms-sent';

// ── PRIME WINDOW ──────────────────────────────────────────────────────────────
function isPrimeWindow() {
  const now     = new Date();
  const utcDay  = now.getUTCDay();
  const utcH    = now.getUTCHours();
  const utcMin  = now.getUTCMinutes();
  const utcMins = utcH * 60 + utcMin;

  if (isMerchant) {
    // Merchant: Mon–Fri (1–5), 9am–6pm Mountain (UTC-6 summer = 15:00–00:00 UTC)
    if (![1,2,3,4,5].includes(utcDay)) return false;
    return utcMins >= 900 && utcMins < 1440; // 15:00–24:00 UTC = 9am–6pm MT
  } else {
    // SubDraw: Tue–Thu only, 10am–5pm Mountain (UTC-6 summer = 16:00–23:00 UTC)
    if (![2,3,4].includes(utcDay)) return false;
    return utcMins >= 960 && utcMins < 1380; // 16:00–23:00 UTC = 10am–5pm MT
  }
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

// ── BUILD SMS ─────────────────────────────────────────────────────────────────
function buildSMS(contact) {
  const first = contact.firstNameRaw || contact.firstName || null;
  const name  = first ? `Hey ${first}` : 'Hey';

  if (isMerchant) {
    // Rotate through Edge 1 + Edge 3 templates
    const templates = MERCHANT_SMS_TEMPLATES;
    const tmpl = templates[Math.floor(Math.random() * templates.length)];
    return tmpl.replace('{name}', name);
  } else {
    return `${name}, quick question — are your subs billing you accurately on every draw? Most GCs lose $8-15K per job without knowing it. Check it free: subdraw.com/login –Shawn. Reply STOP to opt out.`;
  }
}

// ── FETCH UNSENT LEADS ────────────────────────────────────────────────────────
async function fetchUnsentLeads() {
  try {
    const result = await callGHL('GET',
      `/contacts/?locationId=${LOCATION_ID}&tags=${PROSPECT_TAG}&limit=50`
    );
    const contacts = result?.contacts || [];

    return contacts.filter(c => {
      const tags = c.tags || [];
      return !tags.includes(SENT_TAG)
          && !tags.includes('do-not-contact')
          && isRealPhone(c.phone);
    }).slice(0, BATCH_SIZE);
  } catch(e) {
    console.error('[Agent 39] fetchUnsentLeads error:', e.message);
    return [];
  }
}

// ── TAG AS SENT ───────────────────────────────────────────────────────────────
async function markSent(contactId, currentTags) {
  const newTags = [...new Set([...(currentTags || []), SENT_TAG])];
  await callGHL('PUT', `/contacts/${contactId}`, { tags: newTags });
}

// ── SEND SMS ──────────────────────────────────────────────────────────────────
async function sendSMS(contact, message) {
  return callGHL('POST', '/conversations/messages', {
    type:       'SMS',
    contactId:  contact.id,
    locationId: LOCATION_ID,
    message,
    fromNumber: FROM_NUMBER,
  });
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function runFirstContactSMS() {
  await pingDashboard(39, 'ok', `first-contact-sms tick — PRODUCT=${PRODUCT}`);

  if (!isPrimeWindow()) {
    console.log(`[Agent 39] Outside prime window — skipping (PRODUCT=${PRODUCT})`);
    return { sent: 0, skipped: 0 };
  }

  console.log(`[Agent 39] Prime window active — PRODUCT=${PRODUCT}`);

  const leads = await fetchUnsentLeads();
  console.log(`[Agent 39] ${leads.length} unsent leads found`);

  if (leads.length === 0) return { sent: 0, skipped: 0 };

  let sent = 0, failed = 0;

  for (const contact of leads) {
    try {
      const message = buildSMS(contact);
      await sendSMS(contact, message);
      await markSent(contact.id, contact.tags);
      sent++;
      console.log(`[Agent 39] Sent to ${contact.firstName} ${contact.lastName} — ${contact.phone}`);

      notifyDashboard('sms_sent', {
        contact: contact.id,
        product: PRODUCT,
        template: isMerchant ? 'merchant-edge1-edge3' : 'subdraw-gc'
      });

      // Pause between sends to avoid rate limits
      await new Promise(r => setTimeout(r, DELAY_MS));
    } catch(e) {
      console.error(`[Agent 39] Send failed for ${contact.id}: ${e.message}`);
      failed++;
    }
  }

  logRun('39-first-contact-sms', { sent, failed, product: PRODUCT });
  return { sent, failed };
}

module.exports = { runFirstContactSMS };
