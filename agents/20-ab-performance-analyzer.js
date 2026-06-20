/**
 * Agent 20: A/B Performance Analyzer
 * Runs every Sunday midnight
 * Pulls Instantly analytics, scores every subject line and email variant by reply rate
 * Tells Agent 05 what's working so future sequences start from winners
 * Saves results to config/winning-variants.json
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callInstantly, logRun } = require('../utils/helpers');
const fs = require('fs');
const path = require('path');

const SYSTEM = `You are a cold email performance analyst for SubDraw.
Analyze email campaign data and identify what's working.
Be specific — name exact subject lines and copy patterns that outperform.
Return JSON only.`;

async function analyzePerformance() {
  console.log('[Agent 20] Analyzing campaign performance...');

  try {
    const campaignId = process.env.INSTANTLY_CAMPAIGN_ID;
    const analytics = await callInstantly('GET', '/analytics/campaign?campaign_id=' + campaignId);
    const sequences = await callInstantly('GET', '/campaign/sequences?campaign_id=' + campaignId);

    const prompt = `Analyze this SubDraw email campaign performance data:

Overall stats: ${JSON.stringify(analytics, null, 2)}
Sequences: ${JSON.stringify(sequences, null, 2)}

Identify:
1. Which subject lines get the highest open rates
2. Which email bodies get the most replies
3. Which follow-up position (1st/2nd/3rd/breakup) performs best
4. What patterns appear in high-performing emails
5. What to change for next week

Return: {
  "winning_subject_patterns": [...],
  "winning_body_patterns": [...],
  "best_performing_sequence_position": "email_1|email_2|email_3|email_4",
  "open_rate_benchmark": X%,
  "reply_rate_benchmark": X%,
  "recommendations": [...],
  "next_week_test": "what to A/B test next week"
}`;

    const analysis = JSON.parse(await callClaude(SYSTEM, prompt));

    // Save winning variants for Agent 05 to use
    const variantsPath = path.join(__dirname, '../config/winning-variants.json');
    fs.mkdirSync(path.dirname(variantsPath), { recursive: true });
    fs.writeFileSync(variantsPath, JSON.stringify({
      updated: new Date().toISOString(),
      ...analysis
    }, null, 2));

    logRun('20-ab-performance-analyzer', {
      open_rate: analysis.open_rate_benchmark,
      reply_rate: analysis.reply_rate_benchmark,
      next_test: analysis.next_week_test
    });

    console.log('[Agent 20] Analysis complete. Reply rate:', analysis.reply_rate_benchmark);
    return analysis;
  } catch(e) {
    console.error('[Agent 20] Error:', e.message);
  }
}

module.exports = { analyzePerformance };
if (require.main === module) analyzePerformance().then(() => console.log('[Agent 20] Done'));
