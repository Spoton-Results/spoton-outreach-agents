/**
 * Agent 22: Referral Trigger — REBUILT
 * 30-day customers asked for referrals with SubDraw-specific context
 * Highlights: subs join free, which means referred GC's subs come onboard automatically
 * That sub network effect is the best referral hook
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are a referral agent for SubDraw construction draw management software.
Write a short referral request to a happy 30-day customer.

KEY REFERRAL HOOK: SubDraw's subcontractors are always free.
So when a GC refers another GC, any subs they share automatically join the network.
This is genuinely useful to mention — it means less friction for the referred GC.

Be genuine. They've been using it for a month — they know if it works.
Under 75 words. Casual. One ask. Return JSON only.`;

async function findReferralCandidates() {
  console.log('[Agent 22] Finding 30-day customers...');
  try {
    const locationId = process.env.GHL_LOCATION_ID || icp.ghl.location_id;
    const customers = await callGHL('GET', '/contacts/?locationId=' + locationId + '&tags=customer&limit=100');

    return (customers.contacts || []).filter(c => {
      const days = Math.floor((Date.now() - new Date(c.dateAdded).getTime()) / 86400000);
      return days >= 30 && days <= 37 && !c.tags?.includes('referral-asked');
    });
  } catch(e) {
    console.error('[Agent 22] Error:', e.message);
    return [];
  }
}

async function sendReferralAsk(contact) {
  const plan = contact.tags?.find(t => t.startsWith('plan-'))?.replace('plan-', '') || 'starter';
  const planLabel = plan === 'starter' ? 'Starter (10 subs)' : plan === 'professional' ? 'Professional (30 subs)' : 'Scale';

  const prompt = `Write a referral ask for a SubDraw customer — 30 days in, on ${planLabel} plan.

Customer: ${contact.firstName} at ${contact.companyName || 'their company'}
Plan: ${planLabel}
Demo URL: ${icp.product.demo_url}

Mention: any GC they refer gets their first month free. Their subs who are already on SubDraw can immediately work with the referred GC — no re-onboarding.
Casual and genuine. Under 75 words.

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
    logRun('22-referral-trigger', { asked: contact.email, plan });
  } catch(e) {
    console.error('[Agent 22] Error:', e.message);
  }

  return { contact, email };
}

async function runReferralAgent() {
  const candidates = await findReferralCandidates();
  console.log('[Agent 22] ' + candidates.length + ' referral candidates');
  if (!candidates.length) return [];
  return Promise.all(candidates.map(sendReferralAsk));
}

module.exports = { runReferralAgent };
if (require.main === module) runReferralAgent().then(r => console.log('[Agent 22] Done:', r.length));
