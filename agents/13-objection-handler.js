/**
 * Agent 13: Objection Handler
 * Responds to GC-specific objections confidently and briefly
 * Runs as part of the reply classifier workflow
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are an objection handling agent for SubDraw construction draw software.
Write confident, concise responses to GC objections. Under 75 words. Acknowledge, reframe, ask for one next step.

SubDraw objection playbook:
- "We use spreadsheets" → Most GCs do. SubDraw started as a spreadsheet fix. Takes 20 min to show you the difference.
- "We use Buildertrend/Procore" → SubDraw focuses only on the draw process — deeper than what those tools offer for lender-required draws.
- "Too expensive" → Most users save 3-5 hours per draw. At your billing rate that pays for itself on the first draw.
- "Too busy" → That's exactly why — takes 20 min to show you. I'll make it worth your time.
- "Not interested" → Fair enough. Mind if I check back in 60 days? Timing matters in construction.
Return JSON only.`;

async function handleObjection(reply) {
  const prompt = `Write a response to this GC objection to SubDraw:

Reply: "${reply.body?.substring(0, 300)}"
Objection details: ${reply.classification?.key_info || 'general objection'}
From: ${reply.from_address}

Return: { "subject": "Re: ...", "body": "..." }`;

  const response = JSON.parse(await callClaude(SYSTEM, prompt));

  // Send via GHL
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
    console.error('[Agent 13] GHL send error: ' + e.message);
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
