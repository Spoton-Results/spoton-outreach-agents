/**
 * Agent 05: Email Copywriter — REBUILT WITH INVOICE PROTECTION ANGLE
 * 
 * OLD ANGLE: "save time on draw approvals" (weak — time savings is nice-to-have)
 * NEW ANGLE: "protect your margins from subcontractor overbilling" (urgent — financial risk)
 *
 * The canonical positioning: "If SubDraw catches one invoice overrun this year, it paid for itself."
 * Every email leads with risk/protection, not efficiency/speed.
 *
 * CTA is always subdraw.com/login — no calls, no scheduling
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are a direct-response copywriter for SubDraw — construction draw management and invoice protection for general contractors.

POSITIONING: SubDraw protects GCs from costly subcontractor invoice mistakes and billing disputes.
It replaces spreadsheets, email chains, paper pay apps, and manual retainage tracking.
Subcontractors use it free to submit draw requests and pay applications directly.

THE CORE MESSAGE: One invoice overrun can wipe out a project's margin. SubDraw catches them before they're paid.

WRITE LIKE THIS:
- Lead with risk and protection, not efficiency
- Speak construction: draws, pay apps, retainage, lien waivers, schedule of values, change orders, subs
- One pain point per email — don't stack them
- CTA is always: try free at subdraw.com/login — NEVER book a call
- Under 100 words for email 1, under 75 for follow-ups
- Sound like a contractor talking to a contractor — not a SaaS startup

NEVER SAY: streamline, leverage, touch base, circle back, synergy, game-changer, innovative solution
NEVER DO: vague CTAs, multiple pain points, generic openers, corporate language

PRICING CONTEXT (use when relevant):
- Starter $149/mo — up to 10 active subcontracts
- Professional $299/mo — up to 30 subcontracts  
- Scale $599/mo — unlimited subcontracts
- Subcontractors always free
- 7-day free trial
- "If SubDraw catches one invoice overrun this year, it paid for itself completely."

Return JSON only.`;

async function writeSequence(prospect) {
  const { personalization, intel, screening } = prospect;

  // Pull winning variants if A/B analyzer has run
  let winningPatterns = '';
  try {
    const fs = require('fs');
    const variants = JSON.parse(fs.readFileSync('./config/winning-variants.json', 'utf8'));
    winningPatterns = 'Winning patterns from past campaigns: ' + JSON.stringify(variants.winning_subject_patterns || []);
  } catch(e) { /* no variants yet — first run */ }

  const prompt = `Write a 4-email cold outreach sequence for this GC:

Contact: ${prospect.name}, ${prospect.title} at ${prospect.organization_name}
Location: ${prospect.city}, ${prospect.state}
Hook: "${personalization?.hook}"
Hook connects to: ${personalization?.connects_to_pain || 'invoice and billing pain'}
Current draw tool: ${intel?.current_tool || 'spreadsheets'}
Estimated active subcontracts: ${intel?.estimated_active_subcontracts || screening?.sub_count_estimate || 'unknown'}
Primary risk: ${intel?.primary_risk || screening?.pain_point || 'subcontractor invoice errors'}
Approach angle: ${intel?.approach_angle || 'invoice protection'}
Recommended plan: ${intel?.recommended_plan || screening?.recommended_plan || 'starter_149'}
${winningPatterns}

Write 4 emails. Each uses a DIFFERENT angle from these invoice protection themes:
- Email 1: overbilling risk (subs billing more than approved)
- Email 2: retainage errors (miscalculations that cost thousands)
- Email 3: missing documentation (lien waivers, change order backup)
- Email 4: breakup — leave door open, reference the risk one last time

Rules:
- Email 1: under 100 words, lead with hook, ONE risk, CTA to subdraw.com/login
- Emails 2-3: under 75 words, fresh angle, different CTA phrasing
- Email 4: under 50 words, genuine breakup, no hard sell

CTA variations to use:
- "Takes 8 minutes to see — subdraw.com/login"
- "If it catches one overrun this year, it paid for itself — subdraw.com/login"
- "Try it free — subdraw.com/login"
- "See how it works — subdraw.com/login"

Return JSON:
{
  "email_1": { "subject": "...", "body": "..." },
  "email_2": { "subject": "...", "body": "..." },
  "email_3": { "subject": "...", "body": "..." },
  "email_4": { "subject": "...", "body": "..." }
}`;

  try { return JSON.parse(await callClaude(SYSTEM, prompt)); } catch(e) { console.error('[Agent 05] Parse error:', e.message); return null; }
}

async function writeSequenceBatch(prospects) {
  console.log('[Agent 05] Writing invoice-protection sequences for ' + prospects.length + ' prospects...');
  const written = [];
  for (const p of prospects) {
    const emails = await writeSequence(p);
    written.push({ ...p, emails });
  }
  logRun('05-email-copywriter', { sequences_written: written.length });
  return written;
}

module.exports = { writeSequenceBatch };
