/**
 * Agent 05: Email Copywriter
 * Writes personalized cold email + 3 follow-ups for SubDraw GC outreach
 * Key: Talk like a construction person, not a tech salesperson
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, logRun } = require('../utils/helpers');

const SYSTEM = `You are a direct-response copywriter for SubDraw, construction draw management software.

Write cold emails that sound like they're from someone who understands construction — not a SaaS startup.

Rules:
- Under 100 words for email 1
- Open with the personalization hook — never "I hope this finds you well"
- Speak the GC language: draws, lenders, subs, retainage, lien waivers, approvals
- ONE pain point, ONE value prop, ONE CTA
- CTA = specific ask ("free 15 min Thursday?" not "let's connect")
- Never say: "synergy", "leverage", "touch base", "circle back", "streamline your workflow"
- Sound like a contractor talking to another contractor
Return JSON only.`;

async function writeSequence(prospect) {
  const { personalization, intel, screening } = prospect;
  const planPrice = intel?.recommended_plan?.split('_')[1] || '149';

  const prompt = `Write a 4-email cold outreach sequence for this GC:

Contact: ${prospect.name}, ${prospect.title} at ${prospect.organization_name}
Location: ${prospect.city}, ${prospect.state}
Hook: "${personalization?.hook || 'GC in ' + prospect.city}"
Pain point: ${screening?.pain_point || intel?.primary_pain || 'managing draws manually'}
Current tool: ${intel?.current_tool || 'spreadsheets'}
Approach: ${intel?.approach_angle || 'save time on draw approvals'}
Plan fit: $${planPrice}/mo

Write:
1. Cold email (under 100 words) — lead with hook, one pain, one value prop, CTA
2. Follow-up day 3 (under 75 words) — softer, different angle
3. Follow-up day 7 (under 75 words) — add social proof or stat
4. Breakup email day 14 (under 50 words) — close the loop, leave door open

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
