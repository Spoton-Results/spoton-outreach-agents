/**
 * Agent 23: Partner Outreach Agent
 * Targets construction lenders, title companies, CPAs, surety bond agents
 * ONE partner = 20+ GC referrals. Higher leverage than any cold email campaign.
 * Completely different ICP and pitch from GC direct outreach
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, callInstantly, logRun } = require('../utils/helpers');
const partners = require('../config/partners.json');
const icp = require('../config/icp.json');

const SYSTEM = `You are a partnership outreach agent for SubDraw construction draw software.
Write outreach emails to construction lenders, title companies, and CPAs.
These are NOT end users — they are referral partners who work with many GC clients.
The pitch is: recommend SubDraw to your GC clients, they get a better experience, you get credit.
Professional tone but still conversational. Under 100 words. Return JSON only.`;

async function writePartnerOutreach(partnerType, prospect) {
  const partnerConfig = partners.partner_icp.types.find(t => t.type === partnerType);

  const prompt = `Write a cold email to a ${partnerType.replace(/_/g, ' ')} about referring their GC clients to SubDraw:

Contact: ${prospect.name}, ${prospect.title} at ${prospect.organization_name}
Location: ${prospect.city}, ${prospect.state}
Partner type: ${partnerType}
Their pain: ${partnerConfig?.pain_point}
Our pitch to them: ${partnerConfig?.pitch}
Referral offer: ${partners.partner_icp.referral_offer}
Demo URL: ${partners.partner_icp.partner_demo_url}

This person works WITH general contractors, not as one.
Lead with THEIR problem, not ours.
Under 100 words. Professional.

Return: { "subject": "...", "body": "..." }`;

  return JSON.parse(await callClaude(SYSTEM, prompt));
}

async function runPartnerOutreach(partnerProspects) {
  console.log('[Agent 23] Running partner outreach for ' + partnerProspects.length + ' prospects...');
  const results = [];

  for (const prospect of partnerProspects) {
    const email = await writePartnerOutreach(prospect.partner_type || 'construction_lender', prospect);

    // Log to GHL with partner tag
    try {
      const nameParts = (prospect.name || '').split(' ');
      const contact = await callGHL('POST', '/contacts/', {
        firstName: nameParts[0] || '',
        lastName: nameParts.slice(1).join(' ') || '',
        email: prospect.email,
        companyName: prospect.organization_name || '',
        locationId: process.env.GHL_LOCATION_ID || icp.ghl.location_id,
        tags: ['partner-prospect', prospect.partner_type || 'unknown-partner', 'agent-outreach']
      });

      logRun('23-partner-outreach', { sent_to: prospect.email, partner_type: prospect.partner_type });
    } catch(e) {
      console.error('[Agent 23] GHL error:', e.message);
    }

    results.push({ prospect, email });
  }

  return results;
}

module.exports = { runPartnerOutreach, writePartnerOutreach };
if (require.main === module) console.log('[Agent 23] Partner outreach agent ready. Pass partner prospects to runPartnerOutreach()');
