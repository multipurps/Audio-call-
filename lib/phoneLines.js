// Per-user Twilio phone lines: "bring your own number" (Verified Outgoing
// Caller ID) or "rent" (a Twilio number bought for the user).
//
// A user may place Twilio calls only from their own usable line. Everything
// here runs server-side; the client never sees Twilio credentials or sids.
import { normalizePhone } from './phoneNumbers.js';

const USABLE = ['verified', 'rented'];

export function twilioConfigured(env = process.env) {
  return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN);
}

async function twilio(path, { method = 'GET', body } = {}) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/${path}`, {
    method,
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: body ? new URLSearchParams(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (resp.status === 204) return {};
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(data.message || `Twilio request failed (${resp.status})`);
    err.twilioCode = data.code;
    err.statusCode = resp.status;
    throw err;
  }
  return data;
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

// The only way phone (Twilio) calling is ever reachable for a user.
export async function getUsableLine(db, userId) {
  const line = await getPhoneLine(db, userId);
  return lineIsUsable(line) ? line : null;
}

export async function availableChannels(db, userId) {
  const [line, wa] = await Promise.all([
    getUsableLine(db, userId),
    db.from('whatsapp_accounts').select('status').eq('user_id', userId).maybeSingle(),
  ]);
  return { phone: Boolean(line), whatsapp: wa?.data?.status === 'connected' };
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
  if (!twilioConfigured()) return { error: 'Phone calling is not configured yet.', status: 503 };

  const { data: taken } = await db.from('phone_lines').select('user_id').eq('phone_number', phone).neq('user_id', userId).maybeSingle();
  if (taken) return { error: 'That number is already linked to another account.', status: 409 };

  const current = await getPhoneLine(db, userId);
  if (current?.mode === 'rent' && current.status === 'rented') {
    return { error: 'You already rent a number. Remove it first to bring your own.', status: 409 };
  }
  // Replacing an earlier own/pending line: drop its caller ID in Twilio too.
  if (current && current.phone_number !== phone) {
    const removed = await removeLine(db, userId);
    if (removed.error) return removed;
  }
  try {
    const result = await twilio('OutgoingCallerIds.json', {
      method: 'POST',
      body: { PhoneNumber: phone, FriendlyName: `emysa-${userId.slice(0, 8)}` },
    });
    await saveLine(db, userId, {
      mode: 'own', phone_number: phone, status: 'pending',
      validation_code: result.validation_code || null, twilio_sid: null, last_error: null,
    });
    return { line: publicLine(await getPhoneLine(db, userId)) };
  } catch (err) {
    // 21450: already verified on this Twilio account by someone. Never grant
    // it without a fresh proof of ownership.
    if (err.twilioCode === 21450) return { error: 'That number is already verified on this system. Contact support to link it.', status: 409 };
    return { error: err.message, status: 502 };
  }
}

// Twilio has no webhook we can rely on here, so the app polls this. The
// number counts as verified once it appears in the account's caller IDs.
export async function checkVerification(db, userId) {
  const line = await getPhoneLine(db, userId);
  if (!line) return { line: null };
  if (line.mode !== 'own' || line.status !== 'pending') return { line: publicLine(line) };
  try {
    const found = await twilio(`OutgoingCallerIds.json?PhoneNumber=${encodeURIComponent(line.phone_number)}`);
    const match = (found.outgoing_caller_ids || []).find((c) => c.phone_number === line.phone_number);
    if (match) {
      await saveLine(db, userId, { status: 'verified', twilio_sid: match.sid, validation_code: null, last_error: null });
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
    const data = await twilio(`AvailablePhoneNumbers/${code}/Local.json?${params}`);
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
    const purchased = await twilio('IncomingPhoneNumbers.json', {
      method: 'POST',
      body: {
        PhoneNumber: phone,
        FriendlyName: `emysa-${userId.slice(0, 8)}`,
        VoiceUrl: `${process.env.PUBLIC_APP_URL}/api/calls-incoming`,
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
  if (line.twilio_sid && twilioConfigured()) {
    const path = line.mode === 'rent' ? `IncomingPhoneNumbers/${line.twilio_sid}.json` : `OutgoingCallerIds/${line.twilio_sid}.json`;
    try {
      await twilio(path, { method: 'DELETE' });
    } catch (err) {
      // Releasing a rented number matters (it bills monthly): do not drop our
      // record if Twilio still holds it. A caller ID already gone is fine.
      if (line.mode === 'rent' && err.statusCode !== 404) return { error: `Could not release the number: ${err.message}`, status: 502 };
    }
  }
  const { error } = await db.from('phone_lines').delete().eq('user_id', userId);
  if (error) return { error: error.message, status: 500 };
  return { ok: true };
}
