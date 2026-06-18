/**
 * Agent 19: Daily Intelligence Briefing
 * Runs every morning at 5am
 * Reads all signals from last 24hrs and sends Shawn a plain-English SMS/WhatsApp summary
 * The system's morning report — what happened, what's working, what needs attention
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, callInstantly, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are an AI chief of staff for SubDraw, a construction draw management SaaS.
Every morning you write a plain-English briefing for the founder.
Be direct, specific, and action-oriented. No fluff. Under 300 words.
Highlight what needs human attention today. Return JSON only.`;

async function callStripe(endpoint) {
  const fetch = (await import('node-fetch')).default;
  const res = await fetch('https://api.stripe.com/v1' + endpoint, {
    headers: { 'Authorization': 'Bearer ' + process.env.STRIPE_SECRET_KEY }
  });
  return res.json();
}

async function gatherSignals() {
  const since24h = Math.floor(Date.now() / 1000) - 86400;
  const signals = {};

  // Stripe — new revenue
  try {
    const events = await callStripe('/events?created[gte]=' + since24h + '&limit=50');
    signals.new_signups = events.data?.filter(e => e.type === 'customer.subscription.created').length || 0;
    signals.cancellations = events.data?.filter(e => e.type === 'customer.subscription.deleted').length || 0;
    signals.failed_payments = events.data?.filter(e => e.type === 'invoice.payment_failed').length || 0;
  } catch(e) { signals.stripe_error = e.message; }

  // Instantly — campaign performance
  try {
    const analytics = await callInstantly('GET', '/analytics/campaign?campaign_id=' + (process.env.INSTANTLY_CAMPAIGN_ID || icp.instantly.campaign_id));
    signals.emails_sent_24h = analytics.emails_sent_today || 0;
    signals.open_rate = analytics.open_rate || 0;
    signals.reply_rate = analytics.reply_rate || 0;
    signals.new_replies = analytics.new_replies_today || 0;
  } catch(e) { signals.instantly_error = e.message; }

  // GHL — pipeline movement
  try {
    const locationId = process.env.GHL_LOCATION_ID || icp.ghl.location_id;
    const hot = await callGHL('GET', '/contacts/?locationId=' + locationId + '&tags=lead-tier-hot&limit=100');
    signals.hot_leads = hot.contacts?.length || 0;
    const replied = await callGHL('GET', '/contacts/?locationId=' + locationId + '&tags=replied&limit=100');
    signals.replied_leads = replied.contacts?.length || 0;
  } catch(e) { signals.ghl_error = e.message; }

  return signals;
}

async function generateBriefing() {
  console.log('[Agent 19] Generating daily briefing...');
  const signals = await gatherSignals();
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  const prompt = `Generate a morning briefing for the SubDraw founder. Today is ${today}.

Last 24 hours signals:
${JSON.stringify(signals, null, 2)}

Write a plain-English briefing covering:
1. Revenue update (new signups, MRR change)
2. Outreach performance (emails, opens, replies)
3. Hot leads that need attention today
4. Any alerts or problems
5. One recommended action for today

Return: {
  "subject": "SubDraw Morning Brief — ${today}",
  "sms_version": "under 160 chars summary for SMS",
  "full_brief": "full plain text briefing under 300 words",
  "action_needed": true/false,
  "priority_action": "the one thing to do today"
}`;

  const briefing = JSON.parse(await callClaude(SYSTEM, prompt));

  // Send SMS via GHL to Shawn
  try {
    const locationId = process.env.GHL_LOCATION_ID || icp.ghl.location_id;
    const shawnContact = await callGHL('GET', '/contacts/?email=' + encodeURIComponent(process.env.FOUNDER_EMAIL || '') + '&locationId=' + locationId);
    const contactId = shawnContact.contacts?.[0]?.id;
    if (contactId) {
      await callGHL('POST', '/conversations/messages', {
        type: 'SMS',
        contactId,
        message: '🔨 SubDraw Daily Brief:\n' + briefing.sms_version + '\n\nPriority: ' + briefing.priority_action
      });
    }
  } catch(e) { console.error('[Agent 19] SMS error:', e.message); }

  logRun('19-daily-briefing', { signals, priority: briefing.priority_action, action_needed: briefing.action_needed });
  console.log('[Agent 19] Brief sent:', briefing.priority_action);
  return briefing;
}

module.exports = { generateBriefing };
if (require.main === module) generateBriefing().then(() => console.log('[Agent 19] Done'));
