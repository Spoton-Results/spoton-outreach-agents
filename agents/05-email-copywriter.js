/**
 * Agent 05: Email Copywriter — PRODUCT-AWARE
 *
 * SubDraw:  Invoice protection angle for GC owners
 * Merchant: Free statement audit + multi-processor fit (Edge 1 + Edge 3)
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, logRun } = require('../utils/helpers');
const { isMerchant, PRODUCT, MERCHANT_EMAIL_SYSTEM } = require('../utils/product-config');

// ── SUBDRAW SYSTEM PROMPT (unchanged) ─────────────────────────────────────────
const SUBDRAW_SYSTEM = `You are a direct-response copywriter for SubDraw — construction draw management and invoice protection for general contractors.

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

// ── MERCHANT SYSTEM PROMPT (Edge 1 + Edge 3) ──────────────────────────────────
// Imported from product-config.js — MERCHANT_EMAIL_SYSTEM

// ── EMAIL SEQUENCE BUILDER ────────────────────────────────────────────────────
async function writeSequence(prospect) {
  const SYSTEM = isMerchant ? MERCHANT_EMAIL_SYSTEM : SUBDRAW_SYSTEM;

  const { personalization, intel, screening } = prospect;

  let winningPatterns = '';
  try {
    const fs = require('fs');
    const variants = JSON.parse(fs.readFileSync('./config/winning-variants.json', 'utf8'));
    winningPatterns = 'Winning patterns from past campaigns: ' + JSON.stringify(variants.winning_subject_patterns || []);
  } catch(e) { /* no variants yet */ }

  const contactContext = isMerchant
    ? `Business: ${prospect.organization_name}
Owner: ${prospect.first_name || ''} ${prospect.last_name || ''}, ${prospect.title || 'Owner'}
Industry: ${prospect.industry || 'retail/restaurant'}
Location: ${prospect.city}, ${prospect.state}
Estimated processor: ${prospect.estimated_processor || 'unknown — assume Square or Stripe'}
Hook: "${personalization?.hook || 'processing fees eating into margin'}"`
    : `Contact: ${prospect.name}, ${prospect.title} at ${prospect.organization_name}
Location: ${prospect.city}, ${prospect.state}
Hook: "${personalization?.hook}"`;

  const sequenceInstructions = isMerchant
    ? `Write a 4-email cold outreach sequence for this merchant:

${contactContext}

SEQUENCE RULES:
Email 1 — Edge 1 lead: free statement audit hook. Subject under 6 words. Body under 100 words. CTA: send your last statement → spotonresults.com/audit
Email 2 — Social proof: "We audited 47 statements last month. Average was overpaying $380/mo." Under 75 words. Same CTA.
Email 3 — Edge 3: multi-processor fit angle. "We work with 6 processors — we match your business type, not just find the cheapest rate." Under 75 words.
Email 4 — Last contact: honest close. "I won't follow up after this." Under 60 words.

${winningPatterns}

Return JSON:
{
  "emails": [
    { "subject": "...", "body": "..." },
    { "subject": "...", "body": "..." },
    { "subject": "...", "body": "..." },
    { "subject": "...", "body": "..." }
  ]
}`
    : `Write a 4-email cold outreach sequence for this GC:

${contactContext}
Company: ${prospect.organization_name}
Pain: ${screening?.pain_point || intel?.primary_pain || 'subcontractor invoice disputes'}

SEQUENCE RULES:
Email 1 — Invoice risk hook, under 100 words, CTA: subdraw.com/login
Email 2 — Social proof, under 75 words
Email 3 — Feature: retainage tracking or lien waiver angle, under 75 words
Email 4 — Last contact close, under 60 words

${winningPatterns}

Return JSON: { "emails": [{ "subject": "...", "body": "..." }] }`;

  try {
    const raw = await callClaude(SYSTEM, sequenceInstructions, { quality: true });
    const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(clean);
  } catch(e) {
    console.error('[Agent 05] Copywriter error:', e.message);
    return null;
  }
}

async function writeSequenceBatch(prospects) {
  console.log(`[Agent 05] Writing sequences for ${prospects.length} prospects — PRODUCT=${PRODUCT}`);
  const results = [];

  for (const p of prospects) {
    const seq = await writeSequence(p);
    if (seq) {
      results.push({ ...p, emailSequence: seq.emails });
    }
  }

  logRun('05-email-copywriter', { written: results.length, product: PRODUCT });
  return results;
}

module.exports = { writeSequenceBatch, writeSequence };
