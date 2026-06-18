/**
 * Railway Cron: Monday 6am
 * Finds new GC prospects and runs them through the full acquisition pipeline
 * 
 * FIX: Previous version had Agent 01 return search criteria (not contacts),
 * then ran its own separate Vibe/Apollo call that ignored Agent 01's output.
 * Now Agent 01 actually searches and returns real contacts.
 */
require('dotenv').config({ path: './config/.env' });
const { findProspects }         = require('../agents/01-prospect-finder');
const { screenProspects }       = require('../agents/02-pre-screener');
const { gatherIntelBatch }      = require('../agents/03-competitive-intel');
const { enrichBatch }           = require('../agents/33-lead-enrichment');
const { scoreBatch }            = require('../agents/34-icp-scorer');
const { scoutBatch }            = require('../agents/04-personalization-scout');
const { writeSequenceBatch }    = require('../agents/05-email-copywriter');
const { reviewBatch }           = require('../agents/06-quality-reviewer');
const { verifyContacts }        = require('../agents/07-data-verifier');
const { launchCampaigns }       = require('../agents/08-campaign-launcher');
const { logToGHL }              = require('../agents/09-crm-logger');
const { collectIntelligence }   = require('../agents/24-market-intelligence');
const { scoutExpansion }        = require('../agents/29-geographic-expansion-scout');
const { generateContentBriefs } = require('../agents/26-content-brief-generator');

async function main() {
  console.log('\n🔨 SubDraw Prospector Cron — ' + new Date().toISOString());
  const state = process.env.TARGET_STATE || 'California';
  const limit = parseInt(process.env.MAX_PROSPECTS_PER_RUN || '25');

  try {
    // Agent 01: Find real prospects (searches Apollo/Vibe, returns contact objects)
    const raw = await findProspects({ state, limit });

    if (!raw.length) {
      console.log('⚠️  No prospects found — check Apollo/Vibe API keys and credits');
      process.exit(0);
    }

    console.log('\n📋 Pipeline: ' + raw.length + ' raw → screening...');

    // Agent 02: Filter bad fits
    const screened = await screenProspects(raw);
    console.log('✓ Screened: ' + screened.length + ' passed');

    if (!screened.length) {
      console.log('⚠️  All prospects filtered out by pre-screener');
      process.exit(0);
    }

    // Agent 03: Competitive intel
    const withIntel = await gatherIntelBatch(screened);

    // Agent 33: Lead enrichment
    const withEnrichment = await enrichBatch(withIntel);

    // Agent 34: ICP scoring — sorts by score, best first
    const withICPScore = await scoreBatch(withEnrichment);

    // Agent 04: Personalization hooks
    const withHooks = await scoutBatch(withICPScore);

    // Agent 05: Write email sequences
    const withEmails = await writeSequenceBatch(withHooks);

    // Agent 06: Quality review — auto-rewrites anything under 8/10
    const { approved, rejected } = await reviewBatch(withEmails);
    console.log('✓ Quality: ' + approved.length + ' approved, ' + rejected.length + ' rejected');

    if (!approved.length) {
      console.log('⚠️  All emails rejected by quality reviewer');
      process.exit(0);
    }

    // Agent 07: Verify contact data
    const verified = await verifyContacts(approved);
    console.log('✓ Verified: ' + verified.length + ' contacts clean');

    // Agent 08: Push to Instantly campaign
    const { launched } = await launchCampaigns(verified);
    console.log('✓ Launched: ' + launched.length + ' into Instantly');

    // Agent 09: Log to GHL pipeline
    await logToGHL(launched);
    console.log('✓ Logged to GHL');

    // Agent 24: Collect market intelligence
    await collectIntelligence(launched);

    // Weekly Monday tasks
    await scoutExpansion();
    await generateContentBriefs();

    console.log('\n✅ Prospector complete');
    console.log('   Raw found:    ' + raw.length);
    console.log('   Screened:     ' + screened.length);
    console.log('   Approved:     ' + approved.length);
    console.log('   Verified:     ' + verified.length);
    console.log('   Launched:     ' + launched.length);
    console.log('   Rejected:     ' + rejected.length);

  } catch(e) {
    console.error('❌ Prospector error:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
}

main();
