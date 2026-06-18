/**
 * Agent 33: Lead Enrichment
 * Canonical Gap #2 — separate enrichment step before ICP scoring
 * Adds company size, software stack signals, revenue indicators,
 * website tech stack, hiring activity, social presence
 * Feeds Agent 34 (ICP Scorer) with structured data
 *
 * WHY SEPARATE: Agent 02 pre-screens for fit, Agent 03 finds competitive intel.
 * Neither does structured enrichment — adding factual company data
 * that improves scoring accuracy downstream.
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, logRun } = require('../utils/helpers');

const SYSTEM = `You are a lead enrichment agent for SubDraw — construction draw management SaaS.
Enrich General Contractor company data with publicly available signals.
Focus on signals that indicate: company size, active project volume, tech sophistication, and financial health.
Return JSON only. Never invent data — use "unknown" when you cannot determine a value.`;

async function enrichProspect(prospect) {
  const prompt = `Enrich this General Contractor company with available public signals:

Company: ${prospect.organization_name}
Contact: ${prospect.name}, ${prospect.title}
Location: ${prospect.city}, ${prospect.state}
Website: ${prospect.website || prospect.intel?.website || 'unknown'}
Employees: ${prospect.employees || 'unknown'}
Current tool: ${prospect.intel?.current_tool || 'unknown'}

Estimate or research:
1. Company age (years in business)
2. Annual revenue range (under $1M / $1-5M / $5-20M / $20M+)
3. Project types (residential / commercial / mixed / industrial)
4. Technology sophistication (low=spreadsheets, medium=basic software, high=integrated platforms)
5. Hiring activity (actively hiring PMs or accountants = growth signal)
6. Online presence strength (1-10 — website quality, reviews, social activity)
7. Likely number of active subcontracts right now
8. Primary market (new construction / renovation / both)

Return: {
  "company_age_years": X or null,
  "revenue_range": "under_1M|1_5M|5_20M|20M_plus|unknown",
  "project_types": ["residential","commercial","mixed","industrial"],
  "tech_sophistication": "low|medium|high",
  "hiring_signal": true/false,
  "online_presence_score": 1-10,
  "estimated_active_subcontracts": X,
  "primary_market": "new_construction|renovation|both|unknown",
  "enrichment_confidence": "high|medium|low",
  "key_signal": "the single most important enrichment finding"
}`;

  return JSON.parse(await callClaude(SYSTEM, prompt));
}

async function enrichBatch(prospects) {
  console.log('[Agent 33] Enriching ' + prospects.length + ' prospects...');
  const enriched = [];

  for (const p of prospects) {
    const enrichment = await enrichProspect(p);
    enriched.push({ ...p, enrichment });
  }

  logRun('33-lead-enrichment', {
    processed: enriched.length,
    high_confidence: enriched.filter(p => p.enrichment?.enrichment_confidence === 'high').length
  });

  console.log('[Agent 33] Enriched ' + enriched.length + ' prospects');
  return enriched;
}

module.exports = { enrichBatch };
