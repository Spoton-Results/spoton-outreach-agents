/**
 * Agent 15: SMS Agent — High Intent Trigger
 * Scans Instantly for leads who opened 3+ times but never replied
 * High-intent signal: interested but need a nudge
 * Cross-references GHL for phone number, sends personalized SMS
 * Runs every 2 hours via orchestrator
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, callInstantly, logRun, notifyDashboard } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are an SMS outreach agent for SubDraw construction draw software.
Write a short, direct SMS to a GC who opened our email multiple times but didn't reply.
Under 160 characters. Sound like a real person texting — not a bot.
Always end with subdraw.com/login
Return JSON only: { "message": "..." }`;

// ── Find high-intent openers from Instantly ───────────────────────────────────
async function findHighIntentLeads() {
  console.log('[Agent 15] Scanning Instantly for high-intent openers...');

  try {
    // Check both campaigns
    const campaignIds = [
      process.env.INSTANTLY_CAMPAIGN_ID || icp.instantly?.campaign_id,
      process.env.INSTANTLY_UT_CAMPAIGN_ID
    ].filter(Boolean);

    const highIntent = [];

    for (const campaignId of campaignIds) {
      try {
        // Get leads with open data from Instantly v2
        const data = await callInstantly('GET', `/api/v2/leads?campaign_id=${campaignId}&limit=100`);
        const leads = data.items || data.leads || [];

        for (const lead of leads) {
          const opens = lead.open_count || lead.opens || 0;
          const replied = lead.replied || lead.is_replied || false;
          const unsubscribed = lead.unsubscribed || lead.is_unsubscribed || false;

          if (opens >= 3 && !replied && !unsubscribed) {
            highIntent.push({ ...lead, campaignId });
          }
        }
      } catch(e) {
        console.error(`[Agent 15] Campaign ${campaignId} error: ${e.message}`);
      }
    }

    console.log(`[Agent 15] Found ${highIntent.length} high-intent non-responders (3+ opens)`);
    return highIntent;

  } catch(e) {
    console.error('[Agent 15] Instantly scan error:', e.message);
    return [];
  }
}

// ── Send SMS to one high-intent lead ──────────────────────────────────────────
async function sendHighIntentSMS(lead) {
  const firstName  = lead.first_name || lead.firstName || 'there';
  const company    = lead.company_name || lead.companyName || '';
  const email      = lead.email || lead.lead_email || '';
  const opens      = lead.open_count || lead.opens || 3;

  try {
    // Find contact in GHL by email
    const locationId = process.env.GHL_LOCATION_ID || icp.ghl?.location_id || 'oe1TpmlDynQGFNdYLkaK';
    const contactData = await callGHL('GET', `/contacts/?email=${encodeURIComponent(email)}&locationId=${locationId}`);
    const contact = contactData.contacts?.[0];

    if (!contact) {
      console.log(`[Agent 15] No GHL contact for ${email} — skipping`);
      return { sent: false, reason: 'no_ghl_contact' };
    }

    if (!contact.phone) {
      console.log(`[Agent 15] No phone for ${email} — skipping`);
      return { sent: false, reason: 'no_phone' };
    }

    // Check if already SMS'd
    if ((contact.tags || []).includes('high-intent-sms-sent')) {
      console.log(`[Agent 15] Already SMS'd ${email} — skipping`);
      return { sent: false, reason: 'already_sent' };
    }

    // Skip fake 555 numbers
    const digits = contact.phone.replace(/\D/g, '');
    const area = digits.length === 11 ? digits.substring(1,4) : digits.substring(0,3);
    if (area === '555') {
      return { sent: false, reason: 'fake_number' };
    }

    // Generate personalized SMS
    const prompt = `Write an SMS to a GC who opened our SubDraw email ${opens} times but didn't reply.
Contact: ${firstName} at ${company || 'their company'}
Opened: ${opens} times — clearly interested, just hasn't clicked yet
Under 160 chars. Reference that they checked us out. Direct CTA.
Return: { "message": "..." }`;

    let smsText;
    try {
      const result = JSON.parse(await callClaude(SYSTEM, prompt));
      smsText = result.message;
    } catch(e) {
      // Fallback message
      smsText = `Hey ${firstName}, saw you checked out SubDraw a few times — happy to answer any questions. Takes 2 min to see if it fits: subdraw.com/login –Shawn`;
    }

    // Send SMS via GHL
    await callGHL('POST', '/conversations/messages', {
      type: 'SMS',
      contactId: contact.id,
      fromNumber: process.env.FROM_NUMBER || '+14352911877',
      toNumber: contact.phone,
      message: smsText
    });

    // Tag contact so we don't double-send
    await callGHL('POST', `/contacts/${contact.id}/tags`, {
      tags: ['high-intent-sms-sent', 'sms-sent']
    });

    // Update pipeline stage to warm
    const stageReplied = process.env.GHL_STAGE_REPLIED || icp.ghl?.stages?.replied;
    if (stageReplied && contact.id) {
      // Find their opportunity and advance stage
      try {
        const opps = await callGHL('GET', `/opportunities/search?location_id=${locationId}&contact_id=${contact.id}`);
        const opp = opps.opportunities?.[0];
        if (opp) {
          await callGHL('PUT', `/opportunities/${opp.id}`, { pipelineStageId: stageReplied });
        }
      } catch(e) { /* non-critical */ }
    }

    await notifyDashboard('sms_sent', {
      contact: firstName,
      company,
      trigger: 'high_intent',
      opens
    });

    logRun('15-sms-agent', { sent_to: email, opens, company });
    console.log(`[Agent 15] ✅ SMS sent to ${firstName} @ ${company} (${opens} opens)`);
    return { sent: true, email, message: smsText };

  } catch(e) {
    console.error(`[Agent 15] SMS error for ${email}: ${e.message}`);
    return { sent: false, error: e.message };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function runSMSAgent() {
  const highIntent = await findHighIntentLeads();
  if (!highIntent.length) {
    console.log('[Agent 15] No high-intent leads right now');
    return [];
  }

  const results = [];
  for (const lead of highIntent) {
    const result = await sendHighIntentSMS(lead);
    results.push(result);
    await new Promise(r => setTimeout(r, 1200));
  }

  const sent = results.filter(r => r.sent).length;
  console.log(`[Agent 15] Done — SMS sent: ${sent}/${highIntent.length}`);
  return results;
}

module.exports = { runSMSAgent };
if (require.main === module) runSMSAgent().then(r => console.log('[Agent 15] Done:', r.length, 'processed'));
