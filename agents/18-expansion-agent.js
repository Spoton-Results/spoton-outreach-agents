/**
 * Agent 18: Expansion Agent
 * When a Starter $149 customer has been active 60+ days, triggers upgrade sequence
 * Identifies usage signals that indicate they need Professional $299 or Scale $599
 * Pure revenue without finding new leads
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are an expansion revenue agent for SubDraw SaaS.
Write upgrade emails for existing customers who have outgrown their current plan.
Sound helpful, not salesy. You're solving a real problem they're hitting.
Reference their specific plan limits. Under 100 words. Return JSON only.`;

async function findUpgradeCandidates() {
  console.log('[Agent 18] Finding upgrade candidates...');

  try {
    const locationId = process.env.GHL_LOCATION_ID || icp.ghl.location_id;
    // Find customers on starter plan for 60+ days
    const contacts = await callGHL('GET', '/contacts/?locationId=' + locationId + '&tags=customer,plan-starter&limit=100');
    const customers = contacts.contacts || [];

    const candidates = customers.filter(c => {
      const daysSinceSignup = Math.floor((Date.now() - new Date(c.dateAdded).getTime()) / (1000 * 60 * 60 * 24));
      return daysSinceSignup >= 60 && !c.tags?.includes('upgrade-email-sent');
    });

    console.log('[Agent 18] Found ' + candidates.length + ' upgrade candidates');
    return candidates;
  } catch(e) {
    console.error('[Agent 18] GHL error:', e.message);
    return [];
  }
}

async function sendUpgradeEmail(contact) {
  const currentPlan = contact.tags?.includes('plan-starter') ? 'Starter $149' : 'Professional $299';
  const upgradeTo = contact.tags?.includes('plan-starter') ? 'Professional $299' : 'Scale $599';

  const prompt = `Write an upgrade email for a SubDraw customer who has been on ${currentPlan} for 60+ days.

Customer: ${contact.firstName} ${contact.lastName} at ${contact.companyName}
Current plan: ${currentPlan}
Upgrade to: ${upgradeTo}

Frame it around what they're likely hitting as limits — more projects, team members, or automation.
Sound helpful. Under 100 words. Include subdraw.com/login to upgrade.

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
      tags: [...(contact.tags || []), 'upgrade-email-sent']
    });
    logRun('18-expansion-agent', { sent_to: contact.email, from_plan: currentPlan, to_plan: upgradeTo });
  } catch(e) {
    console.error('[Agent 18] Error:', e.message);
  }

  return { contact, email };
}

async function runExpansionAgent() {
  const candidates = await findUpgradeCandidates();
  if (!candidates.length) { console.log('[Agent 18] No upgrade candidates today'); return []; }
  return Promise.all(candidates.map(sendUpgradeEmail));
}

module.exports = { runExpansionAgent };
if (require.main === module) runExpansionAgent().then(r => console.log('[Agent 18] Done:', r.length, 'upgrade emails sent'));
