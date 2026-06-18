/**
 * Agent 21: Funnel Drop-off Detector — REBUILT
 * Maps exactly to SubDraw's 14-step workflow from the canonical doc
 * Each drop-off stage has a specific message referencing the exact next step
 * Highest ROI agent — these people already said yes
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are a funnel recovery agent for SubDraw construction draw management software.
Write re-engagement emails for users who got stuck in the onboarding workflow.
Be specific about what step they're on — use SubDraw's actual workflow language.
Sound helpful, not salesy. They're already a user. Under 100 words. Return JSON only.

SubDraw's core workflow (in order):
1. Create project
2. Add subcontractors
3. Create contracts with scope and retainage %
4. Set up schedule of values
5. Open draw period
6. Subcontractors submit pay applications
7. Upload supporting docs (invoices, lien waivers, photos)
8. Submit draw (Draft → Submitted)
9. GC reviews and approves
10. Invoice generated
11. Payment tracked`;

async function findDropoffs() {
  console.log('[Agent 21] Scanning for funnel drop-offs...');
  try {
    const locationId = process.env.GHL_LOCATION_ID || icp.ghl.location_id;
    const dropoffs = [];

    // Map each drop-off stage to a GHL tag
    const stages = [
      { tag: 'dropoff-account-created', stage: 'account_created', label: 'Created account but never set up first project', next_step: 'Create your first project — takes 2 minutes' },
      { tag: 'dropoff-project-created', stage: 'project_created', label: 'Created project but never added subcontractors', next_step: 'Add your subcontractors to the project — they get notified automatically' },
      { tag: 'dropoff-subs-added', stage: 'subs_added', label: 'Added subcontractors but never created contracts', next_step: 'Create a contract — set the scope, contract value, and retainage %' },
      { tag: 'dropoff-contract-created', stage: 'contract_created', label: 'Created contract but never set up schedule of values', next_step: 'Add your schedule of values — this is what your subs bill against' },
      { tag: 'dropoff-sov-created', stage: 'sov_created', label: 'Set up SOV but never opened a draw period', next_step: 'Open your first draw period — your subs can then submit pay applications' },
      { tag: 'dropoff-draw-opened', stage: 'draw_opened', label: 'Opened draw but no pay applications submitted', next_step: 'Invite your subs to submit — they get a free login and submit directly' },
      { tag: 'dropoff-payapp-submitted', stage: 'payapp_submitted', label: 'Pay app submitted but never reviewed or approved', next_step: 'Review the pay application — approve, reject, or request revision in one click' }
    ];

    for (const stage of stages) {
      try {
        const contacts = await callGHL('GET', '/contacts/?locationId=' + locationId + '&tags=' + stage.tag + '&limit=50');
        (contacts.contacts || [])
          .filter(c => !c.tags?.includes('dropoff-email-sent'))
          .forEach(c => dropoffs.push({ ...c, dropoff_stage: stage.stage, dropoff_label: stage.label, next_step: stage.next_step }));
      } catch(e) { /* continue */ }
    }

    console.log('[Agent 21] Found ' + dropoffs.length + ' drop-offs');
    return dropoffs;
  } catch(e) {
    console.error('[Agent 21] Error:', e.message);
    return [];
  }
}

async function recoverDropoff(contact) {
  const prompt = `Write a re-engagement email for a SubDraw user who dropped off:

Contact: ${contact.firstName} ${contact.lastName} at ${contact.companyName || 'their company'}
Where they stopped: ${contact.dropoff_label}
Exact next step they need to take: ${contact.next_step}
Demo URL: ${icp.product.demo_url}

Reference the specific step they're on using SubDraw's workflow language.
Make it feel like a helpful nudge from someone who knows the platform.
Remind them: subs are free and submit directly — no extra work for the GC.
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
  if (!dropoffs.length) { console.log('[Agent 21] No drop-offs to recover'); return []; }
  return Promise.all(dropoffs.map(recoverDropoff));
}

module.exports = { runDropoffDetector };
if (require.main === module) runDropoffDetector().then(r => console.log('[Agent 21] Recovered:', r.length));
