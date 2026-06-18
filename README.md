# SubDraw — 31-Agent Autonomous Growth System

Complete autonomous sales, retention, and intelligence engine for SubDraw construction draw management SaaS.
Zero human intervention required between prospect discovery and paid customer.

## The Full Stack

```
LAYER 1 — FIND & QUALIFY (Agents 01-04)
  01 Prospect Finder        Apollo/Vibe search for GCs by state
  02 Pre-Screener           Filter to real GCs who manage draws
  03 Competitive Intel      What tool are they on? Spreadsheets? Procore?
  04 Personalization Scout  Specific hook per GC (permits, hiring, projects)

LAYER 2 — CREATE & SEND (Agents 05-09)
  05 Email Copywriter       4-email sequence in construction language
  06 Quality Reviewer       Agent checks agent — kills AI-sounding copy
  07 Data Verifier          Validate contacts before send
  08 Campaign Launcher      Push to Instantly SubDraw California GCs
  09 CRM Logger             Create contact + opportunity in GHL

LAYER 3 — WORK REPLIES (Agents 10-13)
  10 Reply Classifier       Sort: interested/not-now/objection/unsubscribe
  11 Demo Link Sender       Send subdraw.com/login — no calls needed
  13 Objection Handler      Handle price/competitor/timing → demo link

LAYER 4 — NEVER LET LEADS GO COLD (Agents 12, 15-16)
  12 Re-engagement Tracker  45-day cold lead revival
  15 SMS Agent              Trigger SMS on 3+ opens, no reply
  16 Demo Engagement Tracker Follow up 48hrs after demo visit, no signup

LAYER 5 — CONVERT & RETAIN (Agents 14, 17-18, 21-22)
  14 Revenue Monitor        Watch Stripe — signups, fails, churn
  17 Lead Scorer            Daily hot/warm/cold scoring in GHL
  18 Expansion Agent        Starter → Pro upgrade at 60 days
  21 Funnel Drop-off Detector Recover accounts stuck in onboarding
  22 Referral Trigger       Ask happy 30-day customers for referrals

LAYER 6 — INTELLIGENCE (Agents 19-20, 24, 26, 29-31)
  19 Daily Briefing         5am SMS summary of overnight activity
  20 A/B Analyzer           Weekly — promote winning subject lines
  24 Market Intelligence    Build competitive dataset over time
  26 Content Brief Generator Weekly SEO blog briefs for inbound
  29 Geographic Scout       Identify next states to enter
  30 Pricing Signal Monitor Weekly Stripe pattern analysis
  31 Cross-Sell Detector    SubDraw customers who need SpotOn

LAYER 7 — SYSTEM HEALTH (Agents 23, 25, 27-28)
  23 Partner Outreach       Lenders/title/CPAs who refer GC clients
  25 Health Monitor         Hourly — alerts if anything breaks
  27 Partner Prospector     Find multiplier referral contacts
  28 Churn Interview        Exit survey on every cancellation
```

## Railway Cron Schedule
```
scripts/health-monitor-cron.js     → every 1 hour
scripts/reply-handler-cron.js      → every 30 minutes
scripts/revenue-monitor-cron.js    → every 2 hours
scripts/daily-briefing-cron.js     → daily 5am
scripts/prospector-cron.js         → Monday 6am
scripts/weekly-analyzer-cron.js    → Sunday midnight
```

## Funnel
cold email → subdraw.com/login → free account → self-guided demo → paid plan

## State Campaigns
- California: live July 7th
- Texas: Aug 1st
- Florida: Aug 15th
- Arizona: Sep 1st
- Partners (lenders/CPAs): July 15th

## Stack
Claude API · GoHighLevel · Instantly · Apollo.io · Vibe Prospecting · Stripe · Railway
