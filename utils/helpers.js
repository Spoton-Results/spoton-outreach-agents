const fs = require('fs');
const path = require('path');

async function callClaude(systemPrompt, userPrompt, options = {}) {
  const fetch = (await import('node-fetch')).default;

  // ── Try Anthropic first ───────────────────────────────────────────────────
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
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

      // 529 = overloaded, 529/402/529 = credit exhausted — fall through to OpenAI
      if (response.status === 402 || response.status === 529) {
        console.warn('[callClaude] Anthropic credit/capacity issue — falling back to OpenAI');
      } else if (!response.ok) {
        throw new Error('Claude API error: ' + response.status);
      } else {
        const data = await response.json();
        if (data.content?.[0]?.text) {
          return data.content[0].text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        }
        console.warn('[callClaude] Anthropic returned empty — falling back to OpenAI');
      }
    } catch (e) {
      if (e.message.includes('Claude API error')) throw e; // hard error, don't fallback
      console.warn('[callClaude] Anthropic error, trying OpenAI:', e.message);
    }
  }

  // ── Fallback: OpenAI GPT-4o-mini ─────────────────────────────────────────
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Both Anthropic and OpenAI unavailable — check API keys and credits');
  }

  console.log('[callClaude] Using OpenAI fallback');
  const oaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
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

  if (!oaiRes.ok) throw new Error('OpenAI fallback error: ' + oaiRes.status + ' ' + (await oaiRes.text()).substring(0, 200));
  const oaiData = await oaiRes.json();
  const text = oaiData.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI returned empty content');
  return text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
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
