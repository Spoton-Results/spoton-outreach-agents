/**
 * Agent 05: Email Copywriter
 * Writes personalized cold email + 3 follow-ups for SubDraw GC outreach
 * CTA is always the self-guided demo link — no calls, no scheduling
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are a direct-response copywriter for SubDraw, construction draw management software.

Write cold emails that sound like they're from someone who understands construction — not a SaaS startup.

Rules:
- Under 100 words for email 1
- Open with the personalization hook — never "I hope this finds you well"
- Speak the GC language: draws, lenders, subs, retainage, lien waivers, approvals
- ONE pain point, ONE value prop, ONE CTA
- CTA is ALWAYS the demo link: subdraw.com/login — frame it as "see it in 8 minutes" or "try it free"
- Never try to book a call or meeting — the product sells itself
- Never say: "synergy", "leverage", "touch base", "circle back", "streamline"
- Sound like a contractor talking to another contractor
Return JSON only.`;

async function writeSequence(prospect) {
  const { personalization, intel, screening } = prospect;

  const prompt = `Write a 4-email cold outreach sequence for this GC:

Contact: ${prospect.name}, ${prospect.title} at ${prospect.organization_name}
Location: ${prospect.city}, ${prospect.state}
Hook: "${personalization?.hook || 'GC in ' + prospect.city}"
Pain point: ${screening?.pain_point || intel?.primary_pain || 'managing draws manually'}
Current tool: ${intel?.current_tool || 'spreadsheets'}
Approach: ${intel?.approach_angle || 'save time on draw approvals'}
Demo URL: ${icp.product.demo_url}

Write:
1. Cold email (under 100 words) — hook + one pain + one value prop + CTA to demo link
2. Follow-up day 3 (under 75 words) — different angle, same demo CTA
3. Follow-up day 7 (under 75 words) — add a specific result or stat, demo CTA
4. Breakup email day 14 (under 50 words) — leave door open, one last demo mention

CTA examples to rotate:
- "See how it works in 8 minutes — subdraw.com/login"
- "Try it free — subdraw.com/login"  
- "No call needed. See the full thing — subdraw.com/login"
- "Built for GCs. Try it yourself — subdraw.com/login"

Return JSON:
{
  "email_1": { "subject": "...", "body": "..." },
  "email_2": { "subject": "...", "body": "..." },
  "email_3": { "subject": "...", "body": "..." },
  "email_4": { "subject": "...", "body": "..." }
}`;

  return JSON.parse(await callClaude(SYSTEM, prompt));
}

async function writeSequenceBatch(prospects) {
  console.log('[Agent 05] Writing sequences for ' + prospects.length + ' prospects...');
  const written = [];
  for (const p of prospects) {
    const emails = await writeSequence(p);
    written.push({ ...p, emails });
  }
  logRun('05-email-copywriter', { sequences_written: written.length });
  return written;
}

module.exports = { writeSequenceBatch };
