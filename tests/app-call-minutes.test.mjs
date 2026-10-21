// The in-app Emysa call shows the time and the minutes being charged. Both start when Emysa joins, the
// same moment the service stamps answered_at, which is where minutes are charged from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatCallMinutes } from '../lib/callStatus.js';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

const T0 = 1_000_000;

test('nothing is charged, and nothing is shown, before Emysa has joined', () => {
  assert.equal(formatCallMinutes(null, 40, T0), null);
  assert.equal(formatCallMinutes(undefined, 40, T0), null);
});

test('minutes are charged in whole minutes, rounded up, from the moment Emysa joined', () => {
  const at = (secs, left) => formatCallMinutes(T0, left, T0 + secs * 1000);
  assert.equal(at(0, null), '1 min charged');      // the first second already costs a minute
  assert.equal(at(59, null), '1 min charged');
  assert.equal(at(60, null), '1 min charged');     // exactly one minute is one minute
  assert.equal(at(61, null), '2 min charged');
  assert.equal(at(185, null), '4 min charged');
});

test('the minutes left follow the charge, and never go below zero', () => {
  assert.equal(formatCallMinutes(T0, 40, T0 + 5_000), '1 min charged \u00b7 39 min left');
  assert.equal(formatCallMinutes(T0, 40, T0 + 125_000), '3 min charged \u00b7 37 min left');
  assert.equal(formatCallMinutes(T0, 2, T0 + 600_000), '10 min charged \u00b7 0 min left');
  assert.equal(formatCallMinutes(T0, 12.9, T0 + 5_000), '1 min charged \u00b7 11 min left');
});

test('the in-app call screen starts its clock on ready, and not when the button is tapped', () => {
  const open = app.slice(app.indexOf('function openAssistantCallScreen'), app.indexOf("$('callEndBtn').onclick = () => endAssistantCall();"));
  assert.match(open, /resetAppCallClock\(trainer \? null : \(homeBalance\?\.remaining \?\? null\), !trainer\);/);
  assert.doesNotMatch(open, /setInterval/, 'no clock runs from the tap');
  assert.match(app, /if \(msg\.type === 'ready'\) \{\n\s+call\.opened = true;\n\s+startAppCallClock\(\);/);
});

test('the clock stops when the call ends, keeps the last values, and is counted once', () => {
  const stop = app.slice(app.indexOf('function stopAppCallSession'), app.indexOf('function finishAppCallUi'));
  assert.match(stop, /freezeAppCallClock\(\);/);
  assert.match(app, /if \(appCallJoinedAtMs !== null\) return; \/\/ "ready" is counted once/);
});

test('training calls are free, so they show the time but no minutes', () => {
  assert.match(app, /const m = appCallShowMinutes \? formatCallMinutes\(appCallJoinedAtMs, appCallMinutesAtStart\) : null;/);
  assert.match(app, /resetAppCallClock\(trainer \? null : \(homeBalance\?\.remaining \?\? null\), !trainer\)/);
});

test('the screen has a visible timer and a minutes line under the name', () => {
  assert.match(html, /id="callTimer"[\s\S]{0,120}id="callMinutes"[^>]*hidden/);
  assert.match(css, /\.callMinutes\[hidden\]\{display:none;\}/);
});
