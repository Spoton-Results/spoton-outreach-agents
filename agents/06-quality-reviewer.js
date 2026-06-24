/**
 * Agent 06: Quality Reviewer — REBUILT
 * Agent checking agent's work before ANYTHING sends
 * Now enforces invoice protection angle — not just "no AI phrases"
 * Catches: efficiency language, missing risk angle, wrong CTA, generic copy
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, logRun } = require('../utils/helpers');

const SYSTEM = `You are a cold email quality reviewer for SubDraw — invoice protection for general contractors.
Be brutally honest. Your job is to catch weak emails before they go out.

SubDraw's angle is PROTECTION and RISK — not efficiency, not time savings.
Emails that lead with "save time" or "streamline" are WRONG. Rewrite them.
Emails that lead with "catch overruns" or "protect your margin" are RIGHT.

CATCH AND FIX:
1. Wrong angle — leading with time/efficiency instead of protection/risk
2. AI phrases — "I hope this finds you well", "touch base", "circle back", "leverage", "streamline", "game-changer"
3. Generic opener — ignores the personalization hook
4. Tech startup language — sounds like SaaS, not construction
5. Too long — email 1 over 100 words, emails 2-3 over 75 words, email 4 over 50 words
6. Vague CTA — "would love to connect" vs "try it free — subdraw.com/login"
7. Multiple pain points — one per email only
8. No construction language — must include at least one of: draws, pay apps, retainage, lien waivers, subs, invoices, change orders
9. Missing risk framing — every email should make the reader feel the financial risk of NOT having SubDraw
10. Wrong CTA — any email asking for a call or meeting fails automatically

THE CANONICAL LINE — if an email can use this naturally, it should:
"If SubDraw catches one invoice overrun this year, it paid for itself completely."

Score 1-10. Rewrite anything under 8. Return JSON only.`;

async function reviewSequence(prospect) {
  const prompt = `Review and score this SubDraw cold email sequence. Be harsh.

Personalization hook used: "${prospect.personalization?.hook}"
Target: ${prospect.name}, ${prospect.title} at ${prospect.organization_name}
Primary pain: ${prospect.intel?.primary_risk || prospect.screening?.pain_point}
Current tool: ${prospect.intel?.current_tool || 'unknown'}

EMAIL 1 (max 100 words — should lead with hook + invoice protection risk):
Subject: ${prospect.emails.email_1.subject}
Body: ${prospect.emails.email_1.body}

EMAIL 2 (max 75 words — different angle, same protection theme):
Subject: ${prospect.emails.email_2.subject}
Body: ${prospect.emails.email_2.body}

EMAIL 3 (max 75 words — social proof or specific risk stat):
Subject: ${prospect.emails.email_3.subject}
Body: ${prospect.emails.email_3.body}

EMAIL 4 (max 50 words — genuine breakup, leave door open):
Subject: ${prospect.emails.email_4.subject}
Body: ${prospect.emails.email_4.body}

For each email:
- Score 1-10
- List specific issues
- Rewrite the body if score < 8 (keep same subject unless it also needs fixing)

Return: {
  "email_1": { "score": X, "issues": [...], "final_subject": "...", "final_body": "..." },
  "email_2": { "score": X, "issues": [...], "final_subject": "...", "final_body": "..." },
  "email_3": { "score": X, "issues": [...], "final_subject": "...", "final_body": "..." },
  "email_4": { "score": X, "issues": [...], "final_subject": "...", "final_body": "..." },
  "overall_score": X,
  "approved": true/false,
  "fatal_issues": ["any automatic disqualifiers found"]
}`;

  try { return JSON.parse(await callClaude(SYSTEM, prompt, { quality: true })); } catch(e) { console.error("[Agent 06] Parse error:", e.message); return { score: 7, approved: true, issues: [], rewrite_needed: false }; }
}

async function reviewBatch(prospects, minScore = 7) {
  console.log('[Agent 06] Quality reviewing ' + prospects.length + ' sequences...');
  const approved = [], rejected = [];

  for (const p of prospects) {
    const review = await reviewSequence(p);

    // Auto-reject if fatal issues found
    if (review.fatal_issues?.length > 0) {
      console.log('[Agent 06] FATAL: ' + p.name + ' — ' + review.fatal_issues.join(', '));
      rejected.push({ ...p, review });
      continue;
    }

    if (review.approved && review.overall_score >= minScore) {
      const finalEmails = {};
      ['email_1','email_2','email_3','email_4'].forEach(k => {
        finalEmails[k] = {
          subject: review[k].final_subject || p.emails[k].subject,
          body: review[k].final_body || p.emails[k].body
        };
      });
      approved.push({ ...p, emails: finalEmails, review });
    } else {
      rejected.push({ ...p, review });
    }
  }

  logRun('06-quality-reviewer', {
    reviewed: prospects.length,
    approved: approved.length,
    rejected: rejected.length,
    avg_score: approved.length ? Math.round(approved.reduce((a,p) => a + p.review.overall_score, 0) / approved.length) : 0
  });

  console.log('[Agent 06] Approved: ' + approved.length + ' | Rejected: ' + rejected.length);
  return { approved, rejected };
}

module.exports = { reviewBatch };
