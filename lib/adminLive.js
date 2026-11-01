// Pure helpers for the admin dashboard's real-time numbers (no database, easy to test).

export const LIVE_STATUSES = ['queued', 'ringing', 'in_progress'];

// "+234 ••• 333": the admin sees which call it is without every digit of a stranger's number.
export function maskNumber(n) {
  const s = String(n ?? '').replace(/[^\d+]/g, '');
  if (s.replace(/\D/g, '').length <= 6) return '••••';
  const lead = s.startsWith('+') ? 4 : 2;
  return `${s.slice(0, lead)} ••• ${s.slice(-3)}`;
}

// Percent change vs the previous period. null when there is nothing to compare with (no fake 100%).
export function pctChange(current, previous) {
  const c = Number(current) || 0;
  const p = Number(previous) || 0;
  if (p === 0) return c === 0 ? 0 : null;
  return ((c - p) / p) * 100;
}

// Calls and minutes per channel (phone, whatsapp, telegram, ...), busiest first.
export function summariseChannels(calls) {
  const by = new Map();
  for (const c of calls || []) {
    const k = String(c.platform || 'phone');
    const row = by.get(k) || { platform: k, calls: 0, minutes: 0 };
    row.calls += 1;
    row.minutes += Math.ceil((c.duration_seconds || 0) / 60); // same rounding the billing code uses
    by.set(k, row);
  }
  return [...by.values()].sort((a, b) => b.calls - a.calls);
}

// Daily series for the last `days` days (UTC dates), from rows already fetched.
export function dailySeries(days, calls, purchases, now = Date.now()) {
  const map = new Map();
  for (let i = days - 1; i >= 0; i -= 1) map.set(new Date(now - i * 864e5).toISOString().slice(0, 10), { revenue: 0, minutes: 0, calls: 0, users: new Set() });
  for (const p of purchases || []) { const d = map.get(String(p.paid_at).slice(0, 10)); if (d) d.revenue += Number(p.amount); }
  for (const c of calls || []) {
    const d = map.get(String(c.created_at).slice(0, 10));
    if (!d) continue;
    d.calls += 1;
    d.minutes += Math.ceil((c.duration_seconds || 0) / 60);
    d.users.add(c.user_id);
  }
  return [...map].map(([d, v]) => ({ d, revenue: v.revenue, minutes: v.minutes, calls: v.calls, activeUsers: v.users.size }));
}

export function splitByWindow(rows, field, sinceMs, untilMs = Infinity) {
  return (rows || []).filter((r) => { const t = Date.parse(r[field]); return t >= sinceMs && t < untilMs; });
}
