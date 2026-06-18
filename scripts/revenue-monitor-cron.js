/**
 * Railway Cron: Every 2 hours
 * Monitors revenue, SMS high-intent leads, tracks demo engagement
 */
require('dotenv').config({ path: './config/.env' });
const { monitorRevenue }          = require('../agents/14-revenue-monitor');
const { runSMSAgent }             = require('../agents/15-sms-agent');
const { runDemoTracker }          = require('../agents/16-demo-engagement-tracker');
const { runDropoffDetector }      = require('../agents/21-funnel-dropoff-detector');
const { runReferralAgent }        = require('../agents/22-referral-trigger');
const { runExpansionAgent }       = require('../agents/18-expansion-agent');
const { sendChurnInterview }      = require('../agents/28-churn-interview');

async function main() {
  console.log('\n💰 SubDraw Revenue Monitor — ' + new Date().toISOString());
  try {
    await monitorRevenue();
    await runSMSAgent();
    await runDemoTracker();
    await runDropoffDetector();
    await runReferralAgent();
    await runExpansionAgent();
    console.log('\n✅ Revenue monitor complete');
  } catch(e) {
    console.error('Revenue monitor error:', e.message);
    process.exit(1);
  }
}

main();
