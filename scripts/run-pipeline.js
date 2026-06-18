/**
 * SubDraw — Full 18-Agent Outreach Pipeline
 *
 * Usage:
 *   node scripts/run-pipeline.js                    full pipeline
 *   node scripts/run-pipeline.js --mode prospect    find + screen new GCs
 *   node scripts/run-pipeline.js --mode outreach    write + launch emails
 *   node scripts/run-pipeline.js --mode replies     process incoming replies
 *   node scripts/run-pipeline.js --mode monitor     revenue + re-engagement
 *   node scripts/run-pipeline.js --mode score       re-score all leads
 *   node scripts/run-pipeline.js --state Texas      target different state
 */
require('dotenv').config({ path: './config/.env' });

const { findProspects }            = require('../agents/01-prospect-finder');
const { screenProspects }          = require('../agents/02-pre-screener');
const { gatherIntelBatch }         = require('../agents/03-competitive-intel');
const { scoutBatch }               = require('../agents/04-personalization-scout');
const { writeSequenceBatch }       = require('../agents/05-email-copywriter');
const { reviewBatch }              = require('../agents/06-quality-reviewer');
const { verifyContacts }           = require('../agents/07-data-verifier');
const { launchCampaigns }          = require('../agents/08-campaign-launcher');
const { logToGHL }                 = require('../agents/09-crm-logger');
const { classifyReplies }          = require('../agents/10-reply-classifier');
const { sendDemoLinks }            = require('../agents/11-demo-link-sender');
const { findAndReengageColdLeads } = require('../agents/12-reengagement-tracker');
const { handleObjections }         = require('../agents/13-objection-handler');
const { monitorRevenue }           = require('../agents/14-revenue-monitor');
const { runSMSAgent }              = require('../agents/15-sms-agent');
const { runDemoTracker }           = require('../agents/16-demo-engagement-tracker');
const { scoreAllLeads }            = require('../agents/17-lead-scorer');
const { runExpansionAgent }        = require('../agents/18-expansion-agent');

// Apollo first, fall back to Vibe
const apollo = require('../utils/apollo-client');
const vibe   = require('../utils/vibe-client');

const args  = process.argv.slice(2);
const mode  = args.includes('--mode')  ? args[args.indexOf('--mode')  + 1] : 'full';
const state = args.includes('--state') ? args[args.indexOf('--state') + 1] : 'California';
const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : 25;

async function fetchProspects() {
  // Use Vibe first to burn remaining credits, then Apollo
  try {
    console.log('[Pipeline] Trying Vibe Prospecting (burns remaining credits)...');
    const results = await vibe.searchProspects({ state, limit });
    if (results.length > 0) { console.log('[Pipeline] Got ' + results.length + ' from Vibe'); return results; }
  } catch(e) { console.log('[Pipeline] Vibe failed, switching to Apollo:', e.message); }

  console.log('[Pipeline] Using Apollo...');
  return apollo.searchPeople({ state, limit });
}

async function runProspectMode() {
  console.log('\n--- PROSPECT MODE ---');
  const raw = await fetchProspects();
  const screened = await screenProspects(raw);
  const withIntel = await gatherIntelBatch(screened);
  const withHooks = await scoutBatch(withIntel);
  const withEmails = await writeSequenceBatch(withHooks);
  const { approved, rejected } = await reviewBatch(withEmails);
  const verified = await verifyContacts(approved);
  const { launched } = await launchCampaigns(verified);
  await logToGHL(launched);
  console.log('\n✅ Prospect Mode Done | Found:' + raw.length + ' → Launched:' + launched.length + ' | Rejected:' + rejected.length);
}

async function runRepliesMode() {
  console.log('\n--- REPLIES MODE ---');
  const classified = await classifyReplies();
  await sendDemoLinks(classified);
  await handleObjections(classified);
  console.log('\n✅ Replies Mode Done | Processed:' + classified.length);
}

async function runMonitorMode() {
  console.log('\n--- MONITOR MODE ---');
  await monitorRevenue();
  await runSMSAgent();
  await runDemoTracker();
  await findAndReengageColdLeads();
  await runExpansionAgent();
  console.log('\n✅ Monitor Mode Done');
}

async function runScoreMode() {
  console.log('\n--- SCORE MODE ---');
  await scoreAllLeads();
  console.log('\n✅ Score Mode Done');
}

async function main() {
  const start = Date.now();
  console.log('\n🔨 SubDraw 18-Agent Pipeline | Mode: ' + mode.toUpperCase() + ' | State: ' + state);

  try {
    switch(mode) {
      case 'prospect': await runProspectMode(); break;
      case 'replies':  await runRepliesMode();  break;
      case 'monitor':  await runMonitorMode();  break;
      case 'score':    await runScoreMode();    break;
      default:
        await runProspectMode();
        await runRepliesMode();
        await runMonitorMode();
        await runScoreMode();
    }
    console.log('\n✅ Total time: ' + Math.round((Date.now() - start) / 1000) + 's\n');
  } catch(err) {
    console.error('Pipeline error:', err.message);
    process.exit(1);
  }
}

main();
