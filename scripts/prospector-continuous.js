/**
 * Continuous Prospector — OpenAI Web Search Edition
 * Runs 24/7, finds real GC contacts every 5 minutes
 * Cost: ~$17/month for continuous operation
 */
require('dotenv').config({ path: './config/.env' });
const { findProspects } = require('../agents/01-prospect-finder');
const { notifyDashboard } = require('../utils/helpers');

const SLEEP_MS = parseInt(process.env.PROSPECTOR_SLEEP_MS || '300000'); // 5 min default

let runCount = 0;
let totalPushed = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('\n🔄 SubDraw Continuous Prospector — OpenAI Edition');
  console.log('   Model:  gpt-4o-mini + web_search_preview');
  console.log('   Cost:   ~$0.002/run = ~$17/month');
  console.log('   Sleep:  ' + (SLEEP_MS/60000).toFixed(1) + ' min between runs');
  console.log('   Target: CA → UT → TX → FL → AZ rotation\n');

  while (true) {
    runCount++;
    console.log(`\n═══════════════════════════════`);
    console.log(`Run #${runCount} | ${new Date().toLocaleTimeString()} | Total pushed: ${totalPushed}`);
    console.log(`═══════════════════════════════`);

    try {
      const results = await findProspects();
      totalPushed += results.length;
    } catch(e) {
      console.error('[Prospector] Run error:', e.message);
    }

    console.log(`\n[Prospector] Sleeping ${(SLEEP_MS/60000).toFixed(1)} min...`);
    await sleep(SLEEP_MS);
  }
}

process.on('SIGTERM', () => {
  console.log('\n[Prospector] Shutting down gracefully...');
  process.exit(0);
});

main().catch(e => {
  console.error('[Prospector] Fatal:', e.message);
  process.exit(1);
});
