/**
 * Agent 04: Personalization Scout
 * Finds the ONE specific hook that makes outreach feel human
 * For GCs: recent permits, job postings, project completions, reviews mentioning payment issues
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, logRun } = require('../utils/helpers');

const SYSTEM = `You are a personalization research agent for SubDraw.
Find ONE specific, non-obvious hook for a cold email to a General Contractor.

Good GC hooks:
- "Saw you just pulled permits for the Oak Street mixed-use project"
- "Noticed you're hiring a Project Manager — growing fast"
- "Your Google reviews mention clients loving your communication"
- "Saw you recently completed the Riverside townhomes — congrats"

Bad hooks (too generic):
- "I noticed you're in construction"
- "As a GC, you know how complex projects can be"
Return JSON only.`;

async function findHook(prospect) {
  const prompt = `Find a personalization hook for this GC cold outreach:

Contact: ${prospect.name}, ${prospect.title}
Company: ${prospect.organization_name}
Location: ${prospect.city}, ${prospect.state}
Size: ${prospect.employees} employees
Intel: ${JSON.stringify(prospect.intel || {})}
LinkedIn: ${prospect.linkedin_url || 'none'}

Return: {
  "hook": "the specific opening line",
  "hook_type": "permit_activity|hiring_signal|project_completion|review_signal|growth_signal|location_specific",
  "confidence": "high|medium|low"
}`;

  return JSON.parse(await callClaude(SYSTEM, prompt));
}

async function scoutBatch(prospects) {
  console.log('[Agent 04] Finding hooks for ' + prospects.length + ' prospects...');
  const enriched = [];
  for (const p of prospects) {
    const hook = await findHook(p);
    enriched.push({ ...p, personalization: hook });
  }
  logRun('04-personalization-scout', { processed: enriched.length });
  return enriched;
}

module.exports = { scoutBatch };
