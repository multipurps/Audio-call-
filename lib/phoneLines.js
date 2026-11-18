// Per-user phone lines: "bring your own number" (a verified outgoing caller ID) or "rent" (a number bought for the
// user), through SignalWire's Twilio-compatible API.
//
// A user may place phone calls only from their own usable line. Everything here runs server-side; the client never
// sees carrier credentials or sids.
import { normalizePhone } from './phoneNumbers.js';
import { lamlRequest, relayRestRequest, signalwireConfigured, webhookToken } from './telephony.js';

const USABLE = ['verified', 'rented'];

export function phoneProviderConfigured(env = process.env) {
  return signalwireConfigured(env);
}

async function carrier(path, opts = {}) {
  return lamlRequest(path, opts);
}

// Verified caller IDs live on SignalWire's own REST API, not the Twilio-compatible one.
async function callerIds(path, opts = {}) {
  return relayRestRequest(path, opts);
}

async function findCallerId(phone) {
  const found = await callerIds(`verified_caller_ids?filter_number=${encodeURIComponent(phone)}`);
  return (found.data || []).find((c) => c.number === phone) || null;
}

// Where the carrier sends calls made TO a rented number (api/calls-incoming.js checks this token).
function incomingVoiceUrl() {
  return `${process.env.PUBLIC_APP_URL}/api/calls-incoming?t=${webhookToken('incoming')}`;
}

export async function isApproved(db, userId) {
  const { data } = await db.from('user_approvals').select('approved').eq('user_id', userId).maybeSingle();
  return !!data?.approved;
}

export async function getPhoneLine(db, userId) {
  const { data } = await db.from('phone_lines').select('*').eq('user_id', userId).maybeSingle();
  return data || null;
}

export function lineIsUsable(line) {
  return Boolean(line && USABLE.includes(line.status) && line.phone_number);
}

// The only way phone calling is ever reachable for a user.
export async function getUsableLine(db, userId) {
  const line = await getPhoneLine(db, userId);
  return lineIsUsable(line) ? line : null;
}

export async function availableChannels(db, userId) {
  const [line, wa, tg] = await Promise.all([
    getUsableLine(db, userId),
    db.from('whatsapp_accounts').select('status').eq('user_id', userId).maybeSingle(),
    db.from('telegram_accounts').select('status').eq('user_id', userId).maybeSingle(),
  ]);
  return {
    phone: Boolean(line),
    whatsapp: wa?.data?.status === 'connected',
    telegram: tg?.data?.status === 'connected',
  };
}

// Rent settings come from env so the price shown is the price you charge.
// Renting stays off until BOTH the flag and a positive price are set.
export function rentSettings(env = process.env) {
  const price = Number(env.PHONE_RENT_PRICE_USD);
  const countries = (env.PHONE_RENT_COUNTRIES || 'US,CA').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
  return {
    enabled: env.PHONE_RENT_ENABLED === 'true' && Number.isFinite(price) && price > 0,
    monthlyUsd: Number.isFinite(price) && price > 0 ? price : null,
    countries,
  };
}

// What the client may see: never the Twilio sid.
export function publicLine(line) {
  if (!line) return null;
  return {
    mode: line.mode,
    phoneNumber: line.phone_number,
    status: line.status,
    validationCode: line.status === 'pending' ? line.validation_code || null : null,
    lastError: line.last_error || null,
  };
}

async function saveLine(db, userId, patch) {
  const existing = await getPhoneLine(db, userId);
  const row = { ...patch, updated_at: new Date().toISOString() };
  if (existing) {
    const { error } = await db.from('phone_lines').update(row).eq('user_id', userId);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await db.from('phone_lines').insert({ user_id: userId, ...row });
    if (error) throw new Error(error.message);
  }
}

// ---- Bring your own number -------------------------------------------------

export async function startVerification(db, userId, rawPhone) {
  const phone = normalizePhone(rawPhone);
  if (!phone) return { error: 'Enter your number with country code, for example +14155552671.', status: 400 };
  if (!phoneProviderConfigured()) return { error: 'Phone calling is not configured yet.', status: 503 };

  const { data: taken } = await db.from('phone_lines').select('user_id').eq('phone_number', phone).neq('user_id', userId).maybeSingle();
  if (taken) return { error: 'That number is already linked to another account.', status: 409 };

  const current = await getPhoneLine(db, userId);
  if (current?.mode === 'rent' && current.status === 'rented') {
    return { error: 'You already rent a number. Remove it first to bring your own.', status: 409 };
  }
  // Replacing an earlier own/pending line: drop its caller ID at the carrier too.
  if (current && current.phone_number !== phone) {
    const removed = await removeLine(db, userId);
    if (removed.error) return removed;
  }
  try {
    // A caller ID for this number that is already on the account must not be reused: the user has to prove they
    // own the number with a fresh call, so drop the old record first.
    const existing = await findCallerId(phone);
    if (existing) await callerIds(`verified_caller_ids/${existing.id}`, { method: 'DELETE' }).catch(() => {});
    // Creating the record makes SignalWire phone the number and read out a 6-digit code.
    const created = await callerIds('verified_caller_ids', {
      method: 'POST',
      body: { number: phone, name: `emysa-${userId.slice(0, 8)}` },
    });
    await saveLine(db, userId, {
      mode: 'own', phone_number: phone, status: 'pending',
      validation_code: null, twilio_sid: created.id || null, last_error: null,
    });
    return { line: publicLine(await getPhoneLine(db, userId)) };
  } catch (err) {
    // 422: SignalWire allows one verification call per number per minute, and rejects numbers that cannot take calls.
    if (err.statusCode === 422) return { error: 'We could not call that number. Check it can receive voice calls, and wait a minute before trying again.', status: 429 };
    return { error: err.message, status: 502 };
  }
}

// The user types the 6-digit code they heard on the call; we hand it to SignalWire.
export async function submitVerificationCode(db, userId, rawCode) {
  const code = String(rawCode || '').replace(/\D/g, '');
  if (code.length !== 6) return { error: 'Enter the 6-digit code you heard on the call.', status: 400 };
  const line = await getPhoneLine(db, userId);
  if (!line || line.mode !== 'own' || line.status !== 'pending' || !line.twilio_sid) {
    return { error: 'Start verification first, then enter the code from the call.', status: 409 };
  }
  try {
    await callerIds(`verified_caller_ids/${encodeURIComponent(line.twilio_sid)}/verification`, {
      method: 'PUT', body: { verification_code: code },
    });
  } catch (err) {
    if (err.statusCode === 422) return { error: 'That code did not match. Try again, or tap "Call me again".', status: 400 };
    return { error: err.message, status: 502 };
  }
  const checked = await checkVerification(db, userId);
  if (checked.error) return checked;
  if (checked.line?.status !== 'verified') return { error: 'That code did not match. Try again, or tap "Call me again".', status: 400 };
  return checked;
}

// The number counts as verified once SignalWire lists it as verified. Also used as the check after a code is entered.
export async function checkVerification(db, userId) {
  const line = await getPhoneLine(db, userId);
  if (!line) return { line: null };
  if (line.mode !== 'own' || line.status !== 'pending') return { line: publicLine(line) };
  try {
    const match = await findCallerId(line.phone_number);
    if (match?.verified === true || match?.status === 'Verified') {
      await saveLine(db, userId, { status: 'verified', twilio_sid: match.id, validation_code: null, last_error: null });
    }
  } catch (err) {
    return { error: err.message, status: 502 };
  }
  return { line: publicLine(await getPhoneLine(db, userId)) };
}

// ---- Rent ------------------------------------------------------------------

export async function searchNumbers({ country = 'US', areaCode } = {}) {
  const settings = rentSettings();
  if (!settings.enabled) return { error: 'Renting a number is not available yet.', status: 503 };
  const code = String(country).toUpperCase();
  if (!settings.countries.includes(code)) return { error: 'Numbers are not available in that country yet.', status: 400 };
  const params = new URLSearchParams({ VoiceEnabled: 'true', PageSize: '8' });
  if (areaCode && /^\d{2,4}$/.test(String(areaCode))) params.set('AreaCode', String(areaCode));
  try {
    const data = await carrier(`AvailablePhoneNumbers/${code}/Local.json?${params}`);
    return {
      numbers: (data.available_phone_numbers || []).map((n) => ({
        phoneNumber: n.phone_number, locality: n.locality || null, region: n.region || null,
      })),
    };
  } catch (err) {
    return { error: err.message, status: 502 };
  }
}

export async function rentNumber(db, userId, rawNumber) {
  const settings = rentSettings();
  if (!settings.enabled) return { error: 'Renting a number is not available yet.', status: 503 };
  const phone = normalizePhone(rawNumber);
  if (!phone) return { error: 'Choose a number from the list.', status: 400 };
  const current = await getPhoneLine(db, userId);
  if (current?.status === 'rented') return { error: 'You already rent a number.', status: 409 };
  if (current) {
    const removed = await removeLine(db, userId); // old verified caller ID
    if (removed.error) return removed;
  }
  try {
    const purchased = await carrier('IncomingPhoneNumbers.json', {
      method: 'POST',
      body: {
        PhoneNumber: phone,
        FriendlyName: `emysa-${userId.slice(0, 8)}`,
        VoiceUrl: incomingVoiceUrl(),
        VoiceMethod: 'POST',
      },
    });
    await saveLine(db, userId, {
      mode: 'rent', phone_number: purchased.phone_number, status: 'rented',
      twilio_sid: purchased.sid, validation_code: null, last_error: null,
    });
    return { line: publicLine(await getPhoneLine(db, userId)) };
  } catch (err) {
    return { error: err.message, status: 502 };
  }
}

// ---- Remove ----------------------------------------------------------------

export async function removeLine(db, userId) {
  const line = await getPhoneLine(db, userId);
  if (!line) return { ok: true };
  if (line.twilio_sid && phoneProviderConfigured()) {
    try {
      if (line.mode === 'rent') await carrier(`IncomingPhoneNumbers/${line.twilio_sid}.json`, { method: 'DELETE' });
      else await callerIds(`verified_caller_ids/${encodeURIComponent(line.twilio_sid)}`, { method: 'DELETE' });
    } catch (err) {
      // Releasing a rented number matters (it bills monthly): do not drop our
      // record if the carrier still holds it. A caller ID already gone is fine.
      if (line.mode === 'rent' && err.statusCode !== 404) return { error: `Could not release the number: ${err.message}`, status: 502 };
    }
  }
  const { error } = await db.from('phone_lines').delete().eq('user_id', userId);
  if (error) return { error: error.message, status: 500 };
  return { ok: true };
}
