/**
 * Agent 30: Pricing Signal Monitor
 * Watches Stripe data patterns weekly
 * Answers: Is $149 the right price? Should we add annual plan? Where is revenue concentrating?
 * Reports one clear recommendation every week
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, logRun } = require('../utils/helpers');

async function callStripe(endpoint) {
  const fetch = (await import('node-fetch')).default;
  const res = await fetch('https://api.stripe.com/v1' + endpoint, {
    headers: { 'Authorization': 'Bearer ' + process.env.STRIPE_SECRET_KEY }
  });
  if (!res.ok) throw new Error('Stripe error: ' + res.status);
  return res.json();
}

const SYSTEM = `You are a pricing analyst for SubDraw SaaS.
Analyze Stripe data to surface pricing insights.
Be direct — give one clear recommendation.
Return JSON only.`;

async function analyzePricing() {
  console.log('[Agent 30] Analyzing pricing signals...');

  try {
    const [subs, charges, invoices] = await Promise.all([
      callStripe('/subscriptions?limit=100&status=all'),
      callStripe('/charges?limit=100'),
      callStripe('/invoices?limit=100&status=paid')
    ]);

    const activeSubs = (subs.data || []).filter(s => s.status === 'active');
    const cancelledSubs = (subs.data || []).filter(s => s.status === 'canceled');

    const planBreakdown = {};
    activeSubs.forEach(s => {
      const amount = s.items?.data?.[0]?.price?.unit_amount / 100;
      const plan = amount === 149 ? 'starter' : amount === 299 ? 'professional' : amount === 599 ? 'scale' : 'other';
      planBreakdown[plan] = (planBreakdown[plan] || 0) + 1;
    });

    const avgLifetime = cancelledSubs.length > 0
      ? cancelledSubs.reduce((acc, s) => acc + ((s.canceled_at - s.created) / 86400), 0) / cancelledSubs.length
      : 0;

    const prompt = `Analyze these SubDraw Stripe pricing metrics:

Active subscriptions by plan: ${JSON.stringify(planBreakdown)}
Total active: ${activeSubs.length}
Total cancelled: ${cancelledSubs.length}
Average customer lifetime: ${Math.round(avgLifetime)} days
MRR: $${activeSubs.reduce((acc, s) => acc + (s.items?.data?.[0]?.price?.unit_amount || 0) / 100, 0).toFixed(0)}

Answer:
1. Which plan is converting best?
2. Is there a pricing gap (too many on starter, nobody upgrading)?
3. Should we add an annual plan discount?
4. What's the churn risk?

Return: {
  "mrr": $X,
  "top_plan": "...",
  "upgrade_rate": "X% from starter to pro",
  "avg_lifetime_days": X,
  "annual_plan_recommendation": true/false,
  "pricing_gap": true/false,
  "one_recommendation": "the single most important pricing action to take",
  "risk_level": "low|medium|high"
}`;

    const analysis = JSON.parse(await callClaude(SYSTEM, prompt));
    logRun('30-pricing-signal-monitor', analysis);
    console.log('[Agent 30] MRR: $' + analysis.mrr + ' | Recommendation: ' + analysis.one_recommendation);
    return analysis;
  } catch(e) {
    console.error('[Agent 30] Error:', e.message);
    return null;
  }
}

module.exports = { analyzePricing };
if (require.main === module) analyzePricing().then(r => console.log('[Agent 30] Done'));
