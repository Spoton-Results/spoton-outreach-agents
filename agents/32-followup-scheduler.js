/**
 * Agent 32: Follow-Up Scheduler
 * Fills the most expensive gap in the system "
 * when someone says "not now, try me in 3 months" this agent
 * parses the timeframe, calculates the exact follow-up date,
 * and writes it to GHL so Agent 12 picks it up automatically.
 *
 * Without this: warm leads disappear forever.
 * With this: every "not now" becomes a scheduled future opportunity.
 *
 * Triggered by: Agent 10 classifying a reply as "not_now"
 * Feeds into: Agent 12 daily 5am run checks follow_up_date
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are a follow-up scheduling agent for SubDraw sales outreach.
Parse a "not now" reply from a General Contractor and determine the exact follow-up date.

Common timeframes GCs say and what they mean:
- "try me in 3 months" ' 90 days
- "reach out in Q4" ' first day of Q4 (October 1)
- "after the holidays" ' January 8
- "next year" ' January 15 next year
- "busy season" / "after busy season" ' 90 days
- "after this project wraps" ' 60 days (assume 60 if no specific date)
- "not right now" / "maybe later" ' 45 days (default)
- "call me in 6 months" ' 180 days
- "end of year" ' December 1
- "next quarter" ' first day of next quarter
- no specific timeframe mentioned ' 45 days default

Return JSON only.`;

async function parseFollowUpDate(reply) {
  const today = new Date();

  const prompt = `Parse this "not now" reply and determine follow-up date:

Reply: "${reply.body?.substring(0, 400)}"
Today's date: ${today.toISOString().split('T')[0]}

Extract:
1. What timeframe did they mention (exact quote or "none stated")
2. How many days until follow-up
3. The exact follow-up date
4. A brief note to include when following up

Return: {
  "timeframe_mentioned": "...",
  "days_until_followup": X,
  "followup_date": "YYYY-MM-DD",
  "followup_note": "one sentence reminder of context " e.g. 'Said busy with Oak Street project, check back when it wraps'",
  "confidence": "high|medium|low"
}`;

  return JSON.parse(await callClaude(SYSTEM, prompt));
}

async function scheduleFollowUp(reply) {
  console.log('[Agent 32] Scheduling follow-up for:', reply.from_address);

  try {
    const schedule = await parseFollowUpDate(reply);
    const locationId = process.env.GHL_LOCATION_ID || icp.ghl.location_id;

    // Find the contact in GHL
    const contacts = await callGHL('GET', '/contacts/?email=' + encodeURIComponent(reply.from_address) + '&locationId=' + locationId);
    const contact = contacts.contacts?.[0];

    if (!contact) {
      console.log('[Agent 32] Contact not found for:', reply.from_address);
      return null;
    }

    // Validate Claude-returned date before writing to GHL
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!schedule.followup_date || !dateRegex.test(schedule.followup_date)) {
      console.error('[Agent 32] Invalid followup_date from Claude:', schedule.followup_date, '-- using 45-day default');
      const fallback = new Date();
      fallback.setDate(fallback.getDate() + 45);
      schedule.followup_date = fallback.toISOString().split('T')[0];
    }

    // Write follow-up date and note to GHL custom fields
    await callGHL('PUT', '/contacts/' + contact.id, {
      tags: [
        ...(contact.tags || []),
        'not-now',
        'scheduled-followup',
        'followup-' + schedule.followup_date
      ],
      customFields: [
        { key: 'follow_up_date', field_value: schedule.followup_date },
        { key: 'follow_up_note', field_value: schedule.followup_note },
        { key: 'not_now_reason', field_value: schedule.timeframe_mentioned },
        { key: 'follow_up_scheduled_on', field_value: new Date().toISOString().split('T')[0] }
      ]
    });

    // Also create a GHL task so it shows up in their task list
    try {
      await callGHL('POST', '/contacts/' + contact.id + '/tasks', {
        title: 'SubDraw follow-up " ' + schedule.followup_note,
        dueDate: new Date(schedule.followup_date).toISOString(),
        completed: false,
        description: 'Auto-scheduled by Agent 32. Original reply: ' + reply.body?.substring(0, 200)
      });
    } catch(e) {
      // Task creation is non-blocking " custom field is the source of truth
      console.log('[Agent 32] Task creation skipped:', e.message);
    }

    logRun('32-followup-scheduler', {
      contact: reply.from_address,
      followup_date: schedule.followup_date,
      days_out: schedule.days_until_followup,
      timeframe: schedule.timeframe_mentioned,
      confidence: schedule.confidence
    });

    console.log('[Agent 32] Scheduled follow-up for ' + reply.from_address + ' on ' + schedule.followup_date + ' (' + schedule.days_until_followup + ' days)');
    return { reply, schedule, contact };

  } catch(e) {
    console.error('[Agent 32] Error for ' + reply.from_address + ':', e.message);
    return null;
  }
}

async function scheduleFollowUps(classified) {
  const notNow = classified.filter(r =>
    r.classification?.category === 'not_now' ||
    r.classification?.next_action === 'follow_up_in_X_days'
  );

  console.log('[Agent 32] Scheduling follow-ups for ' + notNow.length + ' not-now replies...');
  if (!notNow.length) return [];

  const results = [];
  for (const reply of notNow) {
    const result = await scheduleFollowUp(reply);
    if (result) results.push(result);
  }

  console.log('[Agent 32] ' + results.length + ' follow-ups scheduled');
  return results;
}

module.exports = { scheduleFollowUps, scheduleFollowUp };
if (require.main === module) console.log('[Agent 32] Follow-up scheduler ready. Pass classified replies to scheduleFollowUps()');
