/**
 * Agent 15: SMS Agent
 * Triggers GHL SMS when a GC opens an email 3+ times but never replied
 * High-intent signal — they're interested but haven't pulled the trigger
 * Runs every 2 hours checking Instantly engagement data
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, callInstantly, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are an SMS outreach agent for SubDraw construction draw software.
Write a short, direct SMS to a GC who opened an email multiple times but didn't reply.
Under 160 characters. Sound like a real person texting — not a bot.
Always include subdraw.com/login
Return JSON only.`;

async function findHighIntentLeads() {
  console.log('[Agent 15] Scanning for high-intent email openers...');

  try {
    // Get campaign analytics from Instantly
    const analytics = await callInstantly('GET', '/analytics/campaign?campaign_id=' + (process.env.INSTANTLY_CAMPAIGN_ID || icp.instantly.campaign_id));
    const leads = analytics.leads || [];

    // Filter: opened 3+ times, no reply, has phone in GHL
    const highIntent = leads.filter(l =>
      (l.open_count >= 3) &&
      !l.replied &&
      !l.unsubscribed
    );

    console.log('[Agent 15] Found ' + highIntent.length + ' high-intent non-responders');
    return highIntent;
  } catch(e) {
    console.error('[Agent 15] Instantly error:', e.message);
    return [];
  }
}

async function sendSMS(lead) {
  const prompt = `Write an SMS to a GC who opened our SubDraw email ${lead.open_count} times but didn't reply.
They're interested but haven't acted yet.
Contact: ${lead.first_name || 'there'} at ${lead.company_name || 'their company'}
Demo URL: ${icp.product.demo_url}
Under 160 chars. Direct. No fluff.
Return: { "message": "..." }`;

  const sms = JSON.parse(await callClaude(SYSTEM, prompt));

  try {
    const locationId = process.env.GHL_LOCATION_ID || icp.ghl.location_id;
    const contacts = await callGHL('GET', '/contacts/?email=' + encodeURIComponent(lead.email) + '&locationId=' + locationId);
    const contact = contacts.contacts?.[0];

    if (contact?.phone) {
      await callGHL('POST', '/conversations/messages', {
        type: 'SMS',
        contactId: contact.id,
        message: sms.message
      });
      logRun('15-sms-agent', { sent_to: lead.email, opens: lead.open_count, message: sms.message });
      return { ...lead, sms_sent: true, message: sms.message };
    } else {
      console.log('[Agent 15] No phone for ' + lead.email + ' — skipping SMS');
      return { ...lead, sms_sent: false, reason: 'no_phone' };
    }
  } catch(e) {
    console.error('[Agent 15] SMS error for ' + lead.email + ': ' + e.message);
    return { ...lead, sms_sent: false, error: e.message };
  }
}

async function runSMSAgent() {
  const highIntent = await findHighIntentLeads();
  if (!highIntent.length) return [];

  const results = [];
  for (const lead of highIntent) {
    const result = await sendSMS(lead);
    results.push(result);
  }

  const sent = results.filter(r => r.sms_sent).length;
  console.log('[Agent 15] SMS sent: ' + sent + '/' + highIntent.length);
  return results;
}

module.exports = { runSMSAgent };
if (require.main === module) runSMSAgent().then(r => console.log('[Agent 15] Done:', r.length));
