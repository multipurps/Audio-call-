import test from 'node:test';
import assert from 'node:assert/strict';
import { maskNumber, pctChange, summariseChannels, dailySeries, splitByWindow, LIVE_STATUSES } from '../lib/adminLive.js';
import { relTime, statusOf, pctLabel, trendDir, chartGeometry, dur, compact, channelName } from '../admin/ui.js';

test('numbers are masked, never shown in full', () => {
  assert.equal(maskNumber('+2348072343333'), '+234 ••• 333');
  assert.equal(maskNumber('12345'), '••••');
  assert.equal(maskNumber(null), '••••');
});

test('percent change is honest: nothing to compare with is null, not an invented 100%', () => {
  assert.equal(pctChange(110, 100), 10);
  assert.equal(pctChange(50, 100), -50);
  assert.equal(pctChange(0, 0), 0);
  assert.equal(pctChange(5, 0), null);
  assert.equal(pctLabel(null), 'new');
  assert.equal(pctLabel(11.014), '+11.01%');
  assert.equal(pctLabel(-0.03), '-0.03%');
  assert.equal(trendDir(-1), 'down');
});

test('channels and the daily series come straight from the rows', () => {
  const calls = [
    { platform: 'whatsapp', duration_seconds: 61, created_at: '2026-10-30T10:00:00Z', user_id: 'a' },
    { platform: 'whatsapp', duration_seconds: 0, created_at: '2026-10-31T10:00:00Z', user_id: 'b' },
    { platform: 'phone', duration_seconds: 30, created_at: '2026-10-31T11:00:00Z', user_id: 'a' },
  ];
  assert.deepEqual(summariseChannels(calls), [{ platform: 'whatsapp', calls: 2, minutes: 2 }, { platform: 'phone', calls: 1, minutes: 1 }]);
  const now = Date.parse('2026-10-31T12:00:00Z');
  const s = dailySeries(3, calls, [{ paid_at: '2026-10-31T09:00:00Z', amount: '5.5' }], now);
  assert.deepEqual(s.map((x) => x.d), ['2026-10-29', '2026-10-30', '2026-10-31']);
  assert.deepEqual(s.map((x) => x.calls), [0, 1, 2]);
  assert.deepEqual(s.map((x) => x.activeUsers), [0, 1, 2]);
  assert.equal(s[2].revenue, 5.5);
  assert.equal(s[2].minutes, 1);
});

test('windows split cleanly', () => {
  const rows = [{ t: '2026-10-01T00:00:00Z' }, { t: '2026-10-10T00:00:00Z' }, { t: '2026-10-20T00:00:00Z' }];
  const a = Date.parse('2026-10-05T00:00:00Z'); const b = Date.parse('2026-10-15T00:00:00Z');
  assert.equal(splitByWindow(rows, 't', a, b).length, 1);
  assert.equal(splitByWindow(rows, 't', b).length, 1);
});

test('relative time and status wording', () => {
  const now = Date.parse('2026-10-31T12:00:00Z');
  assert.equal(relTime('2026-10-31T11:59:40Z', now), 'Just now');
  assert.equal(relTime('2026-10-31T11:58:30Z', now), 'A minute ago');
  assert.equal(relTime('2026-10-31T11:30:00Z', now), '30 minutes ago');
  assert.equal(relTime('2026-10-31T09:00:00Z', now), '3 hours ago');
  assert.equal(relTime('2026-10-30T10:00:00Z', now), 'Yesterday');
  assert.equal(statusOf('in_progress').label, 'In progress');
  assert.equal(statusOf('completed').tone, 'green');
  assert.ok(LIVE_STATUSES.includes('ringing'));
  assert.equal(dur(125), '2m 05s');
  assert.equal(dur(0), '—');
  assert.equal(compact(12500), '12.5K');
  assert.equal(channelName('whatsapp'), 'WhatsApp');
});

test('chart geometry stays inside the box and marks real extremes', () => {
  const g = chartGeometry([3, 9, 1, 6], 300, 100, 10);
  assert.equal(g.pts.length, 4);
  for (const [x, y] of g.pts) { assert.ok(x >= 10 && x <= 290); assert.ok(y >= 10 && y <= 90); }
  assert.deepEqual(g.markers.sort(), [1, 2, 3]);
  assert.ok(g.line.startsWith('M') && g.area.endsWith('Z'));
  const flat = chartGeometry([0, 0, 0], 300, 100, 10);
  assert.ok(flat.pts.every(([, y]) => Number.isFinite(y)));
  assert.equal(chartGeometry([], 300, 100).line, '');
});

import { readFileSync } from 'node:fs';
test('live calls and per-user calls stay owner-only (investors keep the old read-only list)', () => {
  const api = readFileSync(new URL('../api/admin.js', import.meta.url), 'utf8');
  assert.match(api, /const INVESTOR_ACTIONS = new Set\(\['overview', 'analytics', 'rates'\]\)/);
  assert.match(api, /case 'live': return live\(req, res, supabase, access\)/);
  assert.match(api, /if \(access\.role === 'owner'\) \{\s*const emails/);
});
