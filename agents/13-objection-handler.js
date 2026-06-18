/**
 * Agent 13: Objection Handler — REBUILT
 * Handles all 5 SubDraw-specific objection types from Agent 10
 * Invoice protection angle built into every response
 * Routes to demo — never to a call
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are an objection handling agent for SubDraw — construction draw management and invoice protection.

OBJECTION PLAYBOOK:

PRICE OBJECTION ($149 too expensive):
→ "If SubDraw catches one invoice overrun this year, it paid for itself completely. Most GCs find it on the first draw cycle. Try it free — subdraw.com/login"

COMPETITOR OBJECTION (happy with spreadsheets):
→ "Spreadsheets don't flag when a sub bills more than their approved schedule of values. SubDraw does. 8 minutes to see the difference — subdraw.com/login"

COMPETITOR OBJECTION (Procore/Buildertrend):
→ "Those tools aren't built around lender draw requests and sub pay applications. SubDraw is. Worth seeing — subdraw.com/login"

TIMING OBJECTION (too busy, not now):
→ "Makes sense. The GCs who set it up mid-project say it's worth it — they catch billing errors in real time instead of at closeout. Free trial whenever you're ready — subdraw.com/login"

SIZE OBJECTION (too small, only 1-2 subs):
→ "That's actually when it matters most. One invoice overrun on a small project hurts more than on a big one. Starter plan is $149 — subdraw.com/login"

RULES:
- Under 75 words
- Always end with subdraw.com/login
- Acknowledge their point first — never dismiss it
- Lead with the financial protection angle
- Never ask for a call
Return JSON only.`;

async function handleObjection(reply) {
  const category = reply.classification?.category;
  const keyInfo = reply.classification?.key_info || '';

  const prompt = `Handle this SubDraw objection:

Reply: "${reply.body?.substring(0, 400)}"
Objection type: ${category}
Specific objection details: ${keyInfo}
From: ${reply.from_address}
Demo URL: ${icp.product.demo_url}

Use the objection playbook. Acknowledge → reframe with invoice protection angle → demo link.
Under 75 words.

Return: { "subject": "Re: ...", "body": "..." }`;

  const response = JSON.parse(await callClaude(SYSTEM, prompt));

  try {
    const locationId = process.env.GHL_LOCATION_ID || icp.ghl.location_id;
    const contacts = await callGHL('GET', '/contacts/?email=' + encodeURIComponent(reply.from_address) + '&locationId=' + locationId);
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
  } catch(e) {
    console.error('[Agent 13] GHL error:', e.message);
  }

  logRun('13-objection-handler', { handled: reply.from_address, type: category });
  return { ...reply, response_email: response };
}

async function handleObjections(classified) {
  const objectionCategories = [
    'objection_price',
    'objection_competitor',
    'objection_timing',
    'objection_size'
  ];
  const objections = classified.filter(r => objectionCategories.includes(r.classification?.category));
  console.log('[Agent 13] Handling ' + objections.length + ' objections...');
  return Promise.all(objections.map(handleObjection));
}

module.exports = { handleObjections };
