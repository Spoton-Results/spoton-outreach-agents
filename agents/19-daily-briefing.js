/**
 * Agent 19: Daily Intelligence Briefing — REBUILT
 * 5am SMS with SubDraw-specific metrics
 * Tracks: new signups by plan, subcontract volume, pipeline health, drop-offs recovered
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, callInstantly, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are an AI chief of staff for SubDraw — construction draw management SaaS.
Write a plain-English morning briefing for the founder (Shawn).
SubDraw sells to General Contractors. Pricing: $149/$299/$599/mo by active subcontracts.
Be direct, specific, action-oriented. Under 300 words. Highlight what needs human attention.
Return JSON only.`;

async function callStripe(endpoint) {
  const fetch = (await import('node-fetch')).default;
  const res = await fetch('https://api.stripe.com/v1' + endpoint, {
    headers: { 'Authorization': 'Bearer ' + process.env.STRIPE_SECRET_KEY }
  });
  return res.json();
}

async function gatherSignals() {
  const since24h = Math.floor(Date.now() / 1000) - 86400;
  const signals = { timestamp: new Date().toISOString(), new_mrr: 0, new_signups: 0, cancellations: 0 };

  try {
    const events = await callStripe('/events?created[gte]=' + since24h + '&limit=100');
    const signups = events.data?.filter(e => e.type === 'customer.subscription.created') || [];
    signals.new_signups = signups.length;
    signals.new_mrr = signups.reduce((a, e) => a + (e.data?.object?.items?.data?.[0]?.price?.unit_amount || 0) / 100, 0);
    signals.cancellations = events.data?.filter(e => e.type === 'customer.subscription.deleted').length || 0;
    signals.failed_payments = events.data?.filter(e => e.type === 'invoice.payment_failed').length || 0;
  } catch(e) { signals.stripe_error = e.message; }

  try {
    const analytics = await callInstantly('GET', '/analytics/campaign?campaign_id=' + (process.env.INSTANTLY_CAMPAIGN_ID || icp.instantly.campaign_id));
    signals.emails_sent_today = analytics.emails_sent_today || 0;
    signals.open_rate = analytics.open_rate || 0;
    signals.reply_rate = analytics.reply_rate || 0;
    signals.new_replies_today = analytics.new_replies_today || 0;
    signals.warmup_score = analytics.warmup_score || analytics.health_score || null;
  } catch(e) { signals.instantly_error = e.message; }

  try {
    const locationId = process.env.GHL_LOCATION_ID || icp.ghl.location_id;
    const hot = await callGHL('GET', '/contacts/?locationId=' + locationId + '&tags=lead-tier-hot&limit=100');
    signals.hot_leads = hot.contacts?.length || 0;
    const dropoffs = await callGHL('GET', '/contacts/?locationId=' + locationId + '&tags=dropoff-account-created&limit=100');
    signals.dropoffs_needing_recovery = (dropoffs.contacts || []).filter(c => !c.tags?.includes('dropoff-email-sent')).length;
  } catch(e) { signals.ghl_error = e.message; }

  return signals;
}

async function generateBriefing() {
  console.log('[Agent 19] Generating daily briefing...');
  const signals = await gatherSignals();
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  const prompt = `Write Shawn's morning briefing for SubDraw. Today is ${today}.

Last 24 hours:
${JSON.stringify(signals, null, 2)}

SubDraw context: construction draw management SaaS, $149/$299/$599/mo by active subcontracts.
Outreach targeting CA General Contractors now, expanding to TX/FL/AZ.
Campaign launches July 7th if not already live.

Cover:
1. Revenue (new MRR, plan breakdown, cancellations)
2. Outreach (emails, opens, replies, warmup health)
3. Hot leads needing attention
4. Funnel drop-offs to recover
5. One recommended action for today

Return: {
  "sms_version": "under 160 chars — just the numbers and one action",
  "full_brief": "full plain text under 300 words",
  "action_needed": true/false,
  "priority_action": "the single most important thing to do today",
  "revenue_alert": true/false
}`;

  const briefing = JSON.parse(await callClaude(SYSTEM, prompt));

  try {
    const locationId = process.env.GHL_LOCATION_ID || icp.ghl.location_id;
    const founder = await callGHL('GET', '/contacts/?email=' + encodeURIComponent(process.env.FOUNDER_EMAIL || '') + '&locationId=' + locationId);
    const contactId = founder.contacts?.[0]?.id;
    if (contactId) {
      await callGHL('POST', '/conversations/messages', {
        type: 'SMS',
        contactId,
        message: '🔨 SubDraw Daily:\n' + briefing.sms_version + (briefing.revenue_alert ? '\n🚨 REVENUE ALERT' : '')
      });
    }
  } catch(e) { console.error('[Agent 19] SMS error:', e.message); }

  logRun('19-daily-briefing', { priority: briefing.priority_action, new_mrr: signals.new_mrr, revenue_alert: briefing.revenue_alert });
  console.log('[Agent 19] Briefing sent. Priority:', briefing.priority_action);
  return briefing;
}

module.exports = { generateBriefing };
if (require.main === module) generateBriefing().then(() => console.log('[Agent 19] Done'));
