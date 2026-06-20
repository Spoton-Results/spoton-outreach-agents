/**
 * Railway Cron: Daily 5am
 * Morning briefing + lead scoring + health check
 */
require('dotenv').config({ path: './config/.env' });
const { generateBriefing } = require('../agents/19-daily-briefing');
const { scoreAllLeads }    = require('../agents/17-lead-scorer');
const { runHealthCheck }   = require('../agents/25-health-monitor');
const { findAndReengageColdLeads } = require('../agents/12-reengagement-tracker');
const { detectCrossSellOpportunities } = require('../agents/31-crosssell-detector');
const { runDormantRecovery } = require('../agents/35-dormant-pipeline-recovery');

async function main() {
  console.log('\n... SubDraw Daily Briefing " ' + new Date().toISOString());
  try {
    await runHealthCheck();
    await scoreAllLeads();
    await findAndReengageColdLeads();
    await runDormantRecovery();
    await detectCrossSellOpportunities();
    await generateBriefing();
    console.log('\n... Daily briefing complete');
  } catch(e) {
    console.error('Daily briefing error:', e.message);
    process.exit(1);
  }
}

main();
