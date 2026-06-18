/**
 * Agent 21: Funnel Drop-off Detector
 * THE HIGHEST ROI AGENT — these people already said yes
 * Watches for accounts that:
 *   - Created account but never completed setup
 *   - Completed setup but never created a draw
 *   - Created a draw but never submitted to lender
 * Each stage gets a specific re-engagement with exact next step
 * Runs every 2 hours
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are a funnel recovery agent for SubDraw construction draw software.
Write re-engagement emails for users who got stuck in the onboarding funnel.
Be specific about what step they're on and give them exactly one action to take.
Sound helpful — they're already interested, they just got stuck.
Under 100 words. Return JSON only.`;

async function findDropoffs() {
  console.log('[Agent 21] Scanning for funnel drop-offs...');
  // In production: query SubDraw app database on Railway for incomplete onboarding
  // Tags used: 'signup-incomplete', 'setup-incomplete', 'draw-not-submitted'
  try {
    const locationId = process.env.GHL_LOCATION_ID || icp.ghl.location_id;
    const dropoffs = [];

    // Stage 1: Signed up but never completed profile
    const stage1 = await callGHL('GET', '/contacts/?locationId=' + locationId + '&tags=signup-incomplete&limit=50');
    (stage1.contacts || []).forEach(c => dropoffs.push({ ...c, dropoff_stage: 'signup', dropoff_label: 'created account but never finished setup' }));

    // Stage 2: Setup done but never created a draw
    const stage2 = await callGHL('GET', '/contacts/?locationId=' + locationId + '&tags=setup-complete,draw-not-started&limit=50');
    (stage2.contacts || []).forEach(c => dropoffs.push({ ...c, dropoff_stage: 'draw_creation', dropoff_label: 'finished setup but never created first draw' }));

    // Stage 3: Draw created but never submitted to lender
    const stage3 = await callGHL('GET', '/contacts/?locationId=' + locationId + '&tags=draw-created,draw-not-submitted&limit=50');
    (stage3.contacts || []).forEach(c => dropoffs.push({ ...c, dropoff_stage: 'submission', dropoff_label: 'created draw but never submitted to lender' }));

    // Filter out ones already re-engaged
    return dropoffs.filter(c => !c.tags?.includes('dropoff-email-sent'));
  } catch(e) {
    console.error('[Agent 21] GHL error:', e.message);
    return [];
  }
}

async function recoverDropoff(contact) {
  const stageMessages = {
    signup: 'They created a SubDraw account but never finished the setup profile. They need to complete step 2: adding their first project.',
    draw_creation: 'They finished setup but never created their first draw request. They need to click New Draw and fill in the basic project info.',
    submission: 'They created a draw but never submitted it to their lender. One click sends the complete package — they might not know it is ready.'
  };

  const prompt = `Write a re-engagement email for a SubDraw user who dropped off:

Contact: ${contact.firstName} ${contact.lastName}
Drop-off: ${contact.dropoff_label}
Context: ${stageMessages[contact.dropoff_stage]}
Demo URL: ${icp.product.demo_url}

Give them the ONE specific action they need to take next.
Make it feel like a helpful nudge not a sales email.
Under 100 words.

Return: { "subject": "...", "body": "..." }`;

  const email = JSON.parse(await callClaude(SYSTEM, prompt));

  try {
    await callGHL('POST', '/conversations/messages', {
      type: 'Email',
      contactId: contact.id,
      subject: email.subject,
      body: email.body,
      html: '<p>' + email.body.replace(/\n/g, '<br>') + '</p>'
    });
    await callGHL('PUT', '/contacts/' + contact.id, {
      tags: [...(contact.tags || []), 'dropoff-email-sent']
    });
    logRun('21-funnel-dropoff-detector', { recovered: contact.email, stage: contact.dropoff_stage });
  } catch(e) {
    console.error('[Agent 21] Send error:', e.message);
  }

  return { contact, email };
}

async function runDropoffDetector() {
  const dropoffs = await findDropoffs();
  console.log('[Agent 21] Found ' + dropoffs.length + ' drop-offs to recover');
  if (!dropoffs.length) return [];
  return Promise.all(dropoffs.map(recoverDropoff));
}

module.exports = { runDropoffDetector };
if (require.main === module) runDropoffDetector().then(r => console.log('[Agent 21] Recovered:', r.length));
