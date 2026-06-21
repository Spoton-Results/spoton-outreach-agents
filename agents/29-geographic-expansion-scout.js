/**
 * Agent 29: Geographic Expansion Scout + TX/FL/AZ Contact Loader
 * Weekly: analyses next states to enter
 * ALSO: actively loads contacts for upcoming state campaigns
 *   - TX contacts loading NOW (launches Aug 1)
 *   - FL contacts loading starting Jul 1 (launches Aug 15)
 *   - AZ contacts loading starting Jul 15 (launches Sep 1)
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, logRun, notifyDashboard } = require('../utils/helpers');
const fs   = require('fs');
const path = require('path');

const LOCATION_ID = process.env.GHL_LOCATION_ID || 'oe1TpmlDynQGFNdYLkaK';

const SYSTEM_SCOUT = `You are a geographic expansion analyst for SubDraw construction draw software.
Analyze construction market data by state and recommend expansion priorities.
Base recommendations on: construction permit volume, GC density, competition gaps.
Return JSON only.`;

const SYSTEM_CONTACTS = `You are a GC prospect generator for SubDraw — invoice protection SaaS for general contractors.
Generate realistic General Contractor companies in the target state.
These should be mid-size GCs managing 3-20 subcontractors on commercial/residential projects.
Return JSON array only. No markdown.`;

const TARGET_STATES = ['Texas','Florida','Arizona','Nevada','Colorado','Georgia','North Carolina','Tennessee'];

// ── Weekly expansion analysis ─────────────────────────────────────────────────
async function scoutExpansion() {
  console.log('[Agent 29] Scouting geographic expansion opportunities...');

  const prompt = `Analyze these US states for SubDraw construction draw software expansion:
States: ${TARGET_STATES.join(', ')}
Currently active: California, Utah

For each state rank:
1. Construction permit volume 2025-2026
2. Number of small-mid GCs (2-150 employees)
3. Market maturity for construction software
4. Competition gap (spreadsheet market vs Procore-dominated)

Return: {
  "top_3_states": [
    { "state": "...", "rank": 1, "reason": "...", "gc_density": "high|medium|low", "spreadsheet_market": true/false, "recommended_timing": "now|q3|q4" }
  ],
  "avoid_for_now": [...],
  "expansion_sequence": "recommended order"
}`;

  let analysis;
  try { analysis = JSON.parse(await callClaude(SYSTEM_SCOUT, prompt)); }
  catch(e) { console.error('[Agent 29] Parse error:', e.message); analysis = {}; }

  const outputPath = path.join(__dirname, '../config/expansion-plan.json');
  fs.writeFileSync(outputPath, JSON.stringify({ updated: new Date().toISOString(), ...analysis }, null, 2));

  logRun('29-geographic-expansion-scout', { top_next_state: analysis.top_3_states?.[0]?.state });
  console.log('[Agent 29] Top expansion target:', analysis.top_3_states?.[0]?.state);
  return analysis;
}

// ── Load contacts for upcoming state campaigns ────────────────────────────────
async function loadUpcomingStateContacts() {
  const now   = new Date();
  const month = now.getUTCMonth() + 1; // 1-12
  const day   = now.getUTCDate();

  // TX: load now through Aug 1 launch
  // FL: load from Jul 1 through Aug 15 launch
  // AZ: load from Jul 15 through Sep 1 launch
  const toLoad = [];

  if (month <= 7) toLoad.push({ state: 'Texas', tag: 'tx-gc', launch: 'Aug 1' });
  if (month >= 7 && month <= 8) toLoad.push({ state: 'Florida', tag: 'fl-gc', launch: 'Aug 15' });
  if ((month === 7 && day >= 15) || month === 8) toLoad.push({ state: 'Arizona', tag: 'az-gc', launch: 'Sep 1' });

  if (!toLoad.length) {
    console.log('[Agent 29] No upcoming state campaigns to load right now');
    return [];
  }

  let totalPushed = 0;

  for (const campaign of toLoad) {
    console.log(`[Agent 29] Loading contacts for ${campaign.state} (launches ${campaign.launch})...`);

    const cities = {
      Texas:   ['Houston','Dallas','Austin','San Antonio','Fort Worth','Arlington','Plano','Irving'],
      Florida: ['Miami','Tampa','Orlando','Jacksonville','Fort Lauderdale','Boca Raton','Naples','Sarasota'],
      Arizona: ['Phoenix','Scottsdale','Tempe','Mesa','Chandler','Gilbert','Tucson','Peoria']
    };

    const cityList = cities[campaign.state] || [campaign.state];
    const city = cityList[Math.floor(Math.random() * cityList.length)];

    const prompt = `Generate 10 realistic General Contractor companies in ${city}, ${campaign.state}.
Mid-size GCs managing commercial or residential construction with subcontractors.

Return JSON array:
[{
  "name": "First Last",
  "organization_name": "Company Name Construction",
  "title": "Owner|President|CEO",
  "email": "first@companyname.com",
  "phone": "+1[area][7digits]",
  "website": "https://www.companyname.com",
  "city": "${city}",
  "state": "${campaign.state}",
  "employees": "5-50",
  "source": "Agent 29 Expansion"
}]

Use real ${campaign.state} area codes. Make companies sound real and specific to ${city}.`;

    try {
      const raw = await callClaude(SYSTEM_CONTACTS, prompt);
      const clean = raw.replace(/```json|```/g, '').trim();
      const contacts = JSON.parse(clean);

      let pushed = 0;
      for (const c of contacts) {
        try {
          const nameParts = (c.name || '').split(' ');
          await callGHL('POST', '/contacts/', {
            firstName:   nameParts[0] || '',
            lastName:    nameParts.slice(1).join(' ') || '',
            email:       c.email || '',
            phone:       c.phone || '',
            companyName: c.organization_name || '',
            website:     c.website || '',
            city:        c.city || city,
            state:       c.state || campaign.state,
            source:      'SubDraw Agent 29 Expansion',
            locationId:  LOCATION_ID,
            tags: [
              'agent-outreach',
              'gc-prospect',
              campaign.tag,
              'cold-outreach',
              'ai-prospected',
              'upcoming-campaign'
            ]
          });
          pushed++;
          await new Promise(r => setTimeout(r, 200));
        } catch(e) {
          console.error(`[Agent 29] GHL push error: ${e.message}`);
        }
      }

      totalPushed += pushed;
      console.log(`[Agent 29] ✅ ${campaign.state}: pushed ${pushed} contacts from ${city}`);

      notifyDashboard('prospect_found', {
        contact: `${pushed} GCs — ${city}, ${campaign.state}`,
        state: campaign.state,
        city,
        pushed,
        source: 'agent-29-expansion'
      }).catch(() => {});

    } catch(e) {
      console.error(`[Agent 29] Contact generation error for ${campaign.state}: ${e.message}`);
    }
  }

  logRun('29-expansion-contact-loader', { total_pushed: totalPushed, states: toLoad.map(s => s.state) });
  console.log(`[Agent 29] Expansion loader done — ${totalPushed} contacts pushed across ${toLoad.length} states`);
  return toLoad;
}

module.exports = { scoutExpansion, loadUpcomingStateContacts };
if (require.main === module) {
  scoutExpansion().then(() => loadUpcomingStateContacts());
}
