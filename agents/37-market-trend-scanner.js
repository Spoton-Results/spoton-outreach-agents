/**
 * Agent 37: Market Trend Scanner
 * Canonical Gap #6 — active monitoring of industry movement
 * Different from Agent 29 (geographic scout) which picks expansion states
 *
 * This agent watches:
 * - Construction software news (Procore, Buildertrend competitor moves)
 * - Lender policy changes affecting draw requirements
 * - Construction market conditions (permits, starts, slowdowns)
 * - Regulatory changes affecting GC documentation requirements
 * - Pricing and packaging shifts from competitors
 *
 * Why it matters: if Procore launches a $99/mo small GC product,
 * you need to know before it affects your reply rates.
 * If lender documentation requirements change, that's a new pain point
 * to add to the email copy.
 *
 * Runs Sunday midnight — feeds Agent 05 (email copy) and Agent 19 (briefing)
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, logRun } = require('../utils/helpers');
const fs = require('fs');
const path = require('path');

const SYSTEM = `You are a market trend scanner for SubDraw — construction draw management SaaS.
Monitor construction industry and construction software market movements.
Focus on signals that affect SubDraw's positioning, messaging, or competitive landscape.
Return JSON only.`;

const MONITOR_TOPICS = [
  'Procore pricing changes or new small business product',
  'Buildertrend feature updates or pricing',
  'Construction loan draw requirements changes from lenders',
  'Construction permit volumes and market slowdown signals',
  'New construction SaaS competitors targeting small GCs',
  'AIA document changes affecting pay applications',
  'Construction labor and subcontractor market conditions',
  'Lien law changes by state affecting documentation requirements'
];

async function scanMarketTrends() {
  console.log('[Agent 37] Scanning market trends...');

  const prompt = `Analyze the current construction software and construction market landscape for SubDraw.

SubDraw context:
- Targets small-to-mid GCs (2-150 employees)
- Priced at $149/$299/$599/mo by active subcontracts
- Invoice protection and draw management positioning
- Competing against: spreadsheets (primary), Procore (enterprise), Buildertrend (residential)

Topics to assess:
${MONITOR_TOPICS.map((t, i) => (i + 1) + '. ' + t).join('\n')}

Current date: ${new Date().toISOString().split('T')[0]}

Based on your knowledge of the construction software market, assess each topic and identify:
1. Any signals that could affect SubDraw's outreach performance
2. New pain points to add to email messaging
3. Competitor moves to be aware of
4. Market conditions that create urgency or remove it

Return: {
  "market_conditions": "brief construction market summary",
  "competitor_signals": [...],
  "new_pain_points": [...],
  "messaging_opportunities": [...],
  "threats": [...],
  "urgency_signals": "what's creating urgency for GCs to improve their draw process right now",
  "recommended_email_angle_addition": "one new angle to test in email sequences",
  "alert_level": "normal|elevated|high",
  "summary": "2-3 sentence plain-English summary for morning briefing"
}`;

  const trends = JSON.parse(await callClaude(SYSTEM, prompt));

  // Save for Agent 19 (daily briefing) and Agent 05 (email copy) to read
  const logsDir = path.join(__dirname, '../logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(
    path.join(logsDir, 'market-trends.json'),
    JSON.stringify({ updated: new Date().toISOString(), ...trends }, null, 2)
  );

  // If high alert — update the email copywriter's context
  if (trends.alert_level === 'high' && trends.recommended_email_angle_addition) {
    const variantsPath = path.join(__dirname, '../config/winning-variants.json');
    let variants = {};
    try { variants = JSON.parse(fs.readFileSync(variantsPath, 'utf8')); } catch(e) {}
    variants.market_angle = trends.recommended_email_angle_addition;
    variants.market_urgency = trends.urgency_signals;
    fs.writeFileSync(variantsPath, JSON.stringify(variants, null, 2));
    console.log('[Agent 37] HIGH ALERT — updated email variants with market angle');
  }

  logRun('37-market-trend-scanner', {
    alert_level: trends.alert_level,
    competitor_signals: trends.competitor_signals?.length || 0,
    new_pain_points: trends.new_pain_points?.length || 0,
    summary: trends.summary
  });

  console.log('[Agent 37] Alert level:', trends.alert_level);
  console.log('[Agent 37] Summary:', trends.summary);
  return trends;
}

module.exports = { scanMarketTrends };
if (require.main === module) scanMarketTrends().then(r => console.log('[Agent 37] Done. Alert:', r.alert_level));
