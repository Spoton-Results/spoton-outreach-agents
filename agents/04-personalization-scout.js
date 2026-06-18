/**
 * Agent 04: Personalization Scout
 * Finds the ONE specific hook that makes outreach feel hand-written
 * For GCs: billing disputes, payment issues, fast growth, recent projects, hiring signals
 * The hook should connect naturally to the invoice protection angle
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are a personalization research agent for SubDraw — invoice protection for general contractors.
Find ONE specific, non-obvious hook for a cold email to a General Contractor.

The hook should ideally connect to billing, payment, or project management pain.
But any genuine specific detail works — the point is it feels hand-written, not templated.

GREAT hooks (specific, non-obvious, connects to their world):
- "Saw the permit pull for your Wilshire Ave project last month — nice scope"
- "Noticed you're hiring a Project Accountant — billing getting complex?"
- "Your Yelp reviews mention how clean your payment process is — that's rare in construction"
- "Saw you just added a commercial division — managing more subs now?"
- "Google Maps shows 4 active job sites — juggling a lot of billing right now?"

BAD hooks (generic, anyone could send these):
- "I noticed you're in the construction industry"
- "As a GC, you understand how complex projects can get"
- "I came across your company online"
Return JSON only.`;

async function findHook(prospect) {
  const prompt = `Find a personalization hook for this SubDraw cold outreach:

Contact: ${prospect.name}, ${prospect.title}
Company: ${prospect.organization_name}
Location: ${prospect.city}, ${prospect.state}
Employees: ${prospect.employees}
Intel: ${JSON.stringify(prospect.intel || {})}
Screening: ${JSON.stringify(prospect.screening || {})}
LinkedIn: ${prospect.linkedin_url || 'none'}
Website: ${prospect.intel?.website || 'none'}

Find ONE specific, genuine hook. If you can't find a real one, use their growth stage + location creatively.
The hook should feel like you actually looked at their business for 5 minutes.

Return: {
  "hook": "the specific opening line — max 2 sentences",
  "hook_type": "permit_activity|hiring_signal|billing_signal|growth_signal|project_completion|review_signal|location_specific",
  "confidence": "high|medium|low",
  "connects_to_pain": "how this hook naturally leads into the invoice protection pitch"
}`;

  return JSON.parse(await callClaude(SYSTEM, prompt));
}

async function scoutBatch(prospects) {
  console.log('[Agent 04] Finding personalization hooks for ' + prospects.length + ' prospects...');
  const enriched = [];
  for (const p of prospects) {
    const hook = await findHook(p);
    enriched.push({ ...p, personalization: hook });
  }
  logRun('04-personalization-scout', { processed: enriched.length });
  return enriched;
}

module.exports = { scoutBatch };
