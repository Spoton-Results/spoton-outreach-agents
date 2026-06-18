/**
 * Agent 27: Partner Prospector
 * Finds construction lenders, title companies, CPAs to target for partnerships
 * Uses Apollo to search for these multiplier contacts
 * One partner = 20+ GC referrals automatically
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, logRun } = require('../utils/helpers');
const apollo = require('../utils/apollo-client');
const partners = require('../config/partners.json');

const SYSTEM = `You are a partnership development agent for SubDraw.
Find and qualify referral partners — construction lenders, title companies, CPAs.
These are NOT end customers. They work WITH GCs and can refer them to SubDraw.
Return JSON only.`;

async function findPartners(partnerType = 'construction_lender', state = 'California', limit = 20) {
  console.log('[Agent 27] Finding ' + partnerType + ' partners in ' + state + '...');

  const partnerConfig = partners.partner_icp.types.find(t => t.type === partnerType);
  if (!partnerConfig) throw new Error('Unknown partner type: ' + partnerType);

  try {
    const prospects = await apollo.searchPeople({
      titles: partnerConfig.titles,
      state,
      industries: partnerConfig.companies || [partnerType.replace(/_/g, ' ')],
      limit
    });

    // Score and qualify
    const prompt = `Qualify these ${partnerType} contacts as SubDraw referral partners.
We need people who work with multiple General Contractors regularly.

Contacts: ${JSON.stringify(prospects.slice(0, 10).map(p => ({
  name: p.name, title: p.title, company: p.organization_name, location: p.city + ', ' + p.state
})))}

Score each 1-10. High score = works with many GCs, likely to refer.
Return: [{ "name": "...", "score": X, "reason": "..." }]`;

    const scores = JSON.parse(await callClaude(SYSTEM, prompt));
    const qualified = prospects.filter(p => {
      const score = scores.find(s => s.name === p.name);
      return score && score.score >= 7;
    }).map(p => ({ ...p, partner_type: partnerType }));

    logRun('27-partner-prospector', { type: partnerType, found: prospects.length, qualified: qualified.length });
    console.log('[Agent 27] ' + qualified.length + '/' + prospects.length + ' partners qualified');
    return qualified;
  } catch(e) {
    console.error('[Agent 27] Error:', e.message);
    return [];
  }
}

module.exports = { findPartners };
if (require.main === module) findPartners('construction_lender', 'California').then(r => console.log('[Agent 27] Found:', r.length));
