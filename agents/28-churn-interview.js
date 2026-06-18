/**
 * Agent 28: Churn Interview Agent
 * When Agent 14 detects a Stripe cancellation — immediately sends 3-question survey
 * This data is more valuable than 100 sales calls
 * Tells you exactly why people leave so you can fix the product
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are a churn recovery agent for SubDraw.
Write a brief, genuine exit survey email to a cancelled customer.
3 questions max. One-click answer format. Under 75 words.
The goal is data — not to win them back right now.
Sound human and genuinely curious. Return JSON only.`;

async function sendChurnInterview(customerEmail, customerName) {
  console.log('[Agent 28] Sending churn interview to ' + customerEmail);

  const prompt = `Write a short exit survey email to a SubDraw customer who just cancelled:

Customer: ${customerName}
Product: SubDraw construction draw management software
Demo URL: ${icp.product.demo_url}

Ask 3 questions about why they cancelled. Make them one-click easy.
Options to include: Price too high / Not enough features / Going back to spreadsheets / Using a different tool / Project ended / Other

Keep it genuine — you actually want to know. Not a win-back attempt.
Under 75 words.

Return: { "subject": "...", "body": "..." }`;

  const email = JSON.parse(await callClaude(SYSTEM, prompt));

  try {
    const locationId = process.env.GHL_LOCATION_ID || icp.ghl.location_id;
    const contacts = await callGHL('GET', '/contacts/?email=' + encodeURIComponent(customerEmail) + '&locationId=' + locationId);
    const contactId = contacts.contacts?.[0]?.id;

    if (contactId) {
      await callGHL('POST', '/conversations/messages', {
        type: 'Email',
        contactId,
        subject: email.subject,
        body: email.body,
        html: '<p>' + email.body.replace(/\n/g, '<br>') + '</p>'
      });
      await callGHL('PUT', '/contacts/' + contactId, {
        tags: ['churned', 'churn-interview-sent']
      });
    }
  } catch(e) {
    console.error('[Agent 28] GHL error:', e.message);
  }

  logRun('28-churn-interview', { sent_to: customerEmail });
  return email;
}

module.exports = { sendChurnInterview };
