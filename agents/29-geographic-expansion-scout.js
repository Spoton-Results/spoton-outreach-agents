/**
 * Agent 29: Geographic Expansion Scout
 * Every Monday pulls construction market signals by state
 * Identifies which states SubDraw should enter next
 * Based on: permit activity, GC density, competition gaps
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, logRun } = require('../utils/helpers');
const fs = require('fs');
const path = require('path');

const SYSTEM = `You are a geographic expansion analyst for SubDraw construction draw software.
Analyze construction market data by state and recommend expansion priorities.
Base recommendations on: construction permit volume, GC density, market maturity, competition.
Return JSON only.`;

const TARGET_STATES = ['Texas', 'Florida', 'Arizona', 'Nevada', 'Colorado', 'Georgia', 'North Carolina', 'Tennessee', 'Washington', 'Oregon'];

async function scoutExpansion() {
  console.log('[Agent 29] Scouting geographic expansion opportunities...');

  const prompt = `Analyze these US states for SubDraw construction draw software expansion:
States to evaluate: ${TARGET_STATES.join(', ')}
Current market: California (already targeting)

For each state, evaluate:
1. Construction permit volume (2025-2026 data)
2. Number of small-mid GCs (2-150 employees)
3. Market maturity for construction software adoption
4. Competition (are Procore/Buildertrend dominant or still spreadsheet market?)
5. SubDraw fit (residential vs commercial mix)

Rank top 3 states to enter next and explain why.
Return: {
  "top_3_states": [
    { "state": "...", "rank": 1, "reason": "...", "gc_density": "high|medium|low", "spreadsheet_market": true/false, "recommended_timing": "now|q3|q4" }
  ],
  "avoid_for_now": [...],
  "expansion_sequence": "recommended order to enter all states"
}`;

  const analysis = JSON.parse(await callClaude(SYSTEM, prompt));

  const outputPath = path.join(__dirname, '../config/expansion-plan.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify({ updated: new Date().toISOString(), ...analysis }, null, 2));

  logRun('29-geographic-expansion-scout', { top_next_state: analysis.top_3_states?.[0]?.state });
  console.log('[Agent 29] Top expansion target:', analysis.top_3_states?.[0]?.state);
  return analysis;
}

module.exports = { scoutExpansion };
if (require.main === module) scoutExpansion().then(r => console.log('[Agent 29] Done. Top state:', r.top_3_states?.[0]?.state));
