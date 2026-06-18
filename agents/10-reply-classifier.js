/**
 * Agent 10: Reply Classifier
 * Reads Instantly replies and routes them to the right action
 * Runs every 30 minutes on Railway cron
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callInstantly, callGHL, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are a reply classification agent for SubDraw sales outreach to General Contractors.
Classify each email reply and determine the next action. Return JSON only.

Categories:
- "interested": wants to learn more, asks questions, agrees to call
- "not_now": too busy, wrong timing, follow up later
- "wrong_person": not decision maker, refer to someone else
- "unsubscribe": remove me, not interested, stop emailing
- "question": specific question about SubDraw features or pricing
- "objection": has specific objection (price, already has tool, no time)
- "auto_reply": out of office, automated response`;

async function classifyReplies() {
  console.log('[Agent 10] Checking Instantly for new replies...');

  // Fetch unread replies from Instantly
  const repliesData = await callInstantly('GET', '/email/list?campaign_id=' + (process.env.INSTANTLY_CAMPAIGN_ID || icp.instantly.campaign_id) + '&limit=50');
  const replies = repliesData.emails || [];

  if (replies.length === 0) {
    console.log('[Agent 10] No new replies');
    return [];
  }

  console.log('[Agent 10] Classifying ' + replies.length + ' replies...');
  const classified = [];

  for (const reply of replies) {
    const prompt = `Classify this reply to a SubDraw cold email targeting a General Contractor:

From: ${reply.from_address}
Subject: ${reply.subject}
Body: ${reply.body?.substring(0, 500)}

Return: {
  "category": "interested|not_now|wrong_person|unsubscribe|question|objection|auto_reply",
  "sentiment": "positive|neutral|negative",
  "urgency": "high|medium|low",
  "next_action": "book_demo|follow_up_in_X_days|find_decision_maker|unsubscribe|answer_question|handle_objection|ignore",
  "follow_up_days": null or number,
  "key_info": "any extracted info — right contact name, objection details, question asked",
  "ghl_stage": "replied"
}`;

    const classification = JSON.parse(await callClaude(SYSTEM, prompt));

    // Update GHL stage to Replied for interested/question/objection
    if (['interested','question','objection'].includes(classification.category)) {
      try {
        const contacts = await callGHL('GET', '/contacts/?email=' + encodeURIComponent(reply.from_address) + '&locationId=' + (process.env.GHL_LOCATION_ID || icp.ghl.location_id));
        const contactId = contacts.contacts?.[0]?.id;
        if (contactId) {
          // Find their opportunity and update stage
          const opps = await callGHL('GET', '/opportunities/search?contact_id=' + contactId + '&pipeline_id=' + (process.env.GHL_PIPELINE_ID || icp.ghl.pipeline_id));
          const oppId = opps.opportunities?.[0]?.id;
          if (oppId) {
            await callGHL('PUT', '/opportunities/' + oppId, {
              pipelineStageId: process.env.GHL_STAGE_REPLIED || icp.ghl.stages.replied
            });
          }
        }
      } catch (e) {
        console.error('[Agent 10] GHL update error: ' + e.message);
      }
    }

    classified.push({ ...reply, classification });
  }

  logRun('10-reply-classifier', {
    total: replies.length,
    interested: classified.filter(r => r.classification.category === 'interested').length,
    questions: classified.filter(r => r.classification.category === 'question').length,
    objections: classified.filter(r => r.classification.category === 'objection').length,
    unsubscribes: classified.filter(r => r.classification.category === 'unsubscribe').length
  });

  return classified;
}

module.exports = { classifyReplies };
if (require.main === module) classifyReplies().then(r => console.log('Done:', r.length, 'replies processed'));
