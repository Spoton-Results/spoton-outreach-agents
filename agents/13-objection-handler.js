/**
 * Agent 13: Objection Handler
 * Handles GC objections and routes them to the demo — no calls
 * Answer the objection briefly, then get them to subdraw.com/login
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are an objection handling agent for SubDraw construction draw software.
Handle the objection briefly and confidently, then point them to the free demo.
Under 75 words. Never try to book a call. The demo closes the deal.

SubDraw objection playbook:
- "We use spreadsheets" → Most GCs do. That's exactly what SubDraw replaces. See it in 8 min — subdraw.com/login
- "We use Buildertrend/Procore" → Those tools aren't built around lender draw requests. SubDraw is. Worth 8 minutes — subdraw.com/login
- "Too expensive" → Free to try. Most users save more than $149 on the first draw cycle alone — subdraw.com/login
- "Too busy" → Built for that. No call, no demo request. See the whole thing yourself in 8 min — subdraw.com/login
- "Not interested" → Fair. If draw management ever becomes a headache, we'll be here — subdraw.com/login
Return JSON only.`;

async function handleObjection(reply) {
  const prompt = `Handle this GC objection and point them to the SubDraw demo:

Reply: "${reply.body?.substring(0, 300)}"
Objection: ${reply.classification?.key_info || 'general objection'}
From: ${reply.from_address}
Demo URL: ${icp.product.demo_url}

Acknowledge, reframe briefly, end with demo link. No call ask.

Return: { "subject": "Re: ...", "body": "..." }`;

  const response = JSON.parse(await callClaude(SYSTEM, prompt));

  try {
    const contacts = await callGHL('GET', '/contacts/?email=' + encodeURIComponent(reply.from_address) + '&locationId=' + (process.env.GHL_LOCATION_ID || icp.ghl.location_id));
    const contactId = contacts.contacts?.[0]?.id;
    if (contactId) {
      await callGHL('POST', '/conversations/messages', {
        type: 'Email',
        contactId,
        subject: response.subject,
        body: response.body,
        html: '<p>' + response.body.replace(/\n/g, '<br>') + '</p>'
      });
    }
  } catch (e) {
    console.error('[Agent 13] GHL error: ' + e.message);
  }

  logRun('13-objection-handler', { handled_for: reply.from_address });
  return { ...reply, response_email: response };
}

async function handleObjections(classified) {
  const objections = classified.filter(r => r.classification?.category === 'objection');
  console.log('[Agent 13] Handling ' + objections.length + ' objections...');
  return Promise.all(objections.map(handleObjection));
}

module.exports = { handleObjections };
