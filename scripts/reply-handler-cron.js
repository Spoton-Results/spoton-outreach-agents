/**
 * Railway Cron: Every 30 minutes
 * Processes all incoming replies from Instantly
 */
require('dotenv').config({ path: './config/.env' });
const { classifyReplies }       = require('../agents/10-reply-classifier');
const { sendDemoLinks }         = require('../agents/11-demo-link-sender');
const { handleObjections }      = require('../agents/13-objection-handler');
const { scheduleFollowUps }     = require('../agents/32-followup-scheduler');

async function main() {
  console.log('\n📬 SubDraw Reply Handler — ' + new Date().toISOString());
  try {
    const classified = await classifyReplies();
    if (classified.length > 0) {
      await sendDemoLinks(classified);
      await handleObjections(classified);
      await scheduleFollowUps(classified);
      console.log('\n✅ Replies processed:', classified.length);
    } else {
      console.log('No new replies');
    }
  } catch(e) {
    console.error('Reply handler error:', e.message);
    process.exit(1);
  }
}

main();
