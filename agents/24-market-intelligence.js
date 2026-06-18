/**
 * Agent 24: Market Intelligence Collector
 * Stores competitive signals from every agent run into a structured database
 * After 90 days you have data nobody else has
 * Runs after every prospect batch — passive collection
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, logRun } = require('../utils/helpers');
const fs = require('fs');
const path = require('path');

const SYSTEM = `You are a market intelligence agent for SubDraw.
Analyze prospect data patterns to extract market insights.
Look for: tool adoption rates, company size patterns, geographic clusters, pain point frequency.
Return JSON only.`;

const INTEL_DB = path.join(__dirname, '../logs/market-intelligence.json');

function loadIntelDB() {
  if (fs.existsSync(INTEL_DB)) return JSON.parse(fs.readFileSync(INTEL_DB, 'utf8'));
  return { updated: null, total_prospects_analyzed: 0, tool_adoption: {}, pain_points: {}, geographic_density: {}, company_size_distribution: {}, conversion_by_segment: {}, insights: [] };
}

function saveIntelDB(data) {
  const logsDir = path.dirname(INTEL_DB);
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(INTEL_DB, JSON.stringify(data, null, 2));
}

async function collectIntelligence(prospects) {
  if (!prospects?.length) return;
  console.log('[Agent 24] Collecting market intelligence from ' + prospects.length + ' prospects...');

  const db = loadIntelDB();
  db.total_prospects_analyzed += prospects.length;
  db.updated = new Date().toISOString();

  // Aggregate tool adoption
  prospects.forEach(p => {
    if (p.intel?.current_tool) {
      const tool = p.intel.current_tool.toLowerCase();
      db.tool_adoption[tool] = (db.tool_adoption[tool] || 0) + 1;
    }
    if (p.intel?.primary_pain) {
      const pain = p.intel.primary_pain.toLowerCase().substring(0, 50);
      db.pain_points[pain] = (db.pain_points[pain] || 0) + 1;
    }
    if (p.state) {
      db.geographic_density[p.state] = (db.geographic_density[p.state] || 0) + 1;
    }
    if (p.employees) {
      const bucket = p.employees <= 10 ? '1-10' : p.employees <= 25 ? '11-25' : p.employees <= 50 ? '26-50' : '51+';
      db.company_size_distribution[bucket] = (db.company_size_distribution[bucket] || 0) + 1;
    }
  });

  // Weekly AI insight generation
  if (db.total_prospects_analyzed % 50 === 0) {
    const prompt = `Analyze this SubDraw market intelligence data and generate 3 actionable insights:
${JSON.stringify(db, null, 2)}

What patterns are emerging? What should change about the outreach strategy?
Return: { "insights": ["insight 1", "insight 2", "insight 3"], "recommended_pivot": "..." }`;

    try {
      const analysis = JSON.parse(await callClaude(SYSTEM, prompt));
      db.insights = [...(db.insights || []), { date: new Date().toISOString(), ...analysis }].slice(-10);
    } catch(e) { /* non-blocking */ }
  }

  saveIntelDB(db);
  logRun('24-market-intelligence', { total_analyzed: db.total_prospects_analyzed, top_tool: Object.entries(db.tool_adoption).sort((a,b) => b[1]-a[1])[0]?.[0] });
}

async function getInsights() {
  const db = loadIntelDB();
  return db;
}

module.exports = { collectIntelligence, getInsights };
