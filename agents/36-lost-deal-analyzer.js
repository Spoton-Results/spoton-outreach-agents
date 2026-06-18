/**
 * Agent 36: Lost Deal Analyzer
 * Canonical Gap #5 — studies lost opportunities and finds patterns
 * Runs weekly Sunday midnight alongside Agent 20
 *
 * Inputs: GHL contacts tagged unsubscribed, churned, or disqualified
 *         Classified reply data (objection types, not-now reasons)
 *         Churn interview responses from Agent 28
 *
 * Outputs: Pattern report saved to logs/lost-deal-analysis.json
 *          Feeds back into Agent 34 (ICP scoring) to improve qualification
 *          Feeds back into Agent 13 (objection handler) with new playbook data
 *          Feeds back into Agent 05 (email copywriter) with messaging gaps
 *
 * After 30 lost deals this becomes the most valuable optimization input
 * in the entire system — it tells you exactly what's not working and why.
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');
const fs = require('fs');
const path = require('path');

const SYSTEM = `You are a lost deal analysis agent for SubDraw SaaS.
Analyze patterns in lost opportunities to improve qualification, messaging, and objection handling.
Be specific and actionable. Return JSON only.`;

async function gatherLostDeals() {
  console.log('[Agent 36] Gathering lost deal data...');
  const locationId = process.env.GHL_LOCATION_ID || icp.ghl.location_id;

  const lostData = {
    unsubscribed: [],
    churned: [],
    disqualified: [],
    objections: {}
  };

  try {
    // Unsubscribes from outreach
    const unsubs = await callGHL('GET',
      '/contacts/?locationId=' + locationId + '&query=unsubscribed&limit=50'
    );
    lostData.unsubscribed = (unsubs.contacts || []).map(c => ({
      company: c.companyName,
      tags: c.tags,
      plan_target: c.tags?.find(t => t.startsWith('plan-target-')),
      objection: c.tags?.find(t => t.startsWith('reply-objection'))
    }));

    // Churned customers
    const churned = await callGHL('GET',
      '/contacts/?locationId=' + locationId + '&query=churned&limit=50'
    );
    lostData.churned = (churned.contacts || []).map(c => ({
      company: c.companyName,
      plan: c.tags?.find(t => t.startsWith('plan-')),
      churn_interview: c.customFields?.find(f => f.key === 'churn_reason')?.field_value
    }));

    // Tally objection types
    const allContacts = [...(unsubs.contacts || []), ...(churned.contacts || [])];
    allContacts.forEach(c => {
      (c.tags || []).forEach(tag => {
        if (tag.startsWith('reply-objection')) {
          lostData.objections[tag] = (lostData.objections[tag] || 0) + 1;
        }
      });
    });

  } catch(e) {
    console.error('[Agent 36] GHL error:', e.message);
  }

  return lostData;
}

async function analyzeLostDeals() {
  console.log('[Agent 36] Analyzing lost deals...');
  const lostData = await gatherLostDeals();

  const totalLost = lostData.unsubscribed.length + lostData.churned.length;

  if (totalLost < 5) {
    console.log('[Agent 36] Not enough lost deals yet (' + totalLost + ') — need at least 5 for patterns. Skipping analysis.');
    logRun('36-lost-deal-analyzer', { total_lost: totalLost, status: 'insufficient_data' });
    return null;
  }

  const prompt = `Analyze these SubDraw lost deals and find actionable patterns:

Total lost: ${totalLost}
Unsubscribed from outreach: ${lostData.unsubscribed.length}
Churned customers: ${lostData.churned.length}

Objection breakdown: ${JSON.stringify(lostData.objections)}

Unsubscribed sample: ${JSON.stringify(lostData.unsubscribed.slice(0, 10))}
Churned sample: ${JSON.stringify(lostData.churned.slice(0, 5))}

Analyze and return:
1. Top 3 reasons deals are lost
2. Which company profile loses most (size, tool, market)
3. Which objection is most common and how to handle it better
4. What ICP signals predicted the loss (to improve Agent 34 scoring)
5. What messaging change would have the biggest impact
6. Which state or market has the lowest conversion
7. One specific change to make this week

Return: {
  "top_loss_reasons": [...],
  "losing_profile": "description of company type that loses most",
  "top_objection": "...",
  "icp_red_flags": [...],
  "messaging_change": "specific change to email copy",
  "weakest_market": "...",
  "this_week_action": "one specific actionable change",
  "data_quality": "low|medium|high"
}`;

  const analysis = JSON.parse(await callClaude(SYSTEM, prompt));

  // Save to logs for review and downstream agent use
  const logsDir = path.join(__dirname, '../logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const outputPath = path.join(logsDir, 'lost-deal-analysis.json');
  fs.writeFileSync(outputPath, JSON.stringify({
    updated: new Date().toISOString(),
    total_analyzed: totalLost,
    raw_data: lostData,
    analysis
  }, null, 2));

  logRun('36-lost-deal-analyzer', {
    total_lost: totalLost,
    top_loss_reason: analysis.top_loss_reasons?.[0],
    this_week_action: analysis.this_week_action
  });

  console.log('[Agent 36] Analysis complete. Top loss reason:', analysis.top_loss_reasons?.[0]);
  console.log('[Agent 36] This week action:', analysis.this_week_action);
  return analysis;
}

module.exports = { analyzeLostDeals };
if (require.main === module) analyzeLostDeals().then(r => console.log('[Agent 36] Done'));
