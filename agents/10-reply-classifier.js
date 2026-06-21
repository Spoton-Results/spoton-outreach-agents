/**
 * Agent 10: Reply Classifier — REBUILT
 * Classifies replies with SubDraw-specific context
 * Knows the difference between "price objection" and "feature question"
 * Routes each to the right response agent
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callInstantly, callGHL, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are a reply classification agent for SubDraw sales outreach to General Contractors.
SubDraw is a construction draw management and invoice protection platform.
Classify each reply and route it to the correct response. Return JSON only.

CATEGORIES:
- "interested": wants to learn more, asks to see it, positive engagement
- "not_now": too busy right now, wrong timing, try me in X months
- "wrong_person": not the decision maker, tells you who is
- "unsubscribe": stop emailing, remove me, not interested at all
- "question_pricing": asking about cost, plans, what's included
- "question_feature": asking about specific features (retainage, lien waivers, pay apps, etc)
- "question_integration": asking about QuickBooks, accounting software, Procore
- "objection_price": too expensive, can't justify cost
- "objection_competitor": happy with Procore / Buildertrend / spreadsheets
- "objection_timing": not the right time, busy season, wait until next project
- "objection_size": too small, only have 1-2 subs
- "auto_reply": out of office, automated response

SubDraw-specific context for classification:
- Pricing by active subcontracts (not users) — $149/$299/$599
- Subcontractors are always free
- 7-day free trial at subdraw.com/login
- Replaces spreadsheets and email chains for sub billing`;

async function classifyReplies() {
  console.log('[Agent 10] Checking Instantly for new replies...');

  try {
    const campaignId = process.env.INSTANTLY_CAMPAIGN_ID || icp.instantly.campaign_id;
    const repliesData = await callInstantly('GET', '/unibox/emails?campaign_id=' + campaignId + '&limit=50');
    const replies = repliesData.emails || [];

    if (!replies.length) {
      console.log('[Agent 10] No new replies');
      return [];
    }

    console.log('[Agent 10] Classifying ' + replies.length + ' replies...');
    const classified = [];

    for (const reply of replies) {
      const prompt = `Classify this reply to a SubDraw cold email:

From: ${reply.from_address}
Subject: ${reply.subject}
Body: ${reply.body?.substring(0, 600)}

Return: {
  "category": "interested|not_now|wrong_person|unsubscribe|question_pricing|question_feature|question_integration|objection_price|objection_competitor|objection_timing|objection_size|auto_reply",
  "sentiment": "positive|neutral|negative",
  "urgency": "high|medium|low",
  "next_action": "send_demo_link|handle_objection|answer_question|follow_up_in_X_days|find_right_contact|unsubscribe|ignore",
  "follow_up_days": null or number,
  "key_info": "extracted details — competitor named, question asked, right contact name, specific objection",
  "subdraw_relevance": "what aspect of SubDraw is most relevant to their reply"
}`;

      const classification = JSON.parse(await callClaude(SYSTEM, prompt));

      // Update GHL pipeline stage for engaged replies
      const engagedCategories = ['interested','question_pricing','question_feature','question_integration','objection_price','objection_competitor','objection_timing'];
      if (engagedCategories.includes(classification.category)) {
        try {
          const locationId = process.env.GHL_LOCATION_ID || icp.ghl.location_id;
          const contacts = await callGHL('GET', '/contacts/?email=' + encodeURIComponent(reply.from_address) + '&locationId=' + locationId);
          const contactId = contacts.contacts?.[0]?.id;
          if (contactId) {
            const opps = await callGHL('GET', '/opportunities/search?contact_id=' + contactId + '&pipeline_id=' + (process.env.GHL_PIPELINE_ID || icp.ghl.pipeline_id));
            const oppId = opps.opportunities?.[0]?.id;
            if (oppId) {
              await callGHL('PUT', '/opportunities/' + oppId, {
                pipelineStageId: process.env.GHL_STAGE_REPLIED || icp.ghl.stages.replied
              });
            }
            // Tag with reply type
            await callGHL('PUT', '/contacts/' + contactId, {
              tags: ['replied', 'reply-' + classification.category]
            });
          }
        } catch(e) {
          console.error('[Agent 10] GHL update error:', e.message);
        }
      }

      // Schedule follow-up for not_now replies — Agent 32
      if (classification.category === 'not_now') {
        try {
          const { scheduleFollowUp } = require('./32-followup-scheduler');
          await scheduleFollowUp({ ...reply, classification });
        } catch(e) {
          console.error('[Agent 10] Follow-up scheduler error:', e.message);
        }
      }

      // Handle unsubscribes in Instantly
      if (classification.category === 'unsubscribe') {
        try {
          await callInstantly('POST', '/lead/update', {
            campaign_id: campaignId,
            email: reply.from_address,
            skip: true
          });
        } catch(e) { console.error('[Agent 10] Unsubscribe error:', e.message); }
      }

      classified.push({ ...reply, classification });
    }

    const summary = classified.reduce((acc, r) => {
      acc[r.classification.category] = (acc[r.classification.category] || 0) + 1;
      return acc;
    }, {});

    require('../utils/helpers').notifyDashboard('reply', { contact: reply.from_address, category: classification.category });
    logRun('10-reply-classifier', { total: replies.length, breakdown: summary });
    console.log('[Agent 10] Classified:', summary);
    return classified;
  } catch(e) {
    console.error('[Agent 10] Error:', e.message);
    return [];
  }
}


/**
 * Classify a single reply in real-time (for event-driven server)
 * Called by reply-server.js immediately when webhook fires
 */
async function classifySingleReply(reply) {
  const body = reply.body || '';
  const subject = reply.subject || '';
  const source = reply.source || 'email';

  const prompt = `Classify this ${source} reply from a General Contractor to a SubDraw outreach.

Reply:
Subject: ${subject}
Message: ${body}

Return JSON only:
{
  "category": "one of the 12 categories",
  "confidence": "high|medium|low",
  "note": "brief note on why + any key info (date mentioned, competitor named, question asked)",
  "follow_up_date": "ISO date string if they mentioned a specific time, else null",
  "urgency": "high|medium|low"
}`;

  try {
    const result = JSON.parse(await callClaude(SYSTEM, prompt));
    return result;
  } catch(e) {
    return { category: 'interested', confidence: 'low', note: 'Parse error — defaulting to interested', follow_up_date: null, urgency: 'medium' };
  }
}

module.exports = { classifyReplies, classifySingleReply };
if (require.main === module) classifyReplies().then(r => console.log('[Agent 10] Done:', r.length, 'replies'));
