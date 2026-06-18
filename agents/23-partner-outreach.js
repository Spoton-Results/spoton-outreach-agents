/**
 * Agent 23: Partner Outreach — REBUILT
 * Lender pitch now leads with draw audit trail and portfolio visibility
 * CPA pitch now leads with cleaner books and reconciliation
 * Title company pitch now leads with documentation completeness at closing
 * All based on SubDraw's actual feature set from the canonical doc
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, logRun } = require('../utils/helpers');
const partners = require('../config/partners.json');
const icp = require('../config/icp.json');

const SYSTEM = `You are a partnership outreach agent for SubDraw — construction draw management and invoice protection.

SubDraw's relevant features for each partner type:

FOR CONSTRUCTION LENDERS:
- Complete audit history of every draw approval and payment decision
- Lender-ready draw packages — documentation organized automatically
- Real-time draw status across their entire GC portfolio
- Pay applications reviewed and approved before funds are requested
- Lien waiver collection built into the workflow
- Change orders tracked and documented

FOR TITLE COMPANIES:
- All supporting documents (lien waivers, invoices, photos) uploaded by subs directly
- Complete payment history and audit trail
- Retainage tracking with automatic calculation
- No more chasing GCs for missing documentation at closing

FOR CONSTRUCTION CPAs:
- Automatic retainage calculation and tracking
- Invoice and pay application records exportable
- Complete audit trail for every billing decision
- Change orders documented with approval history
- Cleaner job costing data — subs bill against approved schedule of values

RULES:
- Lead with THEIR problem, not SubDraw's features
- Professional but conversational
- Under 100 words
- Partner demo URL: subdraw.com/login
Return JSON only.`;

async function writePartnerOutreach(partnerType, prospect) {
  const partnerConfig = partners.partner_icp.types.find(t => t.type === partnerType);

  const prompt = `Write a cold email to a ${partnerType.replace(/_/g,'  ')} about SubDraw as a tool for their GC clients:

Contact: ${prospect.name}, ${prospect.title} at ${prospect.organization_name}
Location: ${prospect.city}, ${prospect.state}
Their pain point: ${partnerConfig?.pain_point}
What SubDraw gives them: ${partnerConfig?.pitch}
Referral offer: ${partners.partner_icp.referral_offer}

Lead with THEIR frustration with GC clients — not SubDraw features.
Then show how SubDraw fixes it for their GC clients AND for them.
End with the referral offer and demo URL.
Under 100 words.

Return: { "subject": "...", "body": "..." }`;

  return JSON.parse(await callClaude(SYSTEM, prompt));
}

async function runPartnerOutreach(partnerProspects) {
  console.log('[Agent 23] Running partner outreach for ' + partnerProspects.length + ' prospects...');
  const results = [];

  for (const prospect of partnerProspects) {
    const email = await writePartnerOutreach(prospect.partner_type || 'construction_lender', prospect);

    try {
      const nameParts = (prospect.name || '').split(' ');
      await callGHL('POST', '/contacts/', {
        firstName: nameParts[0] || '',
        lastName: nameParts.slice(1).join(' ') || '',
        email: prospect.email,
        phone: prospect.phone || '',
        companyName: prospect.organization_name || '',
        locationId: process.env.GHL_LOCATION_ID || icp.ghl.location_id,
        tags: ['partner-prospect', prospect.partner_type || 'unknown-partner', 'agent-outreach'],
        source: 'SubDraw Partner Outreach'
      });
    } catch(e) {
      console.error('[Agent 23] GHL error:', e.message);
    }

    logRun('23-partner-outreach', { sent_to: prospect.email, partner_type: prospect.partner_type });
    results.push({ prospect, email });
  }

  return results;
}

module.exports = { runPartnerOutreach, writePartnerOutreach };
