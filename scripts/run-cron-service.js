const { spawn } = require("child_process");

const script = process.argv[2];
const intervalMinutes = Number(process.argv[3] || 60);

if (!script) {
  console.error("Missing script path. Example: node scripts/run-cron-service.js scripts/health-monitor-cron.js 60");
  process.exit(1);
}

async function run() {
  console.log(`\n▶ Running ${script} at ${new Date().toISOString()}`);

  const child = spawn("node", [script], {
    stdio: "inherit",
    env: process.env
  });

  child.on("exit", code => {
    console.log(`✓ ${script} finished with code ${code}`);
  });
}

run();
setInterval(run, intervalMinutes * 60 * 1000);

console.log(`Cron service alive: ${script} every ${intervalMinutes} minutes`);
