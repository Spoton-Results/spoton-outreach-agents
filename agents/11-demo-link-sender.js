/**
 * Agent 11: Demo Link Sender
 * Replaces Meeting Scheduler — no calls needed
 * When a GC replies interested or asks a question, sends them straight to the demo
 * Personalized email that frames the demo around their specific pain point
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are a response agent for SubDraw construction draw software.
When a GC replies interested or asks a question, send them to the self-guided demo.
The demo is at subdraw.com/login — they create a free account and see the full product.
Write a brief, warm reply under 75 words that:
1. Acknowledges what they said
2. Answers any specific question briefly
3. Points them to the demo with a construction-specific frame
Never try to book a call. The product sells itself.
Return JSON only.`;

async function sendDemoLink(reply) {
  const prompt = `Write a reply sending this interested GC to the SubDraw demo:

Their reply: "${reply.body?.substring(0, 300)}"
From: ${reply.from_address}
Category: ${reply.classification?.category}
Key info: ${reply.classification?.key_info || ''}
Demo URL: ${icp.product.demo_url}

Frame the demo around their specific situation.
If they asked about price — mention the free trial first, pricing inside.
If they asked about features — tell them to see it live in the demo.
If they just said interested — keep it simple and get them to click.

Return: { "subject": "Re: ...", "body": "..." }`;

  const email = JSON.parse(await callClaude(SYSTEM, prompt));

  // Send via GHL
  try {
    const locationId = process.env.GHL_LOCATION_ID || icp.ghl.location_id;
    const contacts = await callGHL('GET', '/contacts/?email=' + encodeURIComponent(reply.from_address) + '&locationId=' + locationId);
    const contactId = contacts.contacts?.[0]?.id;
    if (contactId) {
      await callGHL('POST', '/conversations/messages', {
        type: 'Email',
        contactId,
        subject: email.subject,
        body: email.body,
        html: '<p>' + email.body.replace(/\n/g, '<br>') + '</p>'
      });
      // Update GHL stage to Replied
      const opps = await callGHL('GET', '/opportunities/search?contact_id=' + contactId);
      const oppId = opps.opportunities?.[0]?.id;
      if (oppId) {
        await callGHL('PUT', '/opportunities/' + oppId, {
          pipelineStageId: process.env.GHL_STAGE_REPLIED || icp.ghl.stages.replied
        });
      }
    }
  } catch (e) {
    console.error('[Agent 11] GHL error: ' + e.message);
  }

  logRun('11-demo-link-sender', { sent_to: reply.from_address });
  return { ...reply, demo_email: email };
}

async function sendDemoLinks(classified) {
  const targets = classified.filter(r =>
    r.classification?.category === 'interested' ||
    r.classification?.category === 'question'
  );
  console.log('[Agent 11] Sending demo links to ' + targets.length + ' replies...');
  return Promise.all(targets.map(sendDemoLink));
}

module.exports = { sendDemoLinks };
