/**
 * Event-Driven Reply Server
 *
 * Replaces the 30-minute cron poll with instant webhook processing.
 *
 * When a GC replies to an email:
 *   Instantly webhook fires (< 1 second)
 *   → This server receives it
 *   → Classifies the reply (Agent 10)
 *   → Routes to correct agent (11, 13, 32)
 *   → Updates GHL pipeline stage
 *   → Notifies dashboard
 *   Total time: 3-8 seconds instead of up to 30 minutes
 *
 * Also handles:
 *   - Inbound SMS replies from GHL webhook
 *   - Inbound GHL email replies via 15-min poll (no GHL workflow needed)
 *
 * Webhook endpoints:
 *   POST /webhook/reply  — Instantly email webhooks
 *   POST /webhook/sms    — GHL SMS webhooks
 *   POST /webhook/ghl    — GHL generic webhooks (SMS + email)
 *   GET  /health         — Health check
 *   GET  /debug/failed   — Last 10 failed/dropped items
 *
 * GHL email reply detection:
 *   pollGhlEmailReplies() runs every 15 minutes and polls
 *   GET /conversations/search for inbound email messages.
 *   No manual GHL workflow required.
 */
require('dotenv').config({ path: './config/.env' });

const http = require('http');
const { classifyReplies, classifySingleReply } = require('../agents/10-reply-classifier');
const { sendDemoLink }     = require('../agents/11-demo-link-sender');
const { scheduleFollowUp } = require('../agents/32-followup-scheduler');
const { handleObjection }  = require('../agents/13-objection-handler');
const { notifyDashboard, logRun, callGHL } = require('../utils/helpers');

const PORT                     = process.env.REPLY_SERVER_PORT || 3001;
const MAX_BODY_BYTES           = 1_000_000; // 1MB — reject oversized payloads
const INSTANTLY_WEBHOOK_SECRET = process.env.INSTANTLY_WEBHOOK_SECRET || '';
const GHL_WEBHOOK_SECRET       = process.env.GHL_WEBHOOK_SECRET || '';
const GHL_LOCATION_ID          = process.env.GHL_LOCATION_ID || 'oe1TpmlDynQGFNdYLkaK';

const processedIds = new Set();

// Dead-letter store for items that fail after 3 retries.
// Inspect via GET /debug/failed
const failedQueue = [];

// Queue for processing — prevents hammering Claude API on burst webhook traffic
const replyQueue = [];
let isProcessing = false;

// ── Queue processor ────────────────────────────────────────────────────────────
async function processQueue() {
  if (isProcessing || replyQueue.length === 0) return;
  isProcessing = true;
  try {
    while (replyQueue.length > 0) {
      const item = replyQueue.shift();
      try {
        await processReply(item);
      } catch(e) {
        console.error('[ReplyServer] Process error:', e.message);
        // Retry up to 3 times before sending to dead-letter
        item._retryCount = (item._retryCount || 0) + 1;
        if (item._retryCount < 3) {
          replyQueue.push(item);
          console.log('[ReplyServer] Requeued for retry (attempt ' + item._retryCount + ')');
        } else {
          failedQueue.push({ ...item, failedAt: new Date().toISOString() });
          if (failedQueue.length > 100) failedQueue.shift(); // keep last 100
          console.error('[ReplyServer] Dropped after 3 attempts — source:', item.source);
        }
      }
      if (replyQueue.length > 0) await sleep(1000);
    }
  } finally {
    // FIX [MEDIUM]: always release the lock even if the while loop throws unexpectedly
    isProcessing = false;
  }
}

// ── GHL sequence stop ──────────────────────────────────────────────────────────
// Adds gc-seq-stop tag so ghl-email-sequence.js skips this contact going forward.
// Idempotent — safe to call on every reply.
async function stopGhlSequence(contactId, fromEmail) {
  if (!GHL_LOCATION_ID) {
    console.error('[stopGhlSequence] GHL_LOCATION_ID not set — skipping');
    return;
  }
  try {
    let contact;
    if (contactId) {
      const res = await callGHL('GET', `/contacts/${contactId}`);
      // GHL returns { contact: {...} } on single-contact GET
      contact = res?.contact || res;
    } else if (fromEmail) {
      const res = await callGHL('GET', `/contacts/?email=${encodeURIComponent(fromEmail)}&locationId=${GHL_LOCATION_ID}`);
      contact = res?.contacts?.[0];
    }

    if (!contact) {
      console.log('[stopGhlSequence] Contact not found:', contactId || fromEmail);
      return;
    }

    const existing = Array.isArray(contact.tags) ? contact.tags : [];
    if (!existing.includes('gc-seq-enrolled')) return; // not in GC sequence — nothing to stop
    if (existing.includes('gc-seq-stop')) return;      // already stopped — idempotent

    const id = contact.id;
    const mergedTags = [...new Set([...existing, 'gc-seq-stop'])];
    await callGHL('PUT', `/contacts/${id}`, { tags: mergedTags });
    console.log('[stopGhlSequence] Tagged gc-seq-stop for', id, '(', fromEmail || contactId, ')');
  } catch(err) {
    console.error('[stopGhlSequence] Error:', err.message);
  }
}

// ── Core reply processor ───────────────────────────────────────────────────────
async function processReply(data) {
  const { source, payload } = data;
  const start = Date.now();

  console.log('\n[ReplyServer] Processing ' + source + ' reply...');

  // Build a normalized reply object regardless of source
  let reply;

  if (source === 'instantly') {
    reply = {
      id:          payload.lead_id || payload.email_id,
      from_email:  payload.from_address || payload.lead_email,
      from_name:   payload.from_name || '',
      subject:     payload.subject || '',
      body:        payload.reply_text || payload.body || '',
      campaign_id: payload.campaign_id || '',
      timestamp:   payload.timestamp || new Date().toISOString(),
      source:      'email',
    };
  } else if (source === 'ghl_sms') {
    reply = {
      id:          payload.id || payload.messageId,
      from_phone:  payload.phone || payload.from,
      from_name:   payload.contact?.name || payload.contactName || '',
      contact_id:  payload.contactId || payload.contact?.id,
      body:        payload.body || payload.message || '',
      timestamp:   payload.dateAdded || new Date().toISOString(),
      source:      'sms',
    };
  } else if (source === 'ghl_email') {
    reply = {
      id:          payload.messageId || payload.id,
      from_email:  payload.from_email || payload.email || '',
      contact_id:  payload.contact_id || payload.contactId || '',
      body:        payload.body || '',
      source:      'email',
    };
  } else {
    return;
  }

  if (!reply.body || reply.body.trim().length < 2) {
    console.log('[ReplyServer] Skipping empty reply');
    return;
  }

  // Dedup across all sources
  const replyId = reply.id || ((reply.from_email || reply.from_phone) + ':' + reply.timestamp);
  if (replyId && processedIds.has(replyId)) {
    console.log('[ReplyServer] Skipping duplicate reply');
    return;
  }
  if (replyId) {
    if (processedIds.size > 10000) processedIds.clear(); // rolling window
    processedIds.add(replyId);
  }

  console.log('[ReplyServer] Source:', source, '| From:', reply.from_email || reply.from_phone, '| Body preview:', (reply.body || '').substring(0, 80));

  // Agent 10: classify
  const classification = await classifySingleReply(reply);
  console.log('[ReplyServer] Classified as:', classification.category, '(' + classification.confidence + ')');

  const category = classification.category;

  if (category === 'auto_reply') {
    console.log('[ReplyServer] Auto-reply — skipping sequence stop and routing');
    return;
  }

  // Stop GHL sequence for every real reply (not auto-replies)
  await stopGhlSequence(reply.contact_id, reply.from_email);

  // Route to the correct agent
  if (category === 'unsubscribe') {
    if (reply.contact_id) {
      await callGHL('POST', `/contacts/${reply.contact_id}/tags`, { tags: ['unsubscribed'] }).catch(() => {});
    }
  } else if (['interested', 'question_pricing', 'question_feature', 'question_integration'].includes(category)) {
    await sendDemoLink(reply, classification);
  } else if (['not_now', 'objection_timing'].includes(category)) {
    await scheduleFollowUp(reply, classification);
  } else if (['objection_price', 'objection_competitor', 'objection_size'].includes(category)) {
    await handleObjection(reply, classification);
  } else if (category === 'wrong_person') {
    if (reply.contact_id) {
      await callGHL('POST', `/contacts/${reply.contact_id}/notes`, {
        body: 'Wrong person — ' + classification.note + '\nReply: ' + reply.body,
      }).catch(() => {});
    }
  }

  const elapsed = Date.now() - start;
  console.log('[ReplyServer] Done in ' + elapsed + 'ms — category: ' + category);

  await notifyDashboard('reply_processed', {
    source:     reply.source,
    from:       reply.from_email || reply.from_phone,
    category,
    elapsed_ms: elapsed,
  });

  logRun('reply-server', { source, category, elapsed_ms: elapsed });
}

// ── Utilities ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Returns { parsed, raw } so callers can run HMAC on the raw string
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let rawBody = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        return reject(new Error('Request body too large'));
      }
      rawBody += chunk;
    });
    req.on('end', () => {
      try { resolve({ parsed: JSON.parse(rawBody), raw: rawBody }); }
      catch(e) { resolve({ parsed: {}, raw: rawBody }); }
    });
    req.on('error', reject);
  });
}

// FIX [HIGH]: was defined but never called — now wired into all webhook handlers below
function verifySignature(rawBody, signature, secret) {
  if (!secret) return true; // no secret configured — pass through (log warning in prod)
  const crypto = require('crypto');
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature || '', 'hex'), Buffer.from(expected, 'hex'));
  } catch { return false; }
}

// ── GHL email reply poller ─────────────────────────────────────────────────────
// Polls GET /conversations/search every 15 min for inbound emails.
// No manual GHL workflow required.
//
// FIX [CRITICAL]: ghlPollSeen key is added AFTER a successful body fetch.
// Previously the key was added before the fetch — a transient GHL error would
// permanently mark the conversation as seen, preventing gc-seq-stop from ever
// being applied to that contact.
const ghlPollSeen = new Set();

async function pollGhlEmailReplies() {
  try {
    const result = await callGHL('GET',
      `/conversations/search?locationId=${GHL_LOCATION_ID}&limit=50&sort=desc&sortBy=last_message_date`
    );
    const convs = result?.conversations || [];

    for (const conv of convs) {
      // Only care about inbound emails
      if (conv.lastMessageType !== 'TYPE_EMAIL' || conv.lastMessageDirection !== 'inbound') continue;

      // Use | separator — safer than : which could appear in IDs or ISO dates
      const msgKey = conv.id + '|' + conv.lastMessageDate;
      if (ghlPollSeen.has(msgKey)) continue;

      // Fetch the message body BEFORE marking seen.
      // If this throws (transient GHL error), we skip ghlPollSeen.add()
      // so the next poll cycle will retry this conversation.
      let body = '';
      try {
        const msgs = await callGHL('GET', `/conversations/${conv.id}/messages?limit=5`);
        const inboundMsg = (msgs?.messages || []).find(
          m => m.direction === 'inbound' && m.messageType === 'TYPE_EMAIL'
        );
        body = inboundMsg?.body || '';
      } catch(e) {
        console.error('[pollGhlEmailReplies] Body fetch failed for conv', conv.id, '—', e.message, '(will retry next poll)');
        continue; // do NOT mark seen — retry next cycle
      }

      // Mark seen only after successful body fetch
      ghlPollSeen.add(msgKey);
      if (ghlPollSeen.size > 5000) ghlPollSeen.clear();

      if (!body || body.trim().length < 3) continue;

      // FIX [LOW]: queue depth guard
      if (replyQueue.length > 500) {
        console.error('[pollGhlEmailReplies] Queue full — breaking poll loop');
        break;
      }

      replyQueue.push({ source: 'ghl_email', payload: {
        messageId:  msgKey,
        contact_id: conv.contactId || '',
        from_email: conv.email || '',
        body,
      }});
      setImmediate(processQueue);
      console.log('[pollGhlEmailReplies] Queued GHL email reply from', conv.email || conv.contactId);
    }
  } catch(err) {
    console.error('[pollGhlEmailReplies] Error:', err.message);
  }
}

// ── HTTP server ────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const { url, method } = req;

  // Health check — includes queue and failed-item counts
  if (method === 'GET' && url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status:     'ok',
      queue:      replyQueue.length,
      processing: isProcessing,
      failed:     failedQueue.length,
    }));
    return;
  }

  // Debug: inspect last 10 dead-lettered items
  if (method === 'GET' && url === '/debug/failed') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: failedQueue.length, items: failedQueue.slice(-10) }));
    return;
  }

  // ── Instantly webhook — email reply received ──────────────────────────────
  if (method === 'POST' && url === '/webhook/reply') {
    // Ack immediately — never make Instantly wait for processing
    res.writeHead(200);
    res.end('OK');

    let payload, rawBody;
    try {
      ({ parsed: payload, raw: rawBody } = await parseBody(req));
    } catch(e) {
      console.error('[ReplyServer] /webhook/reply body parse error:', e.message);
      return;
    }

    // FIX [HIGH]: verifySignature is now actually called
    const sig = req.headers['x-instantly-signature'] || req.headers['x-hub-signature-256'] || '';
    if (!verifySignature(rawBody, sig, INSTANTLY_WEBHOOK_SECRET)) {
      console.warn('[ReplyServer] Invalid Instantly signature — dropped');
      return;
    }

    const eventType = payload.event_type || payload.type || '';
    if (eventType.includes('reply') || eventType.includes('replied') || payload.reply_text || payload.body) {
      if (replyQueue.length > 500) {
        console.error('[ReplyServer] Queue full — dropping Instantly webhook');
        return;
      }
      replyQueue.push({ source: 'instantly', payload });
      setImmediate(processQueue);
      console.log('[ReplyServer] Queued Instantly reply — queue size: ' + replyQueue.length);
    }
    return;
  }

  // ── GHL webhook — SMS and/or email reply received ─────────────────────────
  if (method === 'POST' && (url === '/webhook/sms' || url === '/webhook/ghl')) {
    res.writeHead(200);
    res.end('OK');

    let payload, rawBody;
    try {
      ({ parsed: payload, raw: rawBody } = await parseBody(req));
    } catch(e) {
      console.error('[ReplyServer] /webhook/ghl body parse error:', e.message);
      return;
    }

    // FIX [HIGH]: verifySignature is now actually called
    const sig = req.headers['x-ghl-signature'] || req.headers['x-hub-signature-256'] || '';
    if (!verifySignature(rawBody, sig, GHL_WEBHOOK_SECRET)) {
      console.warn('[ReplyServer] Invalid GHL signature — dropped');
      return;
    }

    const type = payload.type || payload.messageType || '';

    // Inbound SMS
    if (type.includes('SMS') || type.includes('sms') || payload.direction === 'inbound') {
      if (payload.direction === 'inbound' || type.includes('Inbound') || payload.messageType === 'TYPE_SMS') {
        if (replyQueue.length > 500) {
          console.error('[ReplyServer] Queue full — dropping GHL SMS webhook');
        } else {
          replyQueue.push({ source: 'ghl_sms', payload });
          setImmediate(processQueue);
          console.log('[ReplyServer] Queued SMS reply — queue size: ' + replyQueue.length);
        }
      }
    }

    // Inbound email (belt-and-suspenders alongside the 15-min poll)
    if (payload.messageType === 'TYPE_EMAIL' && payload.direction === 'inbound') {
      const convId  = payload.conversationId || payload.id || '';
      const msgKey  = convId + '|' + (payload.dateAdded || '');
      if (!ghlPollSeen.has(msgKey)) {
        const emailBody = payload.body || payload.message || '';
        if (emailBody && emailBody.trim().length > 2) {
          if (replyQueue.length > 500) {
            console.error('[ReplyServer] Queue full — dropping GHL email webhook');
          } else {
            ghlPollSeen.add(msgKey);
            replyQueue.push({ source: 'ghl_email', payload: {
              messageId:  msgKey || payload.id,
              contact_id: payload.contactId || '',
              from_email: payload.from || payload.email || '',
              body:       emailBody,
            }});
            setImmediate(processQueue);
          }
        }
      }
    }
    return;
  }

  // Manual trigger for testing / catch-up
  if (method === 'POST' && url === '/trigger/check-replies') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'triggered', queue: replyQueue.length }));
    classifyReplies().catch(console.error);
    pollGhlEmailReplies().catch(console.error);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('\n SubDraw Reply Server running on port ' + PORT);
  console.log('   Webhook URL: https://your-reply-handler.railway.app/webhook/reply');
  console.log('   SMS URL:     https://your-reply-handler.railway.app/webhook/sms');
  console.log('   Health:      https://your-reply-handler.railway.app/health');
  console.log('   Failed:      https://your-reply-handler.railway.app/debug/failed');
  console.log('\n   Waiting for replies...\n');
});

// GHL email reply poll — every 15 min
setInterval(pollGhlEmailReplies, 15 * 60 * 1000);
setTimeout(pollGhlEmailReplies, 60 * 1000); // first run 60s after startup

// Fallback poll — every 30 min for any Instantly webhooks missed during downtime
setInterval(async () => {
  console.log('[ReplyServer] Fallback poll — checking for missed replies...');
  try {
    await classifyReplies();
  } catch(e) {
    console.error('[ReplyServer] Fallback poll error:', e.message);
  }
}, 30 * 60 * 1000);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[ReplyServer] Shutting down...');
  server.close(() => process.exit(0));
});
