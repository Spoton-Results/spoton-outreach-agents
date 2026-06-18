# SubDraw — 13-Agent Outreach System

Autonomous sales pipeline for SubDraw construction draw management SaaS.
Targets General Contractors in California (expanding nationally).

## Agent Architecture

```
LAYER 1 — INTELLIGENCE
  01 Prospect Finder        Find CA GCs via Vibe Prospecting ICP search
  02 Pre-Screener           Filter — only real GCs who manage draws
  03 Competitive Intel      What draw tool are they on? Spreadsheets? Procore?
  04 Personalization Scout  Find the specific hook per GC (permits, hiring, projects)

LAYER 2 — CONTENT
  05 Email Copywriter       Write sequence + 3 follow-ups in construction language
  06 Quality Reviewer       Agent checks agent — kills AI-sounding copy
  07 Data Verifier          Validate contact before anything sends

LAYER 3 — EXECUTION
  08 Campaign Launcher      Push to Instantly SubDraw California GCs campaign
  09 CRM Logger             Create contact + opportunity in GHL pipeline

LAYER 4 — PIPELINE MANAGEMENT
  10 Reply Classifier       Sort replies: interested / not now / objection / unsubscribe
  11 Meeting Scheduler      Book 20-min demos for interested GCs via GHL
  12 Re-engagement Tracker  45-day cold lead revival with fresh construction angle
  13 Objection Handler      Handle price / competitor / timing objections
```

## Stack
- Claude API (claude-sonnet-4-6)
- GoHighLevel MCP
- Instantly (Campaign: SubDraw California GCs — launches July 7)
- Vibe Prospecting
- Railway (cron scheduling)

## Commands
```bash
npm run swarm      # full pipeline
npm run prospect   # find new GCs only
npm run outreach   # write + launch emails
npm run replies    # process incoming replies
npm run monitor    # re-engagement + cold leads
```

## Railway Services
- subdraw-prospector    → Monday 6am
- subdraw-outreach      → Daily 7am
- subdraw-reply-handler → Every 30 min
- subdraw-revenue-monitor → Every 2 hrs

## GHL IDs
- Location: oe1TpmlDynQGFNdYLkaK
- Pipeline: lu4BTmjYjJC2hZVKxj1t
- Stage Cold: 751975e9-c7f2-46a4-b821-e053bf505d8a
- Stage Emailed: a9cb193d-c634-41e2-b7eb-e0c6a24065ca
- Stage Replied: 32e745b6-97f5-4ad1-8b59-4652995f2176

## Instantly
- Campaign ID: bb1d4655-8d06-4218-89d4-ec196bc8ca81
- Launch: July 7, 2026 (automatic)
