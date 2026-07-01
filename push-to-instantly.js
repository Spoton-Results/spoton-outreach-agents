#!/usr/bin/env node
/**
 * SpotOn Results - Push GHL Contacts to Instantly Campaign
 * --------------------------------------------------------
 * One-time manual trigger on Railway.
 * Reads ALL GHL contacts with email that have NOT been tagged
 * outreach-email-queued, then bulk-adds them to the Instantly campaign.
 */

require('dotenv').config({ path: './config/.env' });

const axios = require('axios');

const GHL_API_KEY           = process.env.GHL_API_KEY;
const GHL_LOCATION_ID       = process.env.GHL_LOCATION_ID || 'oe1TpmlDynQGFNdYLkaK';
const INSTANTLY_API_KEY     = process.env.INSTANTLY_API_KEY;
const INSTANTLY_CAMPAIGN_ID = process.env.INSTANTLY_CAMPAIGN_ID || '8b8d1159-ec1c-4982-944d-6dd0be563b50';
const BATCH_SIZE            = parseInt(process.env.BATCH_SIZE || '100');
const PUSH_SIZE             = parseInt(process.env.PUSH_SIZE  || '100');
const DRY_RUN               = process.env.DRY_RUN === 'true';
const SKIP_TAG              = 'outreach-email-queued';
const SENT_TAG              = 'outreach-email-queued';

if (!GHL_API_KEY)       { console.error('FATAL: Missing GHL_API_KEY');       process.exit(1); }
if (!INSTANTLY_API_KEY) { console.error('FATAL: Missing INSTANTLY_API_KEY'); process.exit(1); }

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
function log(msg)  { console.log('[' + new Date().toISOString() + '] ' + msg); }

function ghlError(err) {
  var status = err.response && err.response.status;
  var data   = err.response && err.response.data;
  return 'HTTP ' + status + ' -- ' + JSON.stringify(data);
}

var ghlV2 = axios.create({
  baseURL: 'https://services.leadconnectorhq.com',
  headers: {
    'Authorization': 'Bearer ' + GHL_API_KEY,
    'Version':       '2021-07-28',
    'Content-Type':  'application/json'
  },
  timeout: 20000
});

async function ghlGetWithRetry(path, params) {
  var retries = 0;
  var maxRetries = 8;
  while (true) {
    try {
      return await ghlV2.get(path, { params: params });
    } catch (err) {
      var status = err.response && err.response.status;
      if (status === 429 && retries < maxRetries) {
        retries++;
        var wait = 10000 * retries;
        log('  Rate limited (429). Waiting ' + (wait / 1000) + 's before retry ' + retries + '/' + maxRetries + '...');
        await sleep(wait);
      } else {
        throw err;
      }
    }
  }
}

async function getAllContactsV2() {
  var contacts = [];
  var startAfterId = null;
  var page = 1;
  var fetched = 0;

  while (true) {
    var params = { locationId: GHL_LOCATION_ID, limit: BATCH_SIZE };
    if (startAfterId) params.startAfterId = startAfterId;

    var resp = await ghlGetWithRetry('/contacts/', params);
    var batch = (resp.data && resp.data.contacts) || [];

    fetched += batch.length;
    log('  Page ' + page + ': got ' + batch.length + ' contacts (fetched so far: ' + fetched + ')');

    if (page === 1 && batch.length > 0) {
      log('  First contact sample: ' + JSON.stringify({
        id:    batch[0].id,
        email: batch[0].email,
        tags:  batch[0].tags
      }));
    }

    if (!batch.length) break;

    contacts = contacts.concat(batch);

    if (batch.length < BATCH_SIZE) break;
    startAfterId = batch[batch.length - 1].id;
    page++;
    await sleep(600);
  }
  return contacts;
}

async function tagContact(id) {
  try {
    await ghlV2.post('/contacts/' + id + '/tags', { tags: [SENT_TAG] });
  } catch (err) {
    log('  WARN: Could not tag ' + id + ': ' + ghlError(err));
  }
}

var instantly = axios.create({
  baseURL: 'https://api.instantly.ai/api/v1',
  headers: { 'Content-Type': 'application/json' },
  timeout: 20000
});

async function pushToInstantly(leads) {
  if (DRY_RUN) {
    log('[DRY RUN] Would push ' + leads.length + ' leads');
    return leads.length;
  }
  var resp = await instantly.post('/lead/add', {
    api_key:              INSTANTLY_API_KEY,
    campaign_id:          INSTANTLY_CAMPAIGN_ID,
    skip_if_in_workspace: true,
    leads: leads.map(function(l) {
      return {
        email:        l.email,
        first_name:   l.firstName || l.first_name || 'there',
        last_name:    l.lastName  || l.last_name  || '',
        company_name: l.companyName || l.company  || '',
        phone:        l.phone || ''
      };
    })
  });
  return (resp.data && resp.data.leads_added) || leads.length;
}

async function main() {
  log('=======================================================');
  log(' SpotOn Results -- Push GHL Contacts to Instantly');
  log(' Campaign ID : ' + INSTANTLY_CAMPAIGN_ID);
  log(' Location ID : ' + GHL_LOCATION_ID);
  log(' DRY_RUN     : ' + DRY_RUN);
  log('=======================================================');

  var allContacts = await getAllContactsV2();
  log('Total contacts fetched: ' + allContacts.length);

  var eligible = allContacts.filter(function(c) {
    var tags = c.tags || [];
    if (tags.indexOf(SKIP_TAG) !== -1) return false;
    if (!c.email || c.email.indexOf('@') === -1) return false;
    return true;
  });

  var skipped = allContacts.length - eligible.length;
  log('Eligible (with email, not tagged): ' + eligible.length);
  log('Skipped (no email or already tagged): ' + skipped);

  if (eligible.length === 0) {
    log('No eligible contacts. Done.');
    return;
  }

  var pushed = 0;
  for (var i = 0; i < eligible.length; i += PUSH_SIZE) {
    var batch = eligible.slice(i, i + PUSH_SIZE);
    try {
      var added = await pushToInstantly(batch);
      pushed += added;
      log('+ Pushed ' + pushed + '/' + eligible.length + ' to Instantly');
      for (var j = 0; j < batch.length; j++) {
        await tagContact(batch[j].id);
        await sleep(50);
      }
    } catch (err) {
      var detail = err.response
        ? 'HTTP ' + err.response.status + ' -- ' + JSON.stringify(err.response.data)
        : err.message;
      log('  ERROR batch ' + i + ': ' + detail);
    }
    await sleep(500);
  }

  log('=======================================================');
  log(' DONE -- Pushed ' + pushed + ' leads to Instantly');
  log('=======================================================');
}

main().catch(function(e) {
  var status = e.response && e.response.status;
  var detail = e.response
    ? 'HTTP ' + status + ' -- ' + JSON.stringify(e.response.data)
    : e.message;
  if (status === 429) {
    // GHL rate-limited us even after all retries. Exit 0 (not 1) so Railway does
    // not restart-loop this service and cascade 429s across other services.
    // The next scheduled run will retry automatically.
    console.warn('WARN: GHL rate-limited after all retries — exiting cleanly. Will retry on next run.');
    process.exit(0);
  }
  console.error('FATAL: ' + detail);
  process.exit(1);
});
