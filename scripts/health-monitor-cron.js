/**
 * Railway Cron: Every 1 hour
 * System health check — alerts Shawn immediately if anything breaks
 */
require('dotenv').config({ path: './config/.env' });
const { runHealthCheck } = require('../agents/25-health-monitor');

async function main() {
  console.log('\n🏥 SubDraw Health Check — ' + new Date().toISOString());
  try {
    const result = await runHealthCheck();
    if (!result.healthy) process.exit(1);
  } catch(e) {
    console.error('Health monitor error:', e.message);
    process.exit(1);
  }
}

main();
