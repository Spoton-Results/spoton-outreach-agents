/**
 * Agent 14: Revenue Monitor
 * Watches Stripe every 2hrs for signups, upgrades, failed payments, churn
 * Most important agent — this is where outreach turns into money
 * Runs on Railway cron: every 2 hours
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, logRun, sleep } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are a revenue monitoring agent for SubDraw SaaS.
Analyze Stripe events and determine what actions need to be taken in GHL.
Return JSON only.`;

async function callStripe(endpoint) {
  const fetch = (await import('node-fetch')).default;
  const res = await fetch('https://api.stripe.com/v1' + endpoint, {
    headers: { 'Authorization': 'Bearer ' + process.env.STRIPE_SECRET_KEY }
  });
  if (!res.ok) throw new Error('Stripe error: ' + res.status);
  return res.json();
}

async function monitorRevenue() {
  console.log('[Agent 14] Checking Stripe revenue events...');

  try {
    // Get recent events from last 2 hours
    const since = Math.floor(Date.now() / 1000) - (2 * 60 * 60);
    const events = await callStripe('/events?created[gte]=' + since + '&limit=100&types[]=customer.subscription.created&types[]=customer.subscription.deleted&types[]=invoice.payment_failed&types[]=customer.subscription.updated');

    const summary = {
      new_signups: [],
      upgrades: [],
      failed_payments: [],
      cancellations: []
    };

    for (const event of (events.data || [])) {
      const obj = event.data?.object;

      if (event.type === 'customer.subscription.created') {
        const customer = await callStripe('/customers/' + obj.customer);
        summary.new_signups.push({
          email: customer.email,
          name: customer.name,
          plan: getPlanName(obj.items?.data?.[0]?.price?.unit_amount),
          amount: obj.items?.data?.[0]?.price?.unit_amount / 100
        });

        // Update GHL contact to Customer Won
        try {
          const contacts = await callGHL('GET', '/contacts/?email=' + encodeURIComponent(customer.email) + '&locationId=' + (process.env.GHL_LOCATION_ID || icp.ghl.location_id));
          const contactId = contacts.contacts?.[0]?.id;
          if (contactId) {
            await callGHL('PUT', '/contacts/' + contactId, {
              tags: ['customer', 'paying', 'plan-' + getPlanName(obj.items?.data?.[0]?.price?.unit_amount)]
            });
          }
        } catch(e) { console.error('[Agent 14] GHL update error:', e.message); }
      }

      if (event.type === 'customer.subscription.deleted') {
        const customer = await callStripe('/customers/' + obj.customer);
        summary.cancellations.push({ email: customer.email, name: customer.name });
      }

      if (event.type === 'invoice.payment_failed') {
        const customer = await callStripe('/customers/' + obj.customer);
        summary.failed_payments.push({ email: customer.email, name: customer.name, amount: obj.amount_due / 100 });
      }

      if (event.type === 'customer.subscription.updated' && obj.previous_attributes?.items) {
        const customer = await callStripe('/customers/' + obj.customer);
        summary.upgrades.push({ email: customer.email, name: customer.name });
      }
    }

    // Claude analyzes and flags anything needing attention
    if (Object.values(summary).some(arr => arr.length > 0)) {
      const prompt = `Analyze these SubDraw Stripe events from the last 2 hours:
${JSON.stringify(summary, null, 2)}

What needs immediate attention? Any patterns?
Return: { "alerts": [...], "revenue_added": $X, "churn_risk": "high|medium|low|none", "action_needed": "..." }`;

      const analysis = JSON.parse(await callClaude(SYSTEM, prompt));
      require('../utils/helpers').notifyDashboard('revenue', { mrr: data.mrr, signups: data.new_signups, cancels: data.cancellations });
    logRun('14-revenue-monitor', { ...summary, analysis });

      if (analysis.alerts?.length > 0) {
        console.log('[Agent 14] ALERTS:', analysis.alerts);
      }
    } else {
      console.log('[Agent 14] No revenue events in last 2 hours');
      logRun('14-revenue-monitor', { status: 'quiet', checked_at: new Date().toISOString() });
    }

    return summary;
  } catch (e) {
    console.error('[Agent 14] Error:', e.message);
    logRun('14-revenue-monitor', { error: e.message });
  }
}

function getPlanName(cents) {
  if (cents === 14900) return 'starter';
  if (cents === 29900) return 'professional';
  if (cents === 59900) return 'scale';
  return 'unknown';
}

module.exports = { monitorRevenue };
if (require.main === module) monitorRevenue().then(() => console.log('[Agent 14] Done'));
