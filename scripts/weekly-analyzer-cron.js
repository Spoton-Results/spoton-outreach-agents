/**
 * Railway Cron: Sunday midnight
 * Weekly performance analysis + pricing review + partner prospecting
 */
require('dotenv').config({ path: './config/.env' });
const { analyzePerformance }       = require('../agents/20-ab-performance-analyzer');
const { analyzePricing }           = require('../agents/30-pricing-signal-monitor');
const { findPartners }             = require('../agents/27-partner-prospector');
const { runPartnerOutreach }       = require('../agents/23-partner-outreach');

async function main() {
  console.log('\n📊 SubDraw Weekly Analyzer — ' + new Date().toISOString());
  try {
    await analyzePerformance();
    await analyzePricing();

    // Find and reach out to new partner prospects
    const lenders  = await findPartners('construction_lender', process.env.TARGET_STATE || 'California', 10);
    const cpas     = await findPartners('construction_cpa', process.env.TARGET_STATE || 'California', 10);
    await runPartnerOutreach([...lenders, ...cpas]);

    console.log('\n✅ Weekly analysis complete');
  } catch(e) {
    console.error('Weekly analyzer error:', e.message);
    process.exit(1);
  }
}

main();
