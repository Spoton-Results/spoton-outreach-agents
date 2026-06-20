/**
 * Event-Driven Reply Server
 * 
 * Replaces the 30-minute cron poll with instant webhook processing.
 * 
 * When a GC replies to an email:
 *   Instantly webhook fires (< 1 second)
 *   ' This server receives it
 *   ' Classifies the reply (Agent 10)
 *   ' Routes to correct agent (11, 13, 32)
 *   ' Updates GHL pipeline stage
 *   ' Notifies dashboard
 *   Total time: 3-8 seconds instead of up to 30 minutes
 * 
 * Also handles inbound SMS replies from GHL webhook.
 * 
 * Register webhook URLs in Instantly:
 *   https://your-reply-handler-url/webhook/reply
 * 
 * Register in GHL:
 *   https://your-reply-handler-url/webhook/sms
 */
require('dotenv').config({ path: './config/.env' });

const http = require('http');
const { classifyReplies, classifySingleReply } = require('../agents/10-reply-classifier');
const { sendDemoLink }      = require('../agents/11-demo-link-sender');
const { scheduleFollowUp }  = require('../agents/32-followup-scheduler');
const { handleObjection }   = require('../agents/13-objection-handler');
const { notifyDashboard, logRun } = require('../utils/helpers');

const PORT = process.env.REPLY_SERVER_PORT || 3001;
const MAX_BODY_BYTES = 1_000_000; // 1MB -- reject oversized payloads
const INSTANTLY_WEBHOOK_SECRET = process.env.INSTANTLY_WEBHOOK_SECRET || '';
const GHL_WEBHOOK_SECRET = process.env.GHL_WEBHOOK_SECRET || '';
const processedIds = new Set();

// Queue for processing " prevents hammering Claude API if multiple replies come in at once
const replyQueue = [];
let isProcessing = false;

async function processQueue() {
  if (isProcessing || replyQueue.length === 0) return;
  isProcessing = true;

  while (replyQueue.length > 0) {
    const item = replyQueue.shift();
    try {
      await processReply(item);
    } catch(e) {
      console.error('[ReplyServer] Process error:', e.message);
    }
    // Small delay between replies to avoid Claude rate limits
    if (replyQueue.length > 0) await sleep(1000);
  }

  isProcessing = false;
}

async function processReply(data) {
  const { source, payload } = data;
  const start = Date.now();

  console.log('\n[ReplyServer] Processing ' + source + ' reply...');

  try {
    // Build normalized reply object regardless of source
    let reply;

    if (source === 'instantly') {
      reply = {
        id: payload.lead_id || payload.email_id,
        from_email: payload.from_address || payload.lead_email,
        from_name: payload.from_name || '',
        subject: payload.subject || '',
        body: payload.reply_text || payload.body || '',
        campaign_id: payload.campaign_id || '',
        timestamp: payload.timestamp || new Date().toISOString(),
        source: 'email'
      };
    } else if (source === 'ghl_sms') {
      reply = {
        id: payload.id || payload.messageId,
        from_phone: payload.phone || payload.from,
        from_name: payload.contact?.name || payload.contactName || '',
        contact_id: payload.contactId || payload.contact?.id,
        body: payload.body || payload.message || '',
        timestamp: payload.dateAdded || new Date().toISOString(),
        source: 'sms'
      };
    } else {
      return;
    }

    if (!reply.body || reply.body.trim().length < 2) {
      console.log('[ReplyServer] Skipping empty reply');
      return;
    }

    const replyId = reply.id || ((reply.from_email || reply.from_phone) + ':' + reply.timestamp);
    if (replyId && processedIds.has(replyId)) { console.log('[ReplyServer] Skipping duplicate reply'); return; }
    if (replyId) {
      if (processedIds.size > 10000) processedIds.clear(); // prevent unbounded memory growth
      processedIds.add(replyId);
    }

    // Log basic request info for production debugging
    console.log('[ReplyServer] Source:', source, '| From:', reply.from_email || reply.from_phone, '| Body preview:', (reply.body || '').substring(0, 80));
    console.log('[ReplyServer] Preview:', reply.body.substring(0, 80));

    // Agent 10: Classify the reply instantly
    const classification = await classifySingleReply(reply);
    console.log('[ReplyServer] Classified as:', classification.category, '(' + classification.confidence + ')');

    // Route to correct agent based on category
    const category = classification.category;

    if (category === 'auto_reply') {
      console.log('[ReplyServer] Auto-reply " skipping');
      return;
    }

    if (category === 'unsubscribe') {
      // GHL tag update only
      if (reply.contact_id) {
        const { callGHL } = require('../utils/helpers');
        await callGHL('POST', `/contacts/${reply.contact_id}/tags`, { tags: ['unsubscribed'] }).catch(() => {});
      }
    } else if (['interested', 'question_pricing', 'question_feature', 'question_integration'].includes(category)) {
      // Agent 11: Send demo link immediately
      await sendDemoLink(reply, classification);
    } else if (['not_now', 'objection_timing'].includes(category)) {
      // Agent 32: Schedule follow-up for the date they mentioned
      await scheduleFollowUp(reply, classification);
    } else if (['objection_price', 'objection_competitor', 'objection_size'].includes(category)) {
      // Agent 13: Handle the objection
      await handleObjection(reply, classification);
    } else if (category === 'wrong_person') {
      // Log to GHL and note who the right person is
      const { callGHL } = require('../utils/helpers');
      if (reply.contact_id) {
        await callGHL('POST', `/contacts/${reply.contact_id}/notes`, {
          body: 'Wrong person " ' + classification.note + '\nReply: ' + reply.body
        }).catch(() => {});
      }
    }

    const elapsed = Date.now() - start;
    console.log('[ReplyServer] " Done in ' + elapsed + 'ms " category: ' + category);

    // Notify dashboard
    await notifyDashboard('reply_processed', {
      source: reply.source,
      from: reply.from_email || reply.from_phone,
      category,
      elapsed_ms: elapsed
    });

    logRun('reply-server', { source, category, elapsed_ms: elapsed });

  } catch(e) {
    console.error('[ReplyServer] Error processing reply:', e.message);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Parse request body -- enforces MAX_BODY_BYTES to prevent OOM from large payloads
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        return reject(new Error('Request body too large'));
      }
      body += chunk;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch(e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

// Verify HMAC-SHA256 webhook signature
function verifySignature(payload, signature, secret) {
  if (!secret) return true; // No secret configured -- skip (warn in logs)
  const crypto = require('crypto');
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature || '', 'hex'), Buffer.from(expected, 'hex'));
  } catch { return false; }
}

// HTTP server
const server = http.createServer(async (req, res) => {
  const url = req.url;
  const method = req.method;

  // Health check
  if (method === 'GET' && url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', queue: replyQueue.length, processing: isProcessing }));
    return;
  }

  // Instantly webhook " email reply received
  if (method === 'POST' && url === '/webhook/reply') {
    res.writeHead(200); // Ack immediately " never make Instantly wait
    res.end('OK');

    const payload = await parseBody(req);
    const eventType = payload.event_type || payload.type || '';

    // Only process actual replies, not opens/clicks
    if (eventType.includes('reply') || eventType.includes('replied') || payload.reply_text || payload.body) {
      replyQueue.push({ source: 'instantly', payload });
      setImmediate(processQueue);
      console.log('[ReplyServer] Queued Instantly reply " queue size: ' + replyQueue.length);
    }
    return;
  }

  // GHL webhook " SMS reply received
  if (method === 'POST' && (url === '/webhook/sms' || url === '/webhook/ghl')) {
    res.writeHead(200);
    res.end('OK');

    const payload = await parseBody(req);
    const type = payload.type || payload.messageType || '';

    // Only process inbound SMS (replies from GCs)
    if (type.includes('SMS') || type.includes('sms') || payload.direction === 'inbound') {
      if (payload.direction === 'inbound' || type.includes('Inbound') || payload.messageType === 'TYPE_SMS') {
        replyQueue.push({ source: 'ghl_sms', payload });
        setImmediate(processQueue);
        console.log('[ReplyServer] Queued SMS reply " queue size: ' + replyQueue.length);
      }
    }
    return;
  }

  // Manual trigger for testing
  if (method === 'POST' && url === '/trigger/check-replies') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'triggered' }));
    // Fall back to polling check for any missed replies
    classifyReplies().catch(console.error);
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
  console.log('\n   Waiting for replies...\n');
});

// Still run a fallback poll every 30 min to catch any webhooks that were missed
setInterval(async () => {
  console.log('[ReplyServer] Fallback poll " checking for missed replies...');
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
