/**
 * Agent 02: Pre-Screener
 * Filters out bad-fit GCs before any outreach
 * Key: Only target GCs who actually manage construction draws (not trade-only)
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are a lead qualification agent for SubDraw construction draw software.
SubDraw is ONLY useful for General Contractors who:
1. Manage construction loans with lender draw requests
2. Coordinate payments to subcontractors
3. Track retainage and lien waivers
4. Have at least 1 active construction project

Disqualify: trade-only subs, handymen, no GC license, purely government work, already on Procore.
Score 1-10. Return JSON only.`;

async function screenProspects(prospects) {
  console.log('[Agent 02] Screening ' + prospects.length + ' prospects...');
  const screened = [];

  for (let i = 0; i < prospects.length; i += 10) {
    const batch = prospects.slice(i, i + 10);
    const prompt = `Screen these GC prospects for SubDraw. Only qualify true General Contractors who manage draws.

Prospects: ${JSON.stringify(batch.map(p => ({
  id: p.id,
  name: p.name,
  title: p.title,
  company: p.organization_name,
  industry: p.industry,
  employees: p.employees,
  location: p.city + ', ' + p.state
})))}

Disqualifiers: ${JSON.stringify(icp.ideal_customer_profile.disqualifiers)}

Return JSON array: [{ "id": "...", "score": 1-10, "verdict": "qualified|disqualified", "reason": "...", "recommended_plan": "starter_149|professional_299|scale_599", "pain_point": "most likely draw pain point" }]`;

    const results = JSON.parse(await callClaude(SYSTEM, prompt));
    results.forEach(r => {
      if (r.verdict === 'qualified' && r.score >= 6) {
        const prospect = batch.find(p => p.id === r.id);
        if (prospect) screened.push({ ...prospect, screening: r });
      }
    });
  }

  logRun('02-pre-screener', { input: prospects.length, passed: screened.length });
  console.log('[Agent 02] ' + screened.length + '/' + prospects.length + ' passed');
  return screened;
}

module.exports = { screenProspects };
