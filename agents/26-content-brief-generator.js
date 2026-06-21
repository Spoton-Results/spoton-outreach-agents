/**
 * Agent 26: Content Brief Generator
 * Runs every Monday — builds inbound while outbound runs
 * Pulls top GC search queries, writes detailed blog briefs
 * Pushes to Notion for publishing
 * One ranked article brings leads forever. Cold email stops when you stop sending.
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, logRun } = require('../utils/helpers');
const fs = require('fs');
const path = require('path');

const SYSTEM = `You are a content strategist for SubDraw construction draw management software.
Create SEO-optimized blog briefs targeting General Contractors searching for draw management solutions.
Focus on high-intent keywords GCs actually search.
Be specific — include exact H2s, word count, internal links, and CTAs.
Return JSON only.`;

const GC_SEARCH_TOPICS = [
  'how to manage construction draws',
  'construction draw request process',
  'AIA G702 G703 draw request template',
  'construction loan draw schedule template',
  'how to submit draw request to lender',
  'construction retainage tracking spreadsheet',
  'lien waiver management construction',
  'construction draw software for small contractors',
  'how to speed up construction loan draws',
  'construction draw management vs spreadsheets'
];

async function generateContentBriefs() {
  console.log('[Agent 26] Generating weekly content briefs...');
  const briefs = [];

  // Pick 3 topics this week (rotate through the list)
  const weekNumber = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
  const startIdx = (weekNumber * 3) % GC_SEARCH_TOPICS.length;
  const thisWeekTopics = GC_SEARCH_TOPICS.slice(startIdx, startIdx + 3);

  for (const topic of thisWeekTopics) {
    const prompt = `Create a detailed blog brief for SubDraw targeting this search query: "${topic}"

SubDraw is construction draw management software at $149-$599/month for General Contractors.
The CTA is always: try free at subdraw.com/login

Create a brief with:
1. SEO title (under 60 chars, include keyword)
2. Meta description (under 155 chars)
3. Target keyword + 3 related keywords
4. Estimated word count (800-1500 words)
5. H2 outline (5-7 sections)
6. Key points for each section
7. Internal CTA placement (where to mention SubDraw naturally)
8. Competitor content to beat (what's currently ranking)

Return: {
  "title": "...",
  "meta_description": "...",
  "primary_keyword": "...",
  "related_keywords": [...],
  "word_count": X,
  "outline": [{ "h2": "...", "key_points": [...] }],
  "cta_placement": "...",
  "target_intent": "informational|commercial|transactional"
}`;

    let brief; try { brief = JSON.parse(await callClaude(SYSTEM, prompt)); } catch(e) { console.error("[Agent 26] Parse error:", e.message); continue; }
    briefs.push({ topic, brief });
  }

  // Save briefs to file for review
  const briefsPath = path.join(__dirname, '../logs/content-briefs-' + new Date().toISOString().split('T')[0] + '.json');
  const logsDir = path.dirname(briefsPath);
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(briefsPath, JSON.stringify(briefs, null, 2));

  logRun('26-content-brief-generator', { briefs_created: briefs.length, topics: thisWeekTopics });
  console.log('[Agent 26] ' + briefs.length + ' content briefs generated → ' + briefsPath);
  return briefs;
}

module.exports = { generateContentBriefs };
if (require.main === module) generateContentBriefs().then(r => console.log('[Agent 26] Done:', r.length, 'briefs'));
