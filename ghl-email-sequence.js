#!/usr/bin/env node
/**
 * GHL Email Sequence — SubDraw GC Outreach
 * -----------------------------------------
 * Daily cron runner (0 7 * * *) — sends up to DAILY_LIMIT emails/day
 * through GHL native email for the 4-step SubDraw cold outreach sequence.
 *
 * No Instantly. No manual GHL workflows. Pure code.
 *
 * Tag schema:
 *   gc-seq-enrolled        — contact is enrolled in the sequence
 *   gc-seq-1-YYYY-MM-DD    — email 1 sent on date (day 0)
 *   gc-seq-2-YYYY-MM-DD    — email 2 sent on date (day 3+)
 *   gc-seq-3-YYYY-MM-DD    — email 3 sent on date (day 7+)
 *   gc-seq-4-YYYY-MM-DD    — email 4 sent on date (day 14+)
 *   gc-seq-complete        — all 4 emails sent; sequence finished
 *   gc-seq-stop            — replied / opted out / do not contact
 *
 * Timing (measured from email 1 send date):
 *   Email 1 → day 0   (new enrollment)
 *   Email 2 → day 3+
 *   Email 3 → day 7+
 *   Email 4 → day 14+
 *
 * Step processing priority each day:
 *   Steps 4 → 3 → 2 → 1   (keep active sequences alive before new enrollments)
 *
 * Env vars (all from Railway shared):
 *   GHL_API_KEY       — required
 *   GHL_LOCATION_ID   — defaults to oe1TpmlDynQGFNdYLkaK
 *   DAILY_LIMIT       — emails per day (default 50)
 *   DRY_RUN           — set 'true' to log without sending
 *   DASHBOARD_URL     — dashboard webhook base (auto-set in helpers)
 */

require('dotenv').config({ path: './config/.env' });
const { logRun, pingDashboard, notifyDashboard, sleep } = require('./utils/helpers');

// ── Config ────────────────────────────────────────────────────────────────────
const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'oe1TpmlDynQGFNdYLkaK';
const DAILY_LIMIT     = parseInt(process.env.DAILY_LIMIT  || '50');
const PAGE_SIZE       = 100;
const DRY_RUN         = process.env.DRY_RUN === 'true';
const GHL_BASE        = 'https://services.leadconnectorhq.com';

if (!GHL_API_KEY) {
  console.error('[FATAL] Missing GHL_API_KEY');
  process.exit(1);
}

// ── Sequence timing: step → days after email 1 ───────────────────────────────
const SEQ_DELAYS = { 2: 3, 3: 7, 4: 14 };

// ── Email copy (SubDraw GC sequence) ─────────────────────────────────────────
const EMAILS = {
  1: {
    subject: 'quick question about your draws',
    body: (first) => `Hey ${first},

Do you verify every sub invoice line by line before you pay?

Most GCs I talk to say no — not because they're careless, but because the invoice hits the same day the draw is due.

That gap is where the money goes.

SubDraw closes it automatically. Free to check:
subdraw.com/login

–Shawn`,
  },
  2: {
    subject: '$8-15K per job',
    body: (first) => `Hey ${first},

That's the average a GC loses to sub invoice errors per job.

Duplicate line items. Work billed before completion. Materials that showed up 3 weeks later. It adds up quietly.

SubDraw catches all of it before you pay.

Takes 2 minutes to see if it would have caught anything on your last draw:
subdraw.com/login

–Shawn`,
  },
  3: {
    subject: "your lender's draw checklist",
    body: (first) => `Hey ${first},

One missing lien waiver. One invoice that doesn't match the schedule of values. One number that doesn't add up.

Your draw approval gets delayed 3-5 days. On an $800K monthly draw, that's real money.

SubDraw generates lender-ready packages automatically. Everything in order, first time:
subdraw.com/login

–Shawn`,
  },
  4: {
    subject: 'closing the loop',
    body: (first) => `Hey ${first},

Last note — I don't want to keep hitting your inbox.

If sub invoice protection isn't a priority right now, no worries.

If it is — or if you want to see what SubDraw would have caught on your last job — it takes 2 minutes:
subdraw.com/login

–Shawn`,
  },
};

// ── GHL fetch with retry + exponential backoff ────────────────────────────────
async function ghlFetch(endpoint, method = 'GET', body = null, queryParams = {}) {
  const { default: fetch } = await import('node-fetch');

  let url = GHL_BASE + endpoint;
  if (Object.keys(queryParams).length) {
    url += '?' + new URLSearchParams(queryParams).toString();
  }

  const headers = {
    Authorization: `Bearer ${GHL_API_KEY}`,
    Version: '2021-07-28',
    'Content-Type': 'application/json',
  };

  const MAX_RETRIES = 8;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : null,
        signal: AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined,
      });

      if (res.status === 429 || res.status >= 500) {
        const waitMs = attempt * 10000;
        log(`  GHL ${res.status} (attempt ${attempt}/${MAX_RETRIES}) — waiting ${waitMs / 1000}s`);
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`GHL ${res.status}: ${errText.substring(0, 200)}`);
      }

      return res.json();
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      if (!err.message.includes('GHL')) {
        // Network error — retry
        log(`  Network error (attempt ${attempt}/${MAX_RETRIES}): ${err.message} — retrying`);
        await sleep(attempt * 5000);
      } else {
        throw err;
      }
    }
  }
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ── Fetch ALL GHL contacts with email (cursor pagination) ─────────────────────
async function fetchAllContacts() {
  const contacts = [];
  let startAfterId = null;
  let page = 0;

  while (true) {
    page++;
    const params = { locationId: GHL_LOCATION_ID, limit: PAGE_SIZE };
    if (startAfterId) params.startAfterId = startAfterId;

    const data = await ghlFetch('/contacts/', 'GET', null, params);
    const batch = data?.contacts || [];

    if (page % 25 === 0) {
      log(`  Page ${page}: ${contacts.length + batch.length} contacts fetched`);
    }

    for (const c of batch) {
      if (c.email) contacts.push(c);
    }

    if (batch.length < PAGE_SIZE) break;
    startAfterId = batch[batch.length - 1].id;
    await sleep(300);  // respect GHL rate limits
  }

  return contacts;
}

// ── Parse sequence state from a contact's tags ────────────────────────────────
function parseSeqState(contact) {
  const tags = Array.isArray(contact.tags) ? contact.tags : [];
  const state = {
    enrolled: tags.includes('gc-seq-enrolled'),
    complete:  tags.includes('gc-seq-complete'),
    stop:      tags.includes('gc-seq-stop'),
    stepDates: {},   // { stepNumber: Date }
    tags,
  };

  for (const tag of tags) {
    const match = tag.match(/^gc-seq-(\d)-(\d{4}-\d{2}-\d{2})$/);
    if (match) {
      const step = parseInt(match[1]);
      const date = new Date(match[2] + 'T00:00:00Z');
      state.stepDates[step] = date;
    }
  }

  return state;
}

// ── Days elapsed since a date (UTC) ──────────────────────────────────────────
function daysSince(date) {
  const diffMs = Date.now() - date.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ── Determine which step (if any) is ready to send ───────────────────────────
function getNextStep(state) {
  if (state.stop || state.complete) return null;

  // New contact — not yet enrolled
  if (!state.enrolled) return 1;

  // Already enrolled — find highest completed step
  const completedSteps = Object.keys(state.stepDates).map(Number).sort((a, b) => a - b);
  if (!completedSteps.length) {
    // Enrolled tag exists but no step-date tag — was enrolled but email 1 not sent; resend
    return 1;
  }

  const highestStep = completedSteps[completedSteps.length - 1];
  if (highestStep >= 4) return null;  // sequence complete

  const nextStep = highestStep + 1;
  const email1Date = state.stepDates[1];
  if (!email1Date) return null;  // can't determine timing without anchor

  const daysRequired = SEQ_DELAYS[nextStep];
  if (daysSince(email1Date) >= daysRequired) return nextStep;

  return null;  // too early for next step
}

// ── Send one email and update contact tags ────────────────────────────────────
async function sendSeqEmail(contact, step, state) {
  const rawFirst = contact.firstName || contact.first_name || contact.name || '';
  const firstName = (rawFirst.split(' ')[0] || 'there').trim() || 'there';
  const email = EMAILS[step];
  const bodyText = email.body(firstName);
  const htmlBody = '<p>' + bodyText.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>') + '</p>';
  const newTag = `gc-seq-${step}-${todayStr()}`;

  const tagsToAdd = ['gc-seq-enrolled', newTag];
  if (step === 4) tagsToAdd.push('gc-seq-complete');

  if (DRY_RUN) {
    log(`  [DRY RUN] step=${step} email=${contact.email} name=${firstName} subject="${email.subject}"`);
    return true;
  }

  try {
    // Send via GHL conversations API
    await ghlFetch('/conversations/messages', 'POST', {
      type: 'Email',
      contactId: contact.id,
      subject: email.subject,
      body: bodyText,
      html: htmlBody,
    });

    // Merge new tags with existing — GHL PUT replaces all tags, so we must include current ones
    const mergedTags = [...new Set([...state.tags, ...tagsToAdd])];
    await ghlFetch(`/contacts/${contact.id}`, 'PUT', { tags: mergedTags });

    log(`  ✓ step=${step} → ${contact.email} (${firstName})`);
    return true;
  } catch (err) {
    log(`  ✗ step=${step} FAILED for ${contact.email}: ${err.message}`);
    return false;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log('══════════════════════════════════════════════');
  log('  GHL Email Sequence Runner — SubDraw GC');
  log(`  DAILY_LIMIT=${DAILY_LIMIT}  DRY_RUN=${DRY_RUN}`);
  log('══════════════════════════════════════════════');

  await pingDashboard(50, 'ok', `ghl-email-sequence starting — limit=${DAILY_LIMIT}`);

  // ── Step 1: Fetch all contacts ──────────────────────────────────────────────
  log('Fetching contacts from GHL...');
  const allContacts = await fetchAllContacts();
  log(`Total contacts with email: ${allContacts.length}`);

  // ── Step 2: Classify into step queues ─────────────────────────────────────
  const queues = { 1: [], 2: [], 3: [], 4: [] };
  const skipped = { stop: 0, complete: 0, notDue: 0 };

  for (const c of allContacts) {
    const state = parseSeqState(c);

    if (state.stop)    { skipped.stop++;     continue; }
    if (state.complete){ skipped.complete++;  continue; }

    const nextStep = getNextStep(state);
    if (nextStep === null) { skipped.notDue++; continue; }

    queues[nextStep].push({ contact: c, state });
  }

  const totalQueued = queues[1].length + queues[2].length + queues[3].length + queues[4].length;
  log(`Ready to send — step1:${queues[1].length} step2:${queues[2].length} step3:${queues[3].length} step4:${queues[4].length} (total=${totalQueued})`);
  log(`Skipped — stop:${skipped.stop} complete:${skipped.complete} notDue:${skipped.notDue}`);

  // ── Step 3: Send — priority: step4 → step3 → step2 → step1 ───────────────
  // Keep active sequences progressing before enrolling new contacts
  let sent = 0, failed = 0;
  const priority = [4, 3, 2, 1];

  outer:
  for (const step of priority) {
    for (const { contact, state } of queues[step]) {
      if (sent + failed >= DAILY_LIMIT) break outer;
      const ok = await sendSeqEmail(contact, step, state);
      if (ok) sent++; else failed++;
      await sleep(250);  // ~4 req/s to GHL
    }
  }

  // ── Step 4: Report ─────────────────────────────────────────────────────────
  const remaining = Math.max(0, totalQueued - (sent + failed));
  log(`══ Done: ${sent} sent, ${failed} failed, ${remaining} remaining in queue ══`);

  await notifyDashboard('email_sent', {
    service:   'ghl-email-sequence',
    sent,
    failed,
    queued:    totalQueued,
    remaining,
    dry_run:   DRY_RUN,
  });

  logRun('ghl-email-sequence', {
    sent, failed,
    queued:    totalQueued,
    skipped_stop:     skipped.stop,
    skipped_complete: skipped.complete,
    skipped_not_due:  skipped.notDue,
    daily_limit:      DAILY_LIMIT,
    dry_run:          DRY_RUN,
  });

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('[FATAL]', err.message || err);
  process.exit(1);
});
