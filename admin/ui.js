// Small, pure helpers for the admin dashboard (formatting + chart geometry). No DOM, no network.

export function relTime(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 45) return 'Just now';
  const m = Math.floor(s / 60);
  if (m < 2) return 'A minute ago';
  if (m < 60) return `${m} minutes ago`;
  const h = Math.floor(m / 60);
  if (h < 2) return '1 hour ago';
  if (h < 24) return `${h} hours ago`;
  const d = Math.floor(h / 24);
  if (d < 2) return 'Yesterday';
  if (d < 14) return `${d} days ago`;
  return new Date(t).toLocaleDateString();
}

// Status as the admin should read it, plus a colour family the stylesheet knows.
export const STATUS = {
  queued: { label: 'Pending', tone: 'blue' },
  ringing: { label: 'Ringing', tone: 'blue' },
  in_progress: { label: 'In progress', tone: 'purple' },
  completed: { label: 'Complete', tone: 'green' },
  failed: { label: 'Failed', tone: 'red' },
  no_answer: { label: 'No answer', tone: 'amber' },
};
export const statusOf = (s) => STATUS[s] || { label: String(s || 'Unknown'), tone: 'gray' };

const CHANNELS = { phone: 'Phone', whatsapp: 'WhatsApp', telegram: 'Telegram', signal: 'Signal', app: 'In-app' };
export const channelName = (p) => CHANNELS[p] || (p ? String(p)[0].toUpperCase() + String(p).slice(1) : 'Phone');

export function dur(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (!s) return '—';
  const m = Math.floor(s / 60);
  return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

// "+11.01%" / "-0.03%". null (nothing to compare with) reads "new", never a made-up number.
export function pctLabel(p) {
  if (p === null || p === undefined) return 'new';
  if (!Number.isFinite(p)) return '—';
  const v = Math.abs(p) >= 100 ? Math.round(p) : Math.round(p * 100) / 100;
  return `${v > 0 ? '+' : ''}${v}%`;
}
export const trendDir = (p) => (p === null || p === undefined ? 'up' : p < 0 ? 'down' : 'up');

// Smooth line through points (Catmull-Rom converted to cubic beziers).
export function smoothPath(pts) {
  if (!pts.length) return '';
  if (pts.length === 1) return `M${pts[0][0]} ${pts[0][1]}`;
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] || pts[i]; const p1 = pts[i]; const p2 = pts[i + 1]; const p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

// Everything an SVG line chart needs from a list of real values.
export function chartGeometry(values, w, h, pad = 10) {
  const n = values.length;
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => [pad + (n === 1 ? (w - 2 * pad) / 2 : (i / (n - 1)) * (w - 2 * pad)), pad + (1 - (v - min) / span) * (h - 2 * pad)]);
  const line = smoothPath(pts);
  const area = pts.length ? `${line}L${pts[n - 1][0].toFixed(1)} ${h - pad}L${pts[0][0].toFixed(1)} ${h - pad}Z` : '';
  // Marker points: highest, lowest and the latest value (real extremes, nothing decorative).
  const iMax = values.indexOf(Math.max(...values));
  const iMin = values.indexOf(Math.min(...values));
  return { pts, line, area, max, min, markers: [...new Set([iMin, iMax, n - 1])].filter((i) => i >= 0 && values[i] !== undefined) };
}

export const compact = (n) => {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
  return v.toLocaleString(undefined, { maximumFractionDigits: 1 });
};

// A stable hue per person so avatars are recognisable without a profile photo.
export const hueOf = (s) => { let h = 0; for (const ch of String(s || '')) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
export const initialOf = (email) => (String(email || '?').trim()[0] || '?').toUpperCase();
