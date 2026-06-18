/**
 * Agent 03: Competitive Intel
 * What draw management tools is this GC currently using?
 * Procore, Buildertrend, spreadsheets, email, Sage, custom?
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, logRun } = require('../utils/helpers');

const SYSTEM = `You are a competitive intelligence agent for SubDraw.
Analyze a General Contractor and estimate their current draw management process.
Most small-to-mid GCs use spreadsheets and email — that is SubDraw's primary target.
Return JSON only.`;

async function gatherIntel(prospect) {
  const prompt = `Analyze this GC and estimate their current draw management process:

Company: ${prospect.organization_name}
Size: ${prospect.employees} employees
Location: ${prospect.city}, ${prospect.state}
Website: ${prospect.website || 'unknown'}

Based on company size and type, estimate:
1. Current draw tool (Procore, Buildertrend, spreadsheets/email, Sage 300, custom, unknown)
2. Project volume (1-3 / 4-10 / 10+ active projects)
3. Likely pain (slow approvals / lien waiver chaos / retainage errors / no visibility)
4. Switching likelihood (high if spreadsheets, low if Procore power user)
5. Best plan fit based on size

Return: {
  "current_tool": "...",
  "project_volume": "1-3|4-10|10+",
  "primary_pain": "one sentence",
  "switching_likelihood": "high|medium|low",
  "recommended_plan": "starter_149|professional_299|scale_599",
  "approach_angle": "best angle to lead with"
}`;

  return JSON.parse(await callClaude(SYSTEM, prompt));
}

async function gatherIntelBatch(prospects) {
  console.log('[Agent 03] Gathering intel on ' + prospects.length + ' GCs...');
  const enriched = [];
  for (const p of prospects) {
    const intel = await gatherIntel(p);
    enriched.push({ ...p, intel });
  }
  logRun('03-competitive-intel', { processed: enriched.length });
  return enriched;
}

module.exports = { gatherIntelBatch };
