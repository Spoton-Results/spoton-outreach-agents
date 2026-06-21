/**
 * Agent 34: ICP Scorer
 * Canonical Gap #3 — explicit 1-10 ICP score with full reasoning
 * Takes enrichment data from Agent 33 + screening from Agent 02
 * + competitive intel from Agent 03 and produces a definitive score
 *
 * WHY SEPARATE: Pre-screener (02) filters obvious bad fits.
 * ICP Scorer (34) gives every passing prospect a precise score
 * that flows through the entire system — email priority,
 * outreach timing, plan targeting, and Lost Deal Analyzer (36) input.
 *
 * Score feeds: Agent 05 (email tone), Agent 09 (GHL tagging),
 *              Agent 17 (lead scoring), Agent 36 (lost deal patterns)
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are an ICP scoring agent for SubDraw — construction draw management and invoice protection.

Score General Contractors 1-10 against SubDraw's ideal customer profile.
Be precise. This score drives email prioritization, plan targeting, and pipeline decisions.

PERFECT 10 (ideal):
- GC with 10-30 active subcontracts
- Currently using spreadsheets or email for billing
- Has had at least one billing dispute or payment issue
- Submits draws to construction lenders
- 5-50 employees
- Residential or mixed commercial

STRONG FIT 7-9:
- GC with 5-10 subs, growing
- Basic software but clearly outgrowing it
- Multiple active projects

MEDIUM FIT 4-6:
- Small GC, 1-4 subs
- Owner-operated, no accounting staff
- Could benefit but not urgent pain

POOR FIT 1-3:
- Trade-only, no subs to manage
- Solo operator
- Enterprise with dedicated software team
- Government-only work

Return JSON only.`;

async function scoreProspect(prospect) {
  const { screening, intel, enrichment } = prospect;

  const prompt = `Score this GC against SubDraw's ICP:

Company: ${prospect.organization_name}
Title: ${prospect.title}
Location: ${prospect.city}, ${prospect.state}
Employees: ${prospect.employees}

Pre-screening data:
- Screening score: ${screening?.score}/10
- Pain point: ${screening?.pain_point}
- Sub count estimate: ${screening?.sub_count_estimate}

Competitive intel:
- Current tool: ${intel?.current_tool}
- Estimated subcontracts: ${intel?.estimated_active_subcontracts}
- Primary risk: ${intel?.primary_risk}
- Switching likelihood: ${intel?.switching_likelihood}

Enrichment data:
- Revenue range: ${enrichment?.revenue_range}
- Tech sophistication: ${enrichment?.tech_sophistication}
- Hiring signal: ${enrichment?.hiring_signal}
- Online presence: ${enrichment?.online_presence_score}/10
- Primary market: ${enrichment?.primary_market}
- Key signal: ${enrichment?.key_signal}

Return: {
  "icp_score": 1-10,
  "tier": "A|B|C|D",
  "reasoning": "2-3 sentence explanation of the score",
  "strongest_signal": "the single best indicator this is a fit",
  "biggest_risk": "the single biggest concern",
  "recommended_plan": "starter_149|professional_299|scale_599",
  "outreach_priority": "immediate|this_week|this_month|low_priority",
  "estimated_ltv": "low_under_500|medium_500_2000|high_over_2000"
}`;

  try { return JSON.parse(await callClaude(SYSTEM, prompt)); } catch(e) { console.error("[Agent 34] Parse error:", e.message); return { ...prospect, icp_score: 5, icp_tier: "medium" }; }
}

async function scoreBatch(prospects) {
  console.log('[Agent 34] ICP scoring ' + prospects.length + ' prospects...');
  const scored = [];

  for (const p of prospects) {
    const icpScore = await scoreProspect(p);
    scored.push({ ...p, icpScore });
  }

  // Sort by ICP score descending — highest value prospects go first
  scored.sort((a, b) => (b.icpScore?.icp_score || 0) - (a.icpScore?.icp_score || 0));

  const tierBreakdown = scored.reduce((acc, p) => {
    const tier = p.icpScore?.tier || 'D';
    acc[tier] = (acc[tier] || 0) + 1;
    return acc;
  }, {});

  logRun('34-icp-scorer', {
    scored: scored.length,
    tiers: tierBreakdown,
    avg_score: Math.round(scored.reduce((a, p) => a + (p.icpScore?.icp_score || 0), 0) / scored.length)
  });

  console.log('[Agent 34] Scored ' + scored.length + ' prospects. Tier breakdown:', tierBreakdown);
  return scored;
}

module.exports = { scoreBatch };
