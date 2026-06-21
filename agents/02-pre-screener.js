/**
 * Agent 02: Pre-Screener
 * Filters to GCs who actively manage subcontractors and draws
 * Key signal: active subcontracts, not just "being in construction"
 * A GC with 5 subs on a project is the perfect SubDraw customer
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are a lead qualification agent for SubDraw — a construction draw management and invoice protection platform.

SubDraw is built for General Contractors who:
1. Manage multiple subcontractors on active projects
2. Review and approve subcontractor pay applications and invoices
3. Track retainage, lien waivers, and change orders
4. Submit draw requests to construction lenders
5. Have been burned by invoice errors or billing disputes

SubDraw protects GCs from costly subcontractor overbilling and invoice mistakes.
The more subcontractors they manage, the more valuable SubDraw is.

HIGH VALUE (score 8-10):
- GC with 5+ active subcontracts on current projects
- Has had payment disputes or billing issues
- Submits draws to a construction lender
- Currently using spreadsheets or email for billing

MEDIUM VALUE (score 5-7):
- Small GC with 1-4 subcontracts
- Owner-operated, doing everything manually
- Growing and adding more subs

DISQUALIFY:
- Solo trade-only contractor (electrician, plumber) — no subs to manage
- No GC license
- Purely government work
- Already deep into Procore draw module
- Enterprise 500+ employees (needs custom)

Score 1-10. Return JSON only.`;

async function screenProspects(prospects) {
  console.log('[Agent 02] Screening ' + prospects.length + ' prospects...');
  const screened = [];

  for (let i = 0; i < prospects.length; i += 10) {
    const batch = prospects.slice(i, i + 10);
    const prompt = `Screen these GC prospects for SubDraw invoice protection outreach.
Focus on: do they manage subcontractors and review their invoices?

Prospects:
${JSON.stringify(batch.map(p => ({
  id: p.id,
  name: p.name,
  title: p.title,
  company: p.organization_name,
  industry: p.industry,
  employees: p.employees,
  location: p.city + ', ' + p.state
})))}

For each prospect return:
- score 1-10
- verdict: qualified or disqualified
- reason: why
- recommended_plan: starter_149 (up to 10 subs) / professional_299 (up to 30 subs) / scale_599 (unlimited)
- pain_point: most likely invoice/billing pain they face
- sub_count_estimate: estimated number of active subcontractors they manage

Return JSON array: [{ "id": "...", "score": X, "verdict": "qualified|disqualified", "reason": "...", "recommended_plan": "...", "pain_point": "...", "sub_count_estimate": X }]`;

    let results;
    try { results = JSON.parse(await callClaude(SYSTEM, prompt)); } catch(e) { console.error("[Agent 02] Parse error:", e.message); results = []; }
    results.forEach(r => {
      if (r.verdict === 'qualified' && r.score >= 6) {
        const prospect = batch.find(p => p.id === r.id);
        if (prospect) screened.push({ ...prospect, screening: r });
      }
    });
  }

  logRun('02-pre-screener', { input: prospects.length, passed: screened.length });
  console.log('[Agent 02] ' + screened.length + '/' + prospects.length + ' passed screening');
  return screened;
}

module.exports = { screenProspects };
