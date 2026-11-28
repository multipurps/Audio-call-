// One-tap check of what SignalWire itself says about this app's phone setup. Used by the owner-only admin
// "Phone check", so a call that never rings can be explained from SignalWire's own records instead of guessed at.
import { lamlBase, lamlAuthHeader, signalwireConfigured } from './telephony.js';
import { sameNumber } from './phoneNumbers.js';

async function get(path, env, fetchImpl) {
  try {
    const resp = await fetchImpl(`${lamlBase(env)}${path}`, { headers: { Authorization: lamlAuthHeader(env), Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    const text = await resp.text();
    let data = null; try { data = JSON.parse(text); } catch { /* not JSON */ }
    return resp.ok ? { ok: true, data } : { ok: false, status: resp.status, detail: String(data?.message || data?.error || text).slice(0, 300) };
  } catch (e) { return { ok: false, status: 0, detail: String(e.message || e).slice(0, 300) }; }
}

export async function phoneCheck({ env = process.env, fetchImpl = fetch, appLines = [] } = {}) {
  if (!signalwireConfigured(env)) return { configured: false, problems: ['SignalWire is not configured on the server (space, project id or API token missing).'] };
  const [account, numbers, callerIds, calls, notes] = await Promise.all([
    get('.json', env, fetchImpl),
    get('/IncomingPhoneNumbers.json?PageSize=100', env, fetchImpl),
    get('/OutgoingCallerIds.json?PageSize=100', env, fetchImpl),
    get('/Calls.json?PageSize=8', env, fetchImpl),
    get('/Notifications.json?PageSize=8', env, fetchImpl),
  ]);
  const problems = [];
  if (!account.ok) problems.push(`SignalWire rejected the saved credentials (HTTP ${account.status}: ${account.detail}).`);
  const owned = (numbers.data?.incoming_phone_numbers || []).map((n) => ({
    number: n.phone_number,
    voice: n.capabilities ? Boolean(n.capabilities.voice) : null,
  }));
  const verified = (callerIds.data?.outgoing_caller_ids || []).map((c) => c.phone_number);
  const lines = appLines.map((l) => {
    const hit = owned.find((o) => sameNumber(o.number, l));
    return { number: l, ownedNumber: Boolean(hit), verifiedCallerId: verified.some((v) => sameNumber(v, l)), voice: hit ? hit.voice : null };
  });
  for (const l of lines) {
    if (!l.ownedNumber && !l.verifiedCallerId) problems.push(`${l.number} is the number your app calls FROM, but it is neither a number in this SignalWire project nor a verified caller ID there, so SignalWire cannot place calls from it.`);
    else if (!l.ownedNumber && l.verifiedCallerId) problems.push(`${l.number} is only a verified caller ID in SignalWire, not a number your SignalWire project owns. Compare it with the recent calls below.`);
    else if (l.voice === false) problems.push(`${l.number} is in SignalWire but has no voice capability.`);
  }
  return {
    configured: true,
    account: account.ok ? { status: account.data?.status, type: account.data?.type, name: account.data?.friendly_name } : null,
    lines,
    ownedNumbers: owned,
    verifiedCallerIds: verified,
    recentCalls: (calls.data?.calls || []).map((c) => ({ at: c.date_created, to: c.to, from: c.from, status: c.status, seconds: c.duration, direction: c.direction, sid: c.sid })),
    recentNotifications: notes.ok ? (notes.data?.notifications || []).map((n) => ({ at: n.date_created, level: n.log, code: n.error_code, text: n.message_text && decodeURIComponent(String(n.message_text).replace(/\+/g, ' ')).slice(0, 240) })) : [{ text: `not available (${notes.detail})` }],
    problems,
  };
}
