/**
 * Agent 01: Prospect Finder
 * Searches for General Contractors matching SubDraw ICP
 * Uses Vibe Prospecting API to find CA GCs with active projects
 */
require('dotenv').config({ path: './config/.env' });
const { logRun, callClaude } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are a B2B prospecting agent for SubDraw, a construction draw management SaaS.
SubDraw targets General Contractors who manage construction loans and draws.
Build search queries to find GCs with active projects who still use manual draw processes.
Return JSON only.`;

async function findProspects(options = {}) {
  const { limit = 50, state = 'California' } = options;
  console.log('[Agent 01] Finding GC prospects in ' + state + '...');

  const prompt = `Build the ideal search criteria to find General Contractors in ${state} for SubDraw outreach.
ICP: ${JSON.stringify(icp.ideal_customer_profile, null, 2)}

Return search criteria as JSON:
{
  "titles": [...],
  "industries": [...],
  "state": "${state}",
  "employee_range": "2-150",
  "keywords": ["construction draw", "general contractor", "project management"],
  "exclude_keywords": [...],
  "reasoning": "why these params will find best fit GCs"
}`;

  const criteria = JSON.parse(await callClaude(SYSTEM, prompt));
  logRun('01-prospect-finder', { state, limit, criteria: criteria.reasoning });
  return criteria;
}

module.exports = { findProspects };
if (require.main === module) findProspects().then(console.log);
