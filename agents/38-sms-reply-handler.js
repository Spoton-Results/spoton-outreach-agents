/**
 * Agent 38: SMS Reply Handler — PRODUCT-AWARE
 *
 * SubDraw:  Classifies and responds to GC replies about invoice protection
 * Merchant: Classifies and responds to merchant replies about statement audit / processor match
 *
 * Runs every 2 minutes via orchestrator
 */

require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, logRun, notifyDashboard, pingDashboard } = require('../utils/helpers');
const { isMerchant, PRODUCT } = require('../utils/product-config');

const FROM_SMS    = process.env.FROM_NUMBER       || '+14352911877';
const FROM_VOICE  = process.env.FROM_VOICE_NUMBER || '+14359995348';
const LOCATION_ID = process.env.GHL_LOCATION_ID   || 'oe1TpmlDynQGFNdYLkaK';
const PIPELINE_ID = process.env.GHL_PIPELINE_ID;
const STAGE_REPLIED = process.env.GHL_STAGE_REPLIED;

const handledIds = new Set();
let lastCheckTime = Date.now() - (3 * 60 * 1000);

// ── CLASSIFY SYSTEM ───────────────────────────────────────────────────────────
const CLASSIFY_SYSTEM_MERCHANT = `You are an SMS reply classifier for SpotOn Results — free merchant statement audits and multi-processor payment matching.
A merchant received an outbound SMS about a free statement audit and has texted back.
Classify their reply. Return JSON only.

CATEGORIES:
- "interested"         : wants the audit, positive, asking to see it
- "question_pricing"   : asking about cost, rates, what it costs to switch
- "question_feature"   : asking how the audit works, what we look for, how we match processors
- "question_who"       : who is this, why did you text me, what is SpotOn Results
- "wants_human"        : wants to talk to a real person, asks to call them
- "send_statement"     : they're agreeing to send their statement (high-value — move to pipeline immediately)
- "not_now"            : not the right time, busy, try later
- "unsubscribe"        : STOP, remove me, don't contact, opt out
- "wrong_number"       : wrong person, don't know you
- "auto_reply"         : automated OOO message
- "unclear"            : can't determine intent

Return: { "category": "...", "urgency": "high|medium|low" }`;

const CLASSIFY_SYSTEM_SUBDRAW = `You are an SMS reply classifier for SubDraw — subcontractor invoice protection software for general contractors.
A GC received either an outbound SMS or a voice AI call from SubDraw and is texting back.
Classify their reply. Return JSON only.

CATEGORIES:
- "interested"         : wants to learn more, positive, asking to see it
- "question_pricing"   : asking about cost, plans, price
- "question_feature"   : asking how it works, what it does, specific features
- "question_who"       : who is this, why did you call/text, what is SubDraw
- "wants_human"        : wants to talk to a real person, asks to call them
- "not_now"            : not the right time, busy, try later
- "unsubscribe"        : STOP, remove me, don't contact, opt out
- "wrong_number"       : wrong person, don't know you, never contacted you
- "auto_reply"         : automated message, out of office
- "unclear"            : can't determine intent

Return: { "category": "...", "urgency": "high|medium|low" }`;

// ── RESPOND SYSTEM ────────────────────────────────────────────────────────────
const RESPOND_SYSTEM_MERCHANT = `You are an SMS reply agent for SpotOn Results — free merchant statement audits and multi-processor matching.
A merchant texted back after receiving outreach. Write a reply SMS.

ABOUT SPOTON RESULTS:
- We audit your processing statement free — show you exactly what you're overpaying (usually $200-600/month)
- We work with 6 processors: TSYS, Fiserv, Maverick, NMI, Auth.net, SpotOn
- We match merchants to the right processor for their business type — restaurants go SpotOn, high-volume retail goes TSYS
- Our rate: IC+ 0.20% + $0.20 — one of the most competitive available
- Free audit: spotonresults.com/audit

RULES:
- 1 to 3 sentences MAX — this is SMS, not email
- If they want to send their statement: "Reply with your statement or email it to team@spotonresults.com — we'll turn it around same day."
- If they want a human: "Call or text Shawn at (435) 999-5348"
- If pricing question: "Zero cost for the audit. If we switch you, we earn residual on your processing — you pay nothing upfront."
- Always end with spotonresults.com/audit UNLESS they said STOP/remove
- Sound like a real person — not a bot
Return JSON only: { "message": "..." }`;

const RESPOND_SYSTEM_SUBDRAW = `You are an SMS reply agent for SubDraw — subcontractor invoice protection software for general contractors.
A GC texted back after receiving outreach from SubDraw. Write a reply SMS.

ABOUT SUBDRAW:
- Automatically flags when a sub overbills or bills for incomplete work before the GC pays
- Price: $149/mo up to 10 subs · $299 up to 30 subs · $599 unlimited
- 7-day free trial, no credit card required
- Demo: subdraw.com/login — click "Demo as GC"
- One caught overrun on one job covers years of subscription

RULES:
- 1 to 3 sentences MAX
- If they want a human: "Call or text our team at (435) 999-5348"
- Always end with subdraw.com/login UNLESS they said STOP/remove
- Sound like a real person — not a bot
Return JSON only: { "message": "..." }`;

// ── CLASSIFY ──────────────────────────────────────────────────────────────────
async function classifyReply(body) {
  const system = isMerchant ? CLASSIFY_SYSTEM_MERCHANT : CLASSIFY_SYSTEM_SUBDRAW;
  const label  = isMerchant ? 'SpotOn Results audit outreach' : 'SubDraw outreach';
  const prompt = `Classify this inbound SMS reply to ${label}:\n\n"${body.substring(0, 400)}"\n\nReturn JSON only.`;
  try {
    return JSON.parse(await callClaude(system, prompt, { quality: true, max_tokens: 200 }));
  } catch(e) {
    return { category: 'unclear', urgency: 'medium' };
  }
}

// ── GENERATE RESPONSE ─────────────────────────────────────────────────────────
async function generateResponse(body, category) {
  const system = isMerchant ? RESPOND_SYSTEM_MERCHANT : RESPOND_SYSTEM_SUBDRAW;

  const merchantContextMap = {
    interested:       'They want to see the audit. Confirm and send them to spotonresults.com/audit.',
    question_pricing: 'They asked about cost. Explain: audit is free, you earn residual only if they switch. No upfront cost.',
    question_feature: 'They asked how the audit works. Briefly: send us your last statement, we break down interchange vs markup vs hidden fees.',
    question_who:     'They asked who you are. Introduce SpotOn Results briefly — free statement audits, work with 6 processors.',
    wants_human:      'They want to talk. Give Shawn\'s number: (435) 999-5348.',
    send_statement:   'They\'re ready to send their statement — high priority. Give the email: team@spotonresults.com, or direct to spotonresults.com/audit.',
    not_now:          'They\'re not ready. Acknowledge and offer to follow up in 30 days.',
    unsubscribe:      'They said STOP. Confirm removal — no CTA, no link.',
    wrong_number:     'Apologize briefly for the confusion. No CTA.',
    auto_reply:       'Do not respond.',
    unclear:          'Friendly clarification — what can you help them with.',
  };

  const subdrawContextMap = {
    interested:       'They want to learn more. Confirm and send them the demo link.',
    question_pricing: 'They asked about price. Give the tiers briefly, mention free trial, then demo link.',
    question_feature: 'They asked how SubDraw works. One sentence on invoice flagging, then demo link.',
    question_who:     'They asked who we are. Brief intro — SubDraw catches sub overbilling before you pay them.',
    wants_human:      'They want to talk. Give the number: (435) 999-5348.',
    not_now:          'They\'re not ready. Acknowledge and offer to follow up.',
    unsubscribe:      'They said STOP. Confirm removal — no CTA, no link.',
    wrong_number:     'Apologize for the confusion. No CTA.',
    auto_reply:       'Do not respond.',
    unclear:          'Friendly clarification.',
  };

  const contextMap = isMerchant ? merchantContextMap : subdrawContextMap;
  const context = contextMap[category] || contextMap.unclear;

  const prompt = `The merchant/prospect replied: "${body.substring(0, 300)}"\nCategory: ${category}\nInstruction: ${context}\n\nReturn JSON only: { "message": "..." }`;

  try {
    const raw = await callClaude(system, prompt, { quality: true, max_tokens: 300 });
    const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(clean);
  } catch(e) {
    return { message: null };
  }
}

// ── UPDATE GHL PIPELINE ───────────────────────────────────────────────────────
async function updatePipeline(contactId, category) {
  if (!PIPELINE_ID || !STAGE_REPLIED) return;

  // Move to replied stage on positive signals
  const moveCategories = ['interested', 'question_pricing', 'question_feature', 'wants_human', 'send_statement'];
  if (!moveCategories.includes(category)) return;

  try {
    const opportunities = await callGHL('GET', `/contacts/${contactId}/opportunities`);
    const oppId = opportunities?.opportunities?.[0]?.id;
    if (oppId) {
      await callGHL('PUT', `/opportunities/${oppId}`, { stageId: STAGE_REPLIED });
    }
  } catch(e) {
    console.error('[Agent 38] Pipeline update failed:', e.message);
  }
}

// ── TAG CONTACT ───────────────────────────────────────────────────────────────
async function tagContact(contactId, category, currentTags = []) {
  const prefix = isMerchant ? 'merchant-' : '';
  const tagMap = {
    interested:       `${prefix}sms-interested`,
    question_pricing: `${prefix}sms-interested`,
    send_statement:   `${prefix}sms-send-statement`,
    wants_human:      `${prefix}sms-wants-human`,
    not_now:          `${prefix}sms-not-now`,
    unsubscribe:      'do-not-contact',
    wrong_number:     'do-not-contact',
  };

  const newTag = tagMap[category];
  if (!newTag) return;

  const updatedTags = [...new Set([...currentTags, newTag])];
  await callGHL('PUT', `/contacts/${contactId}`, { tags: updatedTags });
}

// ── FETCH RECENT REPLIES ──────────────────────────────────────────────────────
async function fetchRecentReplies() {
  const now   = Date.now();
  const since = lastCheckTime;
  lastCheckTime = now;

  try {
    // Poll conversations for recent inbound SMS
    const result = await callGHL('GET',
      `/conversations/search?locationId=${LOCATION_ID}&assignedTo=&status=all&sort=desc&sortBy=last_message_date&limit=50`
    );

    const convos = result?.conversations || [];
    const recentInbound = [];

    for (const convo of convos) {
      if (new Date(convo.lastMessageDate).getTime() < since) continue;
      if (convo.lastMessageDirection !== 'inbound') continue;
      if (!convo.lastMessageBody?.trim()) continue;

      const msgId = convo.lastMessageId || convo.id;
      if (handledIds.has(msgId)) continue;

      recentInbound.push({
        id:        msgId,
        contactId: convo.contactId,
        body:      convo.lastMessageBody,
        tags:      convo.tags || [],
      });
    }

    return recentInbound;
  } catch(e) {
    console.error('[Agent 38] fetchRecentReplies error:', e.message);
    return [];
  }
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function pollSMSReplies() {
  await pingDashboard(38, 'ok', `sms-reply-handler tick — PRODUCT=${PRODUCT}`);

  const replies = await fetchRecentReplies();
  if (replies.length === 0) return { handled: 0 };

  console.log(`[Agent 38] ${replies.length} new replies — PRODUCT=${PRODUCT}`);
  let handled = 0;

  for (const reply of replies) {
    handledIds.add(reply.id);

    const { category, urgency } = await classifyReply(reply.body);
    console.log(`[Agent 38] ${reply.contactId} → ${category} (${urgency})`);

    if (category === 'auto_reply') continue;

    // Tag and move pipeline
    await tagContact(reply.contactId, category, reply.tags);
    await updatePipeline(reply.contactId, category);

    // Generate and send response
    const { message } = await generateResponse(reply.body, category);

    if (message && category !== 'unsubscribe' && category !== 'wrong_number') {
      try {
        await callGHL('POST', '/conversations/messages', {
          type:       'SMS',
          contactId:  reply.contactId,
          locationId: LOCATION_ID,
          message,
          fromNumber: FROM_SMS,
        });
        handled++;
      } catch(e) {
        console.error(`[Agent 38] Send failed for ${reply.contactId}: ${e.message}`);
      }
    }

    notifyDashboard('sms_reply_handled', { contactId: reply.contactId, category, product: PRODUCT });
  }

  logRun('38-sms-reply-handler', { handled, total: replies.length, product: PRODUCT });
  return { handled };
}

module.exports = { pollSMSReplies };
