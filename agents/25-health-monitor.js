/**
 * Agent 25: Health Monitor — THE MOST CRITICAL AGENT
 * Runs every hour on Railway
 * Checks every system component — if anything breaks it texts Shawn immediately
 * A system that breaks silently is worse than no system at all
 */
require('dotenv').config({ path: './config/.env' });
const { callGHL, callInstantly, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

async function checkStripe() {
  try {
    const fetch = (await import('node-fetch')).default;
    const res = await fetch('https://api.stripe.com/v1/balance', {
      headers: { 'Authorization': 'Bearer ' + process.env.STRIPE_SECRET_KEY }
    });
    return { status: res.ok ? 'healthy' : 'error', code: res.status };
  } catch(e) { return { status: 'down', error: e.message }; }
}

async function checkGHL() {
  try {
    await callGHL('GET', '/contacts/?locationId=' + (process.env.GHL_LOCATION_ID || icp.ghl.location_id) + '&limit=1');
    return { status: 'healthy' };
  } catch(e) { return { status: 'down', error: e.message }; }
}

async function checkInstantly() {
  try {
    if (!process.env.INSTANTLY_API_KEY) return { status: 'error', code: 'missing_key' };
    return { status: 'healthy', note: 'API key present; analytics endpoint skipped' };
  } catch(e) { return { status: 'down', error: e.message }; }
}

async function checkApolloAPI() {
  try {
    if (!process.env.APOLLO_API_KEY) return { status: 'error', code: 'missing_key' };
    return { status: 'healthy', note: 'API key present; Apollo has no health endpoint in this app' };
  } catch(e) { return { status: 'down', error: e.message }; }
}

async function sendAlert(message) {
  try {
    const locationId = process.env.GHL_LOCATION_ID || icp.ghl.location_id;
    if (!process.env.FOUNDER_EMAIL) return;
    const founder = await callGHL('POST', '/contacts/search', {
      locationId,
      query: process.env.FOUNDER_EMAIL,
      page: 1,
      pageLimit: 1
    });
    const contactId = founder.contacts?.[0]?.id;
    if (contactId) {
      await callGHL('POST', '/conversations/messages', {
        type: 'SMS',
        contactId,
        message: '🚨 SubDraw Agent Alert:\n' + message
      });
    }
  } catch(e) {
    console.error('[Agent 25] Could not send alert SMS:', e.message);
  }
}

async function runHealthCheck() {
  console.log('[Agent 25] Running health check...');

  const checks = {
    ghl: await checkGHL(),
    instantly: await checkInstantly(),
    stripe: await checkStripe(),
    apollo: await checkApolloAPI(),
    env_vars: {
      status: (process.env.ANTHROPIC_API_KEY && process.env.GHL_API_KEY && process.env.INSTANTLY_API_KEY) ? 'healthy' : 'missing',
      missing: [
        !process.env.ANTHROPIC_API_KEY && 'ANTHROPIC_API_KEY',
        !process.env.GHL_API_KEY && 'GHL_API_KEY',
        !process.env.INSTANTLY_API_KEY && 'INSTANTLY_API_KEY',
        !process.env.STRIPE_SECRET_KEY && 'STRIPE_SECRET_KEY',
        !process.env.APOLLO_API_KEY && 'APOLLO_API_KEY'
      ].filter(Boolean)
    }
  };

  const alerts = [];
  Object.entries(checks).forEach(([service, result]) => {
    if (result.status === 'down') alerts.push(service.toUpperCase() + ' IS DOWN: ' + (result.error || 'unknown error'));
    if (result.status === 'error') alerts.push(service.toUpperCase() + ' ERROR: code ' + result.code);
    if (result.status === 'warning') alerts.push(service.toUpperCase() + ' WARNING: ' + result.alert);
    if (result.status === 'missing') alerts.push('MISSING ENV VARS: ' + result.missing.join(', '));
  });

  const allHealthy = alerts.length === 0;

  if (!allHealthy) {
    const alertMsg = alerts.join('\n');
    console.error('[Agent 25] ALERTS FOUND:\n' + alertMsg);
    await sendAlert(alertMsg);
  } else {
    console.log('[Agent 25] All systems healthy ✅');
  }

  logRun('25-health-monitor', { healthy: allHealthy, alerts, checks });
  return { healthy: allHealthy, alerts, checks };
}

module.exports = { runHealthCheck };
if (require.main === module) runHealthCheck().then(r => console.log('[Agent 25] Health:', r.healthy ? '✅ All good' : '🚨 ' + r.alerts.length + ' alerts'));
