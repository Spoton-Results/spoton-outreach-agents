/**
 * Agent 38: SMS Reply Handler
 * Polls GHL for inbound SMS replies on both SubDraw numbers
 * Classifies the reply, auto-responds via SMS, tags contact, updates pipeline
 *
 * Numbers monitored:
 *   +14352911877 — SMS blast number (A2P)
 *   +14359995348 — Voice AI call number (GCs text back after a call)
 *
 * Runs every 2 minutes via orchestrator (same as dashboard SMS poller)
 * This lives in the agent system so it has full Claude classify + respond logic
 */

require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, logRun, notifyDashboard } = require('../utils/helpers');

const FROM_SMS    = process.env.FROM_NUMBER       || '+14352911877';
const FROM_VOICE  = process.env.FROM_VOICE_NUMBER || '+14359995348';
const LOCATION_ID = process.env.GHL_LOCATION_ID   || 'oe1TpmlDynQGFNdYLkaK';
const PIPELINE_ID = process.env.GHL_PIPELINE_ID   || 'lu4BTmjYjJC2hZVKxj1t';
const STAGE_REPLIED = process.env.GHL_STAGE_REPLIED || '32e745b6-97f5-4ad1-8b59-4652995f2176';

// Track messages we've already handled so we don't double-reply
const handledIds = new Set();
let lastCheckTime = Date.now() - (3 * 60 * 1000); // Start: check last 3 min on boot

// ── SYSTEM PROMPT ─────────────────────────────────────────────────────────────
const CLASSIFY_SYSTEM = `You are an SMS reply classifier for SubDraw — subcontractor invoice protection software for general contractors.
A GC received either an outbound SMS or a voice AI call from SubDraw and is texting back.
Classify their reply. Return JSON only.

CATEGORIES:
- "interested"         : wants to learn more, positive, asking to see it
- "question_pricing"   : asking about cost, plans, price
- "question_feature"   : asking how it works, what it does, specific features
- "question_who"       : who is this, why did you call/text, what is SubDraw
- "wants_human"        : wants to talk to a real person, asks to call them
- "not_now"            : not the right time, busy, try later
- "unsubscribe"        : STOP, remove me, don't contact, opt out, not interested
- "wrong_number"       : wrong person, don't know you, never contacted you
- "auto_reply"         : automated message, out of office
- "unclear"            : can't determine intent

Return: { "category": "...", "urgency": "high|medium|low" }`;

const RESPOND_SYSTEM = `You are an SMS reply agent for SubDraw — subcontractor invoice protection software for general contractors.
A GC texted back after receiving outreach from SubDraw. Write a reply SMS.

ABOUT SUBDRAW:
- Automatically flags when a sub overbills or bills for incomplete work before the GC pays
- Price: $149/mo up to 10 subs · $299 up to 30 subs · $599 unlimited
- 7-day free trial, no credit card required
- Demo: subdraw.com/login — click "Demo as GC"
- One caught overrun on one job covers years of subscription
- Built for GCs managing draw schedules and multiple subcontractors

RULES:
- 1 to 3 sentences MAX — this is SMS, not email
- Never mention the phone numbers we text from
- If they want a human: "Call or text our team at (435) 999-5348"
- Always end with subdraw.com/login UNLESS they said STOP/remove
- Sound like a real person — not a bot
- Never make up features or pricing not listed above
Return JSON only: { "message": "..." }`;

// ── CLASSIFY ──────────────────────────────────────────────────────────────────
async function classifyReply(body) {
  const prompt = `Classify this inbound SMS reply to SubDraw outreach:\n\n"${body.substring(0, 400)}"\n\nReturn JSON only.`;
  try {
    return JSON.parse(await callClaude(CLASSIFY_SYSTEM, prompt, { max_tokens: 200 }));
  } catch(e) {
    return { category: 'unclear', urgency: 'medium' };
  }
}

// ── GENERATE RESPONSE ─────────────────────────────────────────────────────────
async function generateResponse(body, category) {
  const contextMap = {
    interested:        'They want to learn more. Confirm and send them the demo link.',
    question_pricing:  'They asked about price. Give the tiers briefly, mention free trial, then demo link.',
    question_feature:  'They asked how it works or about a specific feature. Answer in one sentence then demo link.',
    question_who:      'They asked who we are or why we contacted them. Explain SubDraw in one sentence then demo link.',
    wants_human:       'They want to talk to a real person. Give them (435) 999-5348 and offer the demo link.',
    not_now:           'They said not now or too busy. Acknowledge it, leave the demo link for when they are ready.',
    unclear:           'Unclear message. Re-introduce SubDraw briefly and offer the demo link.',
  };

  const prompt = `Write a reply SMS to this GC message:\n\n"${body.substring(0, 400)}"\n\nContext: ${contextMap[category] || contextMap.unclear}\n\nUnder 3 sentences. Human tone. Return JSON only: { "message": "..." }`;

  try {
    const result = JSON.parse(await callClaude(RESPOND_SYSTEM, prompt, { max_tokens: 300 }));
    return result.message;
  } catch(e) {
    // Safe fallback
    return `Hi! This is SubDraw — we build software that catches subcontractor invoice overruns before GCs pay them. Quick demo here: subdraw.com/login — no signup needed.`;
  }
}

// ── SEND SMS REPLY ────────────────────────────────────────────────────────────
async function sendSMSReply(contactId, toNumber, fromNumber, message) {
  return callGHL('POST', '/conversations/messages', {
    type: 'SMS',
    contactId,
    fromNumber,
    toNumber,
    message
  });
}

// ── TAG + PIPELINE ────────────────────────────────────────────────────────────
async function updateContact(contactId, category) {
  const tagMap = {
    interested:       ['sms-replied', 'hot-lead', 'reply-interested'],
    question_pricing: ['sms-replied', 'reply-pricing-question'],
    question_feature: ['sms-replied', 'reply-feature-question'],
    question_who:     ['sms-replied', 'reply-who-is-this'],
    wants_human:      ['sms-replied', 'wants-human-followup'],
    not_now:          ['sms-replied', 'reply-not-now'],
    unsubscribe:      ['sms-unsubscribed', 'do-not-contact'],
    wrong_number:     ['sms-wrong-number', 'do-not-contact'],
  };

  const tags = tagMap[category] || ['sms-replied'];

  // Add tags
  try {
    await callGHL('POST', `/contacts/${contactId}/tags`, { tags });
  } catch(e) { /* non-critical */ }

  // Advance pipeline for engaged replies
  const engagedCategories = ['interested', 'question_pricing', 'question_feature', 'wants_human'];
  if (engagedCategories.includes(category)) {
    try {
      const opps = await callGHL('GET', `/opportunities/search?location_id=${LOCATION_ID}&contact_id=${contactId}&pipeline_id=${PIPELINE_ID}`);
      const opp = opps.opportunities?.[0];
      if (opp) {
        await callGHL('PUT', `/opportunities/${opp.id}`, { pipelineStageId: STAGE_REPLIED });
      }
    } catch(e) { /* non-critical */ }
  }
}

// ── MAIN POLL LOOP ────────────────────────────────────────────────────────────
async function pollSMSReplies() {
  console.log('[Agent 38] Polling GHL for inbound SMS replies...');

  try {
    // Get recent conversations sorted by last message
    const data = await callGHL('GET',
      `/conversations/search?locationId=${LOCATION_ID}&limit=50&sortBy=last_message_date&sort=desc`
    );
    const convos = data.conversations || [];

    let handled = 0;

    for (const convo of convos) {
      // Skip if last message is older than our last check
      const lastMsg = new Date(convo.lastMessageDate).getTime();
      if (lastMsg < lastCheckTime) continue;

      // Only care about convos where last message is inbound SMS
      if (convo.lastMessageDirection !== 'inbound') continue;
      if (!['TYPE_SMS', 'TYPE_CAMPAIGN_SMS', 'TYPE_CUSTOM_SMS'].includes(convo.lastMessageType)) continue;

      // Pull messages for this conversation
      let messages;
      try {
        const msgData = await callGHL('GET', `/conversations/${convo.id}/messages?limit=10`);
        messages = Array.isArray(msgData.messages)
          ? msgData.messages
          : (msgData.messages?.messages || []);
      } catch(e) {
        console.log(`[Agent 38] Could not fetch messages for ${convo.id}: ${e.message}`);
        continue;
      }

      for (const msg of messages) {
        // Only process inbound messages we haven't seen
        if (msg.direction !== 'inbound') continue;
        if (handledIds.has(msg.id)) continue;

        const msgTime = new Date(msg.dateAdded || msg.createdAt).getTime();
        if (msgTime < lastCheckTime) continue;

        handledIds.add(msg.id);

        const body = (msg.body || msg.text || '').trim();
        if (!body) continue;

        const contactId  = convo.contactId;
        const contactName = convo.contactName || convo.fullName || 'there';
        const toNumber   = msg.from; // GC's number
        const fromNumber = msg.to;   // Which SubDraw number they replied to

        console.log(`[Agent 38] Inbound SMS from ${contactName}: "${body.substring(0, 80)}"`);

        // Classify
        const classification = await classifyReply(body);
        const { category, urgency } = classification;
        console.log(`[Agent 38] Classified as: ${category} (${urgency})`);

        // Handle unsubscribe/wrong number — do NOT reply, just tag
        if (category === 'unsubscribe' || category === 'wrong_number') {
          await updateContact(contactId, category);
          await notifyDashboard('CRITICAL_STOP', {
            contact: contactName,
            message: body,
            category,
            action_required: 'Tagged do-not-contact'
          }).catch(() => {});
          console.log(`[Agent 38] 🚫 ${category} — tagged do-not-contact, no reply sent`);
          handled++;
          continue;
        }

        // Skip auto-replies
        if (category === 'auto_reply') {
          console.log(`[Agent 38] Auto-reply detected — skipping`);
          handled++;
          continue;
        }

        // Generate and send response
        const replyMessage = await generateResponse(body, category);

        try {
          await sendSMSReply(contactId, toNumber, fromNumber || FROM_SMS, replyMessage);
          console.log(`[Agent 38] ✅ Replied to ${contactName}`);
        } catch(e) {
          console.error(`[Agent 38] Send error: ${e.message}`);
          continue;
        }

        // Update contact tags and pipeline
        await updateContact(contactId, category);

        // Notify dashboard
        const alertLevel = ['interested', 'question_pricing', 'wants_human'].includes(category) ? 'hot' : 'normal';
        await notifyDashboard(alertLevel === 'hot' ? 'HOT_REPLY' : 'sms_reply', {
          contact: contactName,
          message: body,
          category,
          reply_sent: replyMessage
        }).catch(() => {});

        logRun('38-sms-reply-handler', {
          contact: contactName,
          category,
          urgency,
          reply_preview: replyMessage.substring(0, 80)
        });

        handled++;

        // Small delay between sends
        await new Promise(r => setTimeout(r, 800));
      }
    }

    lastCheckTime = Date.now();
    console.log(`[Agent 38] Done — handled ${handled} inbound SMS replies`);
    return handled;

  } catch(e) {
    console.error('[Agent 38] Poll error:', e.message);
    return 0;
  }

  // Trim handled set to avoid unbounded memory growth
  if (handledIds.size > 5000) {
    const arr = [...handledIds];
    arr.slice(0, 2500).forEach(id => handledIds.delete(id));
  }
}

// ── EXPORT + STANDALONE ───────────────────────────────────────────────────────
module.exports = { pollSMSReplies };

if (require.main === module) {
  pollSMSReplies()
    .then(n => console.log(`[Agent 38] Standalone run complete — ${n} handled`))
    .catch(e => console.error('[Agent 38] Fatal:', e.message));
}
