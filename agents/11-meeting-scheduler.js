/**
 * Agent 11: Meeting Scheduler
 * Responds to interested GCs with a demo booking email
 * Sends via GHL so it's tracked in the pipeline
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are a meeting scheduling agent for SubDraw.
Write a brief, friendly reply to book a 20-minute product demo with a General Contractor.
Sound like a real person — not a bot. Under 75 words.
Include [CALENDLY_LINK] placeholder for the booking link.
Return JSON only.`;

async function scheduleDemo(reply) {
  const prompt = `Write a demo scheduling reply for this interested GC:

Their reply: "${reply.body?.substring(0, 300)}"
From: ${reply.from_address}
Key info: ${reply.classification?.key_info || ''}

Write a short reply to book a 20-minute SubDraw demo.
Mention it takes 20 min and they will see exactly how draws work in the platform.

Return: { "subject": "Re: ...", "body": "..." }`;

  const email = JSON.parse(await callClaude(SYSTEM, prompt));

  // Send via GHL
  try {
    const contacts = await callGHL('GET', '/contacts/?email=' + encodeURIComponent(reply.from_address) + '&locationId=' + (process.env.GHL_LOCATION_ID || icp.ghl.location_id));
    const contactId = contacts.contacts?.[0]?.id;
    if (contactId) {
      await callGHL('POST', '/conversations/messages', {
        type: 'Email',
        contactId,
        subject: email.subject,
        body: email.body,
        html: '<p>' + email.body.replace(/\n/g, '<br>') + '</p>'
      });
    }
  } catch (e) {
    console.error('[Agent 11] GHL send error: ' + e.message);
  }

  logRun('11-meeting-scheduler', { sent_to: reply.from_address });
  return { ...reply, demo_email: email };
}

async function processInterestedReplies(classified) {
  const interested = classified.filter(r =>
    r.classification?.category === 'interested' ||
    r.classification?.category === 'question'
  );
  console.log('[Agent 11] Scheduling demos for ' + interested.length + ' interested replies...');
  return Promise.all(interested.map(scheduleDemo));
}

module.exports = { processInterestedReplies };
