/**
 * Agent 22: Referral Trigger Agent
 * 30 days after upgrade to paid — asks for referral
 * GCs talk to each other constantly. One referral = free pipeline.
 * Runs daily, checks for customers who hit 30-day mark
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are a referral agent for SubDraw construction draw software.
Write a short, genuine referral request to a happy customer.
They've been using SubDraw for 30 days — they know if it works.
Sound human. One ask. Under 75 words. No corporate language.
Return JSON only.`;

async function findReferralCandidates() {
  console.log('[Agent 22] Finding 30-day customers for referral ask...');
  try {
    const locationId = process.env.GHL_LOCATION_ID || icp.ghl.location_id;
    const customers = await callGHL('GET', '/contacts/?locationId=' + locationId + '&tags=customer&limit=100');
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    return (customers.contacts || []).filter(c => {
      const signupDate = new Date(c.dateAdded);
      const daysSince = Math.floor((Date.now() - signupDate.getTime()) / 86400000);
      return daysSince >= 30 && daysSince <= 37 && !c.tags?.includes('referral-asked');
    });
  } catch(e) {
    console.error('[Agent 22] Error:', e.message);
    return [];
  }
}

async function sendReferralAsk(contact) {
  const prompt = `Write a referral request for a SubDraw customer who has been using it for 30 days:

Customer: ${contact.firstName} at ${contact.companyName || 'their company'}
Plan: ${contact.tags?.find(t => t.startsWith('plan-'))?.replace('plan-', '') || 'starter'}
Demo URL: ${icp.product.demo_url}

Ask if they know any other GCs who deal with the same draw headaches.
Offer their referral a free first month.
Keep it casual and genuine — they're a happy customer, not a sales target.
Under 75 words.

Return: { "subject": "...", "body": "..." }`;

  const email = JSON.parse(await callClaude(SYSTEM, prompt));

  try {
    await callGHL('POST', '/conversations/messages', {
      type: 'Email',
      contactId: contact.id,
      subject: email.subject,
      body: email.body,
      html: '<p>' + email.body.replace(/\n/g, '<br>') + '</p>'
    });
    await callGHL('PUT', '/contacts/' + contact.id, {
      tags: [...(contact.tags || []), 'referral-asked']
    });
    logRun('22-referral-trigger', { asked: contact.email, company: contact.companyName });
  } catch(e) {
    console.error('[Agent 22] Error:', e.message);
  }
  return { contact, email };
}

async function runReferralAgent() {
  const candidates = await findReferralCandidates();
  console.log('[Agent 22] ' + candidates.length + ' referral candidates today');
  if (!candidates.length) return [];
  return Promise.all(candidates.map(sendReferralAsk));
}

module.exports = { runReferralAgent };
if (require.main === module) runReferralAgent().then(r => console.log('[Agent 22] Done:', r.length));
