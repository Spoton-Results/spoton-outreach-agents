const fs = require('fs');
const path = require('path');

/**
 * AI Router — callClaude
 *
 * Priority:
 *   DEFAULT  → OpenAI GPT-4o-mini (fast, cheap, handles 90% of tasks)
 *   QUALITY  → Claude Sonnet (email copy, objections, personalization)
 *   FALLBACK → if primary fails, auto-switches to the other
 *
 * Pass options.quality = true to force Claude for high-stakes tasks.
 * Agents that always use Claude: 04, 05, 06, 13, 38
 */
async function callClaude(systemPrompt, userPrompt, options = {}) {
  const fetch = (await import('node-fetch')).default;

  // Quality flag forces Claude regardless of default priority
  const useClaudeFirst = options.quality === true;

  async function tryOpenAI() {
    if (!process.env.OPENAI_API_KEY) throw new Error('No OPENAI_API_KEY set');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY
      },
      body: JSON.stringify({
        model: options.oai_model || 'gpt-4o-mini',
        max_tokens: options.max_tokens || 2000,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      })
    });
    if (!res.ok) throw new Error('OpenAI error: ' + res.status + ' ' + (await res.text()).substring(0, 200));
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('OpenAI returned empty content');
    return text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  }

  async function tryClaude() {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('No ANTHROPIC_API_KEY set');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: options.max_tokens || 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });
    if (res.status === 402 || res.status === 529) throw new Error('Anthropic credits/capacity: ' + res.status);
    if (!res.ok) throw new Error('Claude error: ' + res.status);
    const data = await res.json();
    const text = data.content?.[0]?.text;
    if (!text) throw new Error('Claude returned empty content');
    return text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  }

  if (useClaudeFirst) {
    // Quality tasks: Claude first, OpenAI fallback
    try {
      return await tryClaude();
    } catch(e) {
      console.warn('[AI Router] Claude failed (' + e.message + ') — falling back to OpenAI GPT-4o');
      return await tryOpenAI();
    }
  } else {
    // Standard tasks: OpenAI first (cheaper), Claude fallback
    try {
      return await tryOpenAI();
    } catch(e) {
      console.warn('[AI Router] OpenAI failed (' + e.message + ') — falling back to Claude');
      return await tryClaude();
    }
  }
}

async function callGHL(method, endpoint, body = null) {
  const fetch = (await import('node-fetch')).default;
  const res = await fetch('https://services.leadconnectorhq.com' + endpoint, {
    method,
    headers: {
      'Authorization': 'Bearer ' + process.env.GHL_API_KEY,
      'Content-Type': 'application/json',
      'Version': '2021-07-28'
    },
    body: body ? JSON.stringify(body) : null
  });
  if (!res.ok) throw new Error('GHL error: ' + res.status + ' ' + (await res.text()).substring(0, 200));
  return res.json();
}

async function callInstantly(method, endpoint, body = null) {
  const fetch = (await import('node-fetch')).default;
  const res = await fetch('https://api.instantly.ai/api/v1' + endpoint, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + process.env.INSTANTLY_API_KEY
    },
    body: body ? JSON.stringify(body) : null
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error('Instantly error: ' + res.status + ' ' + errText.substring(0, 300));
  }
  return res.json();
}

function logRun(agentName, data) {
  const logsDir = path.join(__dirname, '../logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const entry = JSON.stringify({ timestamp: new Date().toISOString(), agent: agentName, ...data });
  fs.appendFileSync(path.join(logsDir, new Date().toISOString().split('T')[0] + '.jsonl'), entry + '\n');
  console.log('[' + agentName + ']', JSON.stringify(data));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { callClaude, callGHL, callInstantly, logRun, sleep };

// "" Dashboard webhook notifier """"""""""""""""""""""""""""""""""""""""""""""
// Every agent action posts to the dashboard for real-time activity feed

async function pingDashboard(agentId, status='ok', detail='') {
  try {
    const url = process.env.DASHBOARD_URL || 'https://dashboard-production-f04a.up.railway.app';
    const fetch = (await import('node-fetch')).default;
    await fetch(url + '/api/agent-heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: agentId, status, detail }),
      signal: AbortSignal.timeout ? AbortSignal.timeout(3000) : undefined
    });
  } catch(e) { /* silent — never block agent execution */ }
}
module.exports.pingDashboard = pingDashboard;

async function notifyDashboard(type, data) {
  const url = process.env.DASHBOARD_URL || 'https://dashboard-production-f04a.up.railway.app';
  try {
    const fetch = (await import('node-fetch')).default;
    await fetch(url + '/webhook/ghl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, source: 'agent', ...data }),
      timeout: 3000
    });
  } catch(e) {
    // Non-blocking " never fail because dashboard is down
  }
}

module.exports.notifyDashboard = notifyDashboard;
