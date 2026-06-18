/**
 * Agent 06: Quality Reviewer
 * Agent checking agent's work — catches AI-sounding copy before it sends
 * Most important QC gate in the entire pipeline
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, logRun } = require('../utils/helpers');

const SYSTEM = `You are a cold email quality reviewer for SubDraw. Be brutally honest.

Catch and fix:
1. AI phrases: "I hope this finds you well", "touch base", "circle back", "leverage", "streamline"
2. Generic openers that ignore the personalization hook
3. Tech startup language used with blue-collar contractors
4. Emails over 100 words (email 1) or 75 words (emails 2-3)
5. Vague CTAs ("would love to connect" vs "free call Thursday at 2pm?")
6. Multiple pain points crammed into one email
7. Anything that sounds like it came from a template

Score 1-10. Rewrite anything under 8. Return JSON only.`;

async function reviewSequence(prospect) {
  const prompt = `Review this SubDraw cold email sequence:

Intended hook: "${prospect.personalization?.hook}"
Target: ${prospect.name} at ${prospect.organization_name}

Email 1 (should be under 100 words):
Subject: ${prospect.emails.email_1.subject}
Body: ${prospect.emails.email_1.body}

Email 2: Subject: ${prospect.emails.email_2.subject} | Body: ${prospect.emails.email_2.body}
Email 3: Subject: ${prospect.emails.email_3.subject} | Body: ${prospect.emails.email_3.body}
Email 4: Subject: ${prospect.emails.email_4.subject} | Body: ${prospect.emails.email_4.body}

Score each 1-10. Fix anything under 8. Ensure construction language throughout.

Return: {
  "email_1": { "score": X, "issues": [...], "final_subject": "...", "final_body": "..." },
  "email_2": { "score": X, "issues": [...], "final_subject": "...", "final_body": "..." },
  "email_3": { "score": X, "issues": [...], "final_subject": "...", "final_body": "..." },
  "email_4": { "score": X, "issues": [...], "final_subject": "...", "final_body": "..." },
  "overall_score": X,
  "approved": true/false
}`;

  return JSON.parse(await callClaude(SYSTEM, prompt));
}

async function reviewBatch(prospects, minScore = 7) {
  console.log('[Agent 06] Quality reviewing ' + prospects.length + ' sequences...');
  const approved = [], rejected = [];

  for (const p of prospects) {
    const review = await reviewSequence(p);
    if (review.approved && review.overall_score >= minScore) {
      const finalEmails = {};
      ['email_1','email_2','email_3','email_4'].forEach(k => {
        finalEmails[k] = { subject: review[k].final_subject, body: review[k].final_body };
      });
      approved.push({ ...p, emails: finalEmails, review });
    } else {
      rejected.push({ ...p, review });
    }
  }

  logRun('06-quality-reviewer', { approved: approved.length, rejected: rejected.length });
  console.log('[Agent 06] Approved: ' + approved.length + ' | Rejected: ' + rejected.length);
  return { approved, rejected };
}

module.exports = { reviewBatch };
