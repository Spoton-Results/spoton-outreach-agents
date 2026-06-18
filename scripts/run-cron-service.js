const { spawn } = require("child_process");

const script = process.argv[2];
const intervalMinutes = Number(process.argv[3] || 60);

if (!script) {
  console.error("Missing script path.");
  process.exit(1);
}

function run() {
  console.log(`\n▶ Running ${script} at ${new Date().toISOString()}`);

  const child = spawn("node", [script], {
    stdio: "inherit",
    env: process.env
  });

  child.on("exit", code => {
    if (code === 0) {
      console.log(`✓ ${script} finished with code ${code}`);
    } else {
      console.error(`⚠ ${script} finished with code ${code}; keeping service alive`);
    }
  });

  child.on("error", err => {
    console.error(`⚠ Failed to start ${script}: ${err.message}`);
  });
}

run();
setInterval(run, intervalMinutes * 60 * 1000);

console.log(`Cron service alive: ${script} every ${intervalMinutes} minutes`);
