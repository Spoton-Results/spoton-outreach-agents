/**
 * GoHighLevel API Client
 * Full REST wrapper for contacts, opportunities, conversations, SMS
 */
require('dotenv').config({ path: './config/.env' });
const { callGHL } = require('./helpers');

async function upsertContact(data) {
  // Try to find existing contact first
  try {
    const existing = await callGHL('GET', '/contacts/?email=' + encodeURIComponent(data.email) + '&locationId=' + (process.env.GHL_LOCATION_ID));
    const contact = existing.contacts?.[0];
    if (contact) {
      await callGHL('PUT', '/contacts/' + contact.id, data);
      return { ...contact, action: 'updated' };
    }
  } catch(e) { /* not found, create */ }
  const created = await callGHL('POST', '/contacts/', { ...data, locationId: process.env.GHL_LOCATION_ID });
  return { ...created.contact, action: 'created' };
}

async function createOpportunity(contactId, name, stageId) {
  return callGHL('POST', '/opportunities/', {
    pipelineId: process.env.GHL_PIPELINE_ID,
    locationId: process.env.GHL_LOCATION_ID,
    name,
    pipelineStageId: stageId || process.env.GHL_STAGE_COLD,
    contactId,
    status: 'open'
  });
}

async function updateOpportunityStage(opportunityId, stageId) {
  return callGHL('PUT', '/opportunities/' + opportunityId, { pipelineStageId: stageId });
}

async function sendEmail(contactId, subject, body) {
  return callGHL('POST', '/conversations/messages', {
    type: 'Email',
    contactId,
    subject,
    body,
    html: '<p>' + body.replace(/\n/g, '<br>') + '</p>'
  });
}

async function sendSMS(contactId, message) {
  return callGHL('POST', '/conversations/messages', { type: 'SMS', contactId, message });
}

async function getContactByEmail(email) {
  const res = await callGHL('GET', '/contacts/?email=' + encodeURIComponent(email) + '&locationId=' + process.env.GHL_LOCATION_ID);
  return res.contacts?.[0] || null;
}

async function tagContact(contactId, tags, existingTags = []) {
  return callGHL('PUT', '/contacts/' + contactId, { tags: [...existingTags, ...tags] });
}

module.exports = { upsertContact, createOpportunity, updateOpportunityStage, sendEmail, sendSMS, getContactByEmail, tagContact };
