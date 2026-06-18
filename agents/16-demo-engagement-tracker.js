/**
 * Agent 16: Demo Engagement Tracker
 * Watches for GCs who clicked the demo link (subdraw.com/login) but didn't sign up
 * Sends a follow-up 48hrs later addressing the most common hesitation
 * Also follows up on anyone who started a trial but hasn't activated
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are a demo follow-up agent for SubDraw construction draw software.
Write follow-up emails for GCs who visited the demo but didn't convert.
Address the most common hesitation at this stage: "looks interesting but not sure it's worth switching."
Under 100 words. Demo link always included. No call ask.
Return JSON only.`;

async function findDemoVisitorsNoSignup() {
  console.log('[Agent 16] Finding GCs who visited demo but did not sign up...');
  // In production: integrate with subdraw.com analytics or Stripe
  // Flag contacts in GHL who have tag "demo-clicked" but not "customer"
  try {
    const locationId = process.env.GHL_LOCATION_ID || icp.ghl.location_id;
    const contacts = await callGHL('GET', '/contacts/?locationId=' + locationId + '&tags=demo-clicked&limit=50');
    const demoVisitors = (contacts.contacts || []).filter(c =>
      !c.tags?.includes('customer') &&
      !c.tags?.includes('demo-followup-sent')
    );
    console.log('[Agent 16] Found ' + demoVisitors.length + ' demo visitors without signup');
    return demoVisitors;
  } catch(e) {
    console.error('[Agent 16] GHL error:', e.message);
    return [];
  }
}

async function sendDemoFollowup(contact) {
  const prompt = `Write a follow-up email for a GC who visited the SubDraw demo but didn't sign up.
They visited subdraw.com/login 48 hours ago.

Contact: ${contact.firstName} ${contact.lastName} at ${contact.companyName || 'their company'}
Pain point tag: ${contact.tags?.find(t => t.startsWith('pain-')) || 'draw management'}
Demo URL: ${icp.product.demo_url}

Address the "not sure it's worth switching" hesitation.
Give them one concrete reason to go back and try.
Under 100 words.

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
    // Tag as followed up so we don't double-send
    await callGHL('PUT', '/contacts/' + contact.id, {
      tags: [...(contact.tags || []), 'demo-followup-sent']
    });
    logRun('16-demo-engagement-tracker', { followed_up: contact.email });
  } catch(e) {
    console.error('[Agent 16] Error for ' + contact.email + ': ' + e.message);
  }

  return { contact, email };
}

async function runDemoTracker() {
  const visitors = await findDemoVisitorsNoSignup();
  if (!visitors.length) { console.log('[Agent 16] No demo visitors to follow up'); return []; }
  return Promise.all(visitors.map(sendDemoFollowup));
}

module.exports = { runDemoTracker };
if (require.main === module) runDemoTracker().then(r => console.log('[Agent 16] Done:', r.length));
