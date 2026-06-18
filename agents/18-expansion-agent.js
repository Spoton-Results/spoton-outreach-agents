/**
 * Agent 18: Expansion Agent — REBUILT
 * Upgrade triggers based on SubDraw's actual plan limits
 * Starter (10 subs) → Professional (30 subs) when they're near the limit
 * Professional (30 subs) → Scale (unlimited) when they're running multiple large projects
 * Pricing model: active subcontracts, not users
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are an expansion revenue agent for SubDraw construction draw management software.
Write upgrade emails for customers who have outgrown their current plan.
SubDraw pricing is based on active subcontracts — not users, not seats.

Plan limits:
- Starter $149/mo: up to 10 active subcontracts
- Professional $299/mo: up to 30 active subcontracts
- Scale $599/mo: unlimited active subcontracts

Subcontractors are always free on all plans.
All features included on every plan — upgrade just unlocks more active subcontracts.

Sound helpful — they're hitting a real limit, not being upsold.
Under 100 words. Return JSON only.`;

async function findUpgradeCandidates() {
  console.log('[Agent 18] Finding upgrade candidates...');
  try {
    const locationId = process.env.GHL_LOCATION_ID || icp.ghl.location_id;

    // Starter customers nearing 10-sub limit (60+ days, active)
    const starterContacts = await callGHL('GET', '/contacts/?locationId=' + locationId + '&tags=customer,plan-starter&limit=100');
    const starterCandidates = (starterContacts.contacts || []).filter(c => {
      const days = Math.floor((Date.now() - new Date(c.dateAdded).getTime()) / 86400000);
      return days >= 60 && !c.tags?.includes('upgrade-email-sent');
    }).map(c => ({ ...c, from_plan: 'Starter ($149/mo, 10 subs)', to_plan: 'Professional ($299/mo, 30 subs)', upgrade_reason: 'approaching 10-subcontract limit' }));

    // Professional customers nearing 30-sub limit (90+ days, active)
    const proContacts = await callGHL('GET', '/contacts/?locationId=' + locationId + '&tags=customer,plan-professional&limit=100');
    const proCandidates = (proContacts.contacts || []).filter(c => {
      const days = Math.floor((Date.now() - new Date(c.dateAdded).getTime()) / 86400000);
      return days >= 90 && !c.tags?.includes('upgrade-email-sent');
    }).map(c => ({ ...c, from_plan: 'Professional ($299/mo, 30 subs)', to_plan: 'Scale ($599/mo, unlimited)', upgrade_reason: 'growing project count and subcontractor volume' }));

    const candidates = [...starterCandidates, ...proCandidates];
    console.log('[Agent 18] ' + candidates.length + ' upgrade candidates');
    return candidates;
  } catch(e) {
    console.error('[Agent 18] Error:', e.message);
    return [];
  }
}

async function sendUpgradeEmail(contact) {
  const prompt = `Write an upgrade email for this SubDraw customer:

Customer: ${contact.firstName} ${contact.lastName} at ${contact.companyName}
Current plan: ${contact.from_plan}
Upgrading to: ${contact.to_plan}
Upgrade reason: ${contact.upgrade_reason}
Demo URL: ${icp.product.demo_url}

Frame it around the subcontract limit they're approaching.
SubDraw pricing is per active subcontracts — all features are already included.
The upgrade just unlocks more active subcontracts.
Sound helpful — they need more capacity, not a sales pitch.
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
    await callGHL('PUT', '/contacts/' + contact.id, {
      tags: [...(contact.tags || []), 'upgrade-email-sent']
    });
    logRun('18-expansion-agent', { sent_to: contact.email, from: contact.from_plan, to: contact.to_plan });
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
if (require.main === module) runExpansionAgent().then(r => console.log('[Agent 18] Done:', r.length));
