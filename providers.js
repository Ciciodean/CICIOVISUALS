// Visual Arc — telephony providers (Twilio + Telnyx)
// Real US number search, purchase, release + inbound SMS parsing.

const TWILIO_BASE = 'https://api.twilio.com/2010-04-01';
const TELNYX_BASE = 'https://api.telnyx.com/v2';

function twilioAuth() {
  const sid = process.env.TWILIO_ACCOUNT_SID || '';
  const tok = process.env.TWILIO_AUTH_TOKEN || '';
  return 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64');
}

function telnyxAuth() {
  return 'Bearer ' + (process.env.TELNYX_API_KEY || '');
}

// ---------- TWILIO ----------
async function twilioSearch(areaCode) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  let url = `${TWILIO_BASE}/Accounts/${sid}/AvailablePhoneNumbers/US/Local.json?SmsEnabled=true&Limit=5`;
  if (areaCode) url += '&AreaCode=' + encodeURIComponent(areaCode);
  const r = await fetch(url, { headers: { Authorization: twilioAuth() } });
  const j = await r.json();
  if (!r.ok) throw new Error(j.message || 'Twilio search failed');
  return (j.available_phone_numbers || []).map(n => n.phone_number);
}

async function twilioBuy(number, webhookUrl) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const body = new URLSearchParams({
    PhoneNumber: number,
    SmsUrl: webhookUrl,
    SmsMethod: 'POST',
    FriendlyName: 'Visual Arc rental'
  });
  const r = await fetch(`${TWILIO_BASE}/Accounts/${sid}/IncomingPhoneNumbers.json`, {
    method: 'POST',
    headers: { Authorization: twilioAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.message || 'Twilio purchase failed');
  return { providerRef: j.sid, number: j.phone_number };
}

async function twilioRelease(providerRef) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const r = await fetch(`${TWILIO_BASE}/Accounts/${sid}/IncomingPhoneNumbers/${providerRef}.json`, {
    method: 'DELETE',
    headers: { Authorization: twilioAuth() }
  });
  return r.ok || r.status === 204;
}

function twilioParseInbound(form) {
  return {
    number: form.To || '',
    from: form.From || '',
    text: form.Body || '',
    providerMsgId: form.MessageSid || ''
  };
}

// ---------- TELNYX ----------
async function telnyxSearch(areaCode) {
  let url = `${TELNYX_BASE}/available_phone_numbers?filter[country_code]=US&filter[phone_number_features]=sms&filter[limit]=5`;
  if (areaCode) url += '&filter[national_destination_code]=' + encodeURIComponent(areaCode);
  const r = await fetch(url, { headers: { Authorization: telnyxAuth() } });
  const j = await r.json();
  if (!r.ok) throw new Error((j.errors && j.errors[0] && j.errors[0].detail) || 'Telnyx search failed');
  return (j.data || []).map(n => n.phone_number);
}

async function telnyxBuy(number, webhookUrl) {
  // set/create messaging profile webhook so inbound SMS reaches us
  let profileId = process.env.TELNYX_MESSAGING_PROFILE_ID;
  if (!profileId) {
    const create = await fetch(`${TELNYX_BASE}/messaging_profiles`, {
      method: 'POST',
      headers: { Authorization: telnyxAuth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Visual Arc', webhooks: { inbound: { url: webhookUrl, http_method: 'post' } } })
    });
    const cj = await create.json();
    if (create.ok) profileId = cj.data && cj.data.id;
  } else {
    await fetch(`${TELNYX_BASE}/messaging_profiles/${profileId}`, {
      method: 'PATCH',
      headers: { Authorization: telnyxAuth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhooks: { inbound: { url: webhookUrl, http_method: 'post' } } })
    });
  }
  const conn = process.env.TELNYX_CONNECTION_ID;
  const payload = { phone_numbers: [{ phone_number: number }] };
  if (conn) payload.connection_id = conn;
  const r = await fetch(`${TELNYX_BASE}/phone_numbers`, {
    method: 'POST',
    headers: { Authorization: telnyxAuth(), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.errors && j.errors[0] && j.errors[0].detail) || 'Telnyx purchase failed');
  const rec = (j.data && j.data.phone_numbers && j.data.phone_numbers[0]) || j.data || {};
  return { providerRef: rec.id || rec.phone_number, number: rec.phone_number || number };
}

async function telnyxRelease(providerRef) {
  const r = await fetch(`${TELNYX_BASE}/phone_numbers/${providerRef}`, {
    method: 'DELETE',
    headers: { Authorization: telnyxAuth() }
  });
  return r.ok;
}

function telnyxParseInbound(event) {
  const d = event.data || {};
  const p = d.payload || {};
  const to = (p.to && p.to[0] && (p.to[0].phone_number || p.to[0])) || '';
  return {
    number: typeof to === 'string' ? to : '',
    from: (p.from && (p.from.phone_number || p.from)) || '',
    text: p.text || '',
    providerMsgId: p.id || ''
  };
}

// ---------- message polling (works without webhooks) ----------
async function twilioFetchMessages(number) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const url = `${TWILIO_BASE}/Accounts/${sid}/Messages.json?To=${encodeURIComponent(number)}&PageSize=10`;
  const r = await fetch(url, { headers: { Authorization: twilioAuth() } });
  const j = await r.json();
  if (!r.ok) throw new Error(j.message || 'Twilio messages fetch failed');
  return (j.messages || [])
    .filter(m => m.direction === 'inbound')
    .map(m => ({
      providerMsgId: m.sid,
      from: m.from || '',
      text: m.body || '',
      ts: m.date_created ? new Date(m.date_created).getTime() : Date.now()
    }));
}

async function telnyxFetchMessages(number) {
  const url = `${TELNYX_BASE}/messages?filter[to]=${encodeURIComponent(number)}&page[size]=10`;
  const r = await fetch(url, { headers: { Authorization: telnyxAuth() } });
  const j = await r.json();
  if (!r.ok) throw new Error((j.errors && j.errors[0] && j.errors[0].detail) || 'Telnyx messages fetch failed');
  return (j.data || [])
    .filter(m => m.direction === 'inbound')
    .map(m => ({
      providerMsgId: m.id || '',
      from: (m.from && (m.from.phone_number || m.from)) || '',
      text: m.text || '',
      ts: m.received_at ? new Date(m.received_at).getTime() : Date.now()
    }));
}

function fetchMessages(number) {
  return activeProvider() === 'telnyx' ? telnyxFetchMessages(number) : twilioFetchMessages(number);
}

// ---------- unified ----------
function activeProvider() {
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) return 'twilio';
  if (process.env.TELNYX_API_KEY) return 'telnyx';
  return null;
}

async function searchNumbers(areaCode) {
  return activeProvider() === 'telnyx' ? telnyxSearch(areaCode) : twilioSearch(areaCode);
}

async function buyNumber(number, webhookUrl) {
  return activeProvider() === 'telnyx' ? telnyxBuy(number, webhookUrl) : twilioBuy(number, webhookUrl);
}

async function releaseNumber(providerRef) {
  try {
    return activeProvider() === 'telnyx' ? telnyxRelease(providerRef) : twilioRelease(providerRef);
  } catch (e) {
    return false;
  }
}

function parseInbound(kind, payload) {
  return kind === 'telnyx' ? telnyxParseInbound(payload) : twilioParseInbound(payload);
}

module.exports = { activeProvider, searchNumbers, buyNumber, releaseNumber, parseInbound, fetchMessages };
