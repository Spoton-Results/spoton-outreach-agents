/**
 * Agent 11: Demo Link Sender — REBUILT
 * Routes interested GCs and feature questions to subdraw.com/login
 * Answers pricing questions with the canonical positioning before sending to demo
 * Never books a call — the product sells itself
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are a response agent for SubDraw — construction draw management and invoice protection.
When a GC replies interested or asks questions, give them exactly what they need and point them to the demo.

SubDraw context you need to know:
- Pricing by active subcontracts: Starter $149/mo (10 subs), Pro $299/mo (30 subs), Scale $599/mo (unlimited)
- Subcontractors are ALWAYS FREE — they submit draw requests and pay apps at no cost
- 7-day free trial — no credit card required to start
- Self-guided demo at subdraw.com/login — they see the full product themselves
- Replaces: spreadsheets, email chains, paper pay apps, manual retainage tracking
- Core workflow: project → subcontractors → contracts → schedule of values → draws → pay apps → approvals → invoices → payments
- Lien waivers, change orders, and supporting docs all managed in one place
- Audit trail on every payment decision

RULES:
- Answer any specific question in 1-2 sentences before pointing to demo
- Never try to book a call
- Under 75 words total
- End with demo link: subdraw.com/login
- Sound human — not a bot auto-response
Return JSON only.`;

async function sendDemoLink(reply) {
  const category = reply.classification?.category;
  const keyInfo = reply.classification?.key_info || '';

  const contextByCategory = {
    'interested': 'They expressed interest. Keep it simple — confirm and get them to the demo.',
    'question_pricing': 'They asked about pricing. Mention: priced by active subcontracts (not users), subcontractors always free, 7-day trial, $149/$299/$599. Then demo.',
    'question_feature': 'They asked about a feature: ' + keyInfo + '. Answer briefly with SubDraw context, then demo.',
    'question_integration': 'They asked about integrations: ' + keyInfo + '. Be honest about what exists, then suggest they see the full product in the demo.',
  };

  const prompt = `Write a reply to this SubDraw outreach response:

Their reply: "${reply.body?.substring(0, 400)}"
From: ${reply.from_address}
Category: ${category}
Context: ${contextByCategory[category] || 'Interested GC — send to demo'}
Demo URL: ${icp.product.demo_url}

Answer their specific question if any, then point to demo.
Under 75 words. Human. No fluff.

Return: { "subject": "Re: ...", "body": "..." }`;

  const email = JSON.parse(await callClaude(SYSTEM, prompt));

  try {
    const locationId = process.env.GHL_LOCATION_ID || icp.ghl.location_id;
    const contacts = await callGHL('GET', '/contacts/?email=' + encodeURIComponent(reply.from_address) + '&locationId=' + locationId);
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
  } catch(e) {
    console.error('[Agent 11] GHL error:', e.message);
  }

  logRun('11-demo-link-sender', { sent_to: reply.from_address, category });
  return { ...reply, demo_email: email };
}

async function sendDemoLinks(classified) {
  const targets = classified.filter(r => [
    'interested',
    'question_pricing',
    'question_feature',
    'question_integration'
  ].includes(r.classification?.category));

  console.log('[Agent 11] Sending demo links to ' + targets.length + ' replies...');
  return Promise.all(targets.map(sendDemoLink));
}

module.exports = { sendDemoLinks };
