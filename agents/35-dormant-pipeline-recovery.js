/**
 * Agent 35: Dormant Pipeline Recovery
 * Canonical Gap #4 — different from cold lead recovery (Agent 12)
 *
 * Agent 12 handles: leads that were always cold, never engaged, 45+ days old
 * Agent 35 handles: leads that SHOWED INTEREST then went silent
 *   - Had a reply classified as interested or question
 *   - Got moved to Replied stage in GHL
 *   - Then nothing happened — no demo, no signup, no further contact
 *
 * These are your highest value recovery targets.
 * They raised their hand. Something got in the way.
 * The recovery message is completely different — warmer, references
 * their specific interest, treats them as a warm lead not a cold one.
 *
 * Runs daily 5am alongside Agent 12
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are a dormant pipeline recovery agent for SubDraw.
Write re-engagement emails for leads who showed genuine interest then went silent.
These are NOT cold leads — they replied, asked questions, or showed intent.
Something got in the way. Your job is to pick up where they left off.
Reference their interest without being pushy. Under 100 words. Return JSON only.`;

async function findDormantLeads() {
  console.log('[Agent 35] Finding dormant pipeline leads...');
  try {
    const locationId = process.env.GHL_LOCATION_ID || icp.ghl.location_id;
    const pipelineId = process.env.GHL_PIPELINE_ID || icp.ghl.pipeline_id;
    const repliedStageId = process.env.GHL_STAGE_REPLIED || icp.ghl.stages.replied;

    // Find opportunities in Replied stage older than 14 days with no recent activity
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 14);

    const opps = await callGHL('GET',
      '/opportunities/search?pipeline_id=' + pipelineId +
      '&pipeline_stage_id=' + repliedStageId +
      '&date_added_lte=' + cutoff.toISOString() +
      '&limit=20'
    );

    const dormant = (opps.opportunities || []).filter(o =>
      !o.contact?.tags?.includes('dormant-recovery-sent') &&
      !o.contact?.tags?.includes('customer') &&
      !o.contact?.tags?.includes('unsubscribed')
    );

    console.log('[Agent 35] Found ' + dormant.length + ' dormant pipeline leads');
    return dormant;
  } catch(e) {
    console.error('[Agent 35] Error:', e.message);
    return [];
  }
}

async function recoverDormantLead(opp) {
  let contact = opp.contact || {};
  if (contact.id && !contact.firstName && !contact.tags) {
    try {
      const fetched = await callGHL('GET', '/contacts/' + contact.id);
      contact = fetched.contact || contact;
    } catch(e) { console.warn('[Agent 35] Could not fetch contact:', e.message); }
  }
  if (!contact.id) { console.log('[Agent 35] No contact for opp:', opp.id); return { opp, skipped: true }; }
  const tags = contact.tags || [];

  // Determine what they originally showed interest in
  const wasInterested = tags.includes('reply-interested');
  const askedPricing = tags.includes('reply-question_pricing');
  const askedFeature = tags.includes('reply-question_feature');
  const hadObjestion = tags.some(t => t.startsWith('reply-objection'));

  let context = 'showed interest in SubDraw';
  if (askedPricing) context = 'asked about SubDraw pricing';
  if (askedFeature) context = 'asked about SubDraw features';
  if (hadObjestion) context = 'had questions about switching to SubDraw';

  const prompt = `Write a recovery email for a GC who ${context} but then went quiet:

Contact: ${contact.firstName} ${contact.lastName} at ${contact.companyName}
Location: ${contact.city}, ${contact.state}
Original interest: ${context}
Days since last contact: 14+
Pain point tag: ${tags.find(t => t.startsWith('pain-')) || 'draw management'}
Demo URL: ${icp.product.demo_url}

Pick up where they left off naturally.
Don't say "following up" or "circling back".
Reference their original interest if you know it.
Offer the demo link again — no call needed.
Under 100 words.

Return: { "subject": "...", "body": "..." }`;

  const email = JSON.parse(await callClaude(SYSTEM, prompt));

  try {
    if (contact.id) {
      await callGHL('POST', '/conversations/messages', {
        type: 'Email',
        contactId: contact.id,
        subject: email.subject,
        body: email.body,
        html: '<p>' + email.body.replace(/\n/g, '<br>') + '</p>'
      });
      await callGHL('PUT', '/contacts/' + contact.id, {
        tags: [...tags, 'dormant-recovery-sent']
      });
    }
    logRun('35-dormant-pipeline-recovery', {
      contact: contact.email,
      original_context: context,
      days_dormant: '14+'
    });
  } catch(e) {
    console.error('[Agent 35] Send error:', e.message);
  }

  return { opp, email };
}

async function runDormantRecovery() {
  const dormant = await findDormantLeads();
  if (!dormant.length) {
    console.log('[Agent 35] No dormant leads to recover');
    return [];
  }
  return Promise.all(dormant.map(recoverDormantLead));
}

module.exports = { runDormantRecovery };
if (require.main === module) runDormantRecovery().then(r => console.log('[Agent 35] Done:', r.length));
