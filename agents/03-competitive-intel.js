/**
 * Agent 03: Competitive Intel
 * What draw/billing process is this GC currently using?
 * Spreadsheets = easiest win. Email = great fit. Procore = tough sell.
 * Also estimates how many subcontracts they manage — determines plan fit
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are a competitive intelligence agent for SubDraw — construction draw management and invoice protection.
Analyze a General Contractor and estimate their current billing and draw management process.
The key insight: most small-to-mid GCs use spreadsheets and email to manage subcontractor invoices.
That means they have NO protection against overbilling, retainage errors, or missing lien waivers.
Return JSON only.`;

async function gatherIntel(prospect) {
  const prompt = `Analyze this GC and estimate their current subcontract billing and draw process:

Company: ${prospect.organization_name}
Size: ${prospect.employees} employees
Location: ${prospect.city}, ${prospect.state}
Industry: ${prospect.industry}
Website: ${prospect.website || 'unknown'}
Screening data: ${JSON.stringify(prospect.screening || {})}

Estimate:
1. Current draw/billing tool (Procore, Buildertrend, spreadsheets/email, Sage 300, LienWaiver.com, nothing, unknown)
2. Estimated active subcontracts (this determines their SubDraw plan)
3. Primary invoice protection risk (overbilling / retainage errors / missing lien waivers / no audit trail / change order gaps)
4. Switching likelihood (high if spreadsheets/email, medium if basic tool, low if Procore power user)
5. Best approach angle based on their situation

SubDraw plan fit guide:
- 1-10 active subcontracts → Starter $149/mo
- 11-30 active subcontracts → Professional $299/mo  
- 30+ active subcontracts → Scale $599/mo

Return: {
  "current_tool": "spreadsheets|email|procore|buildertrend|sage|other|unknown",
  "estimated_active_subcontracts": X,
  "recommended_plan": "starter_149|professional_299|scale_599",
  "primary_risk": "one sentence describing their biggest invoice protection gap",
  "switching_likelihood": "high|medium|low",
  "approach_angle": "the most compelling angle for cold outreach to this specific GC",
  "sub_network_potential": "how many subs would join SubDraw free if this GC signs up"
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
