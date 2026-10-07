// Guards the production UI against developer/debug scaffolding, and against
// removing the status information people genuinely need.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answeredCallPill, assistantCallPill, listenInPill } from '../lib/callStatus.js';
import { userError, friendlyAccountName } from '../lib/userFacing.js';
import { describeMonitorMessage, describeMonitorClose, noAudioMessage } from '../lib/monitorStatus.js';
import { describeAppCallMessage, describeAppCallClose, describeMicError } from '../lib/appCallAudio.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const app = read('app.js');
const html = read('index.html');
const clientSources = ['app.js', 'lib/monitorStatus.js', 'lib/appCallAudio.js', 'lib/callStatus.js', 'lib/userFacing.js'].map(read).join('\n');
const DEV_TEXT = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b|Vercel|Render service|wss?:\/\/|assistant service|app server|Supabase/;

// ---- the pill: healthy calls say nothing, real states still speak ------------------

test('a healthy call shows no status pill; only a mute the user switched on does', () => {
  assert.equal(answeredCallPill({ aiMuted: false }), null);
  assert.equal(assistantCallPill({ muted: false }), null);
  assert.equal(listenInPill({ muted: false }), null);
  assert.deepEqual(answeredCallPill({ aiMuted: true }), { phase: 'muted', label: 'Emysa muted' });
  assert.deepEqual(assistantCallPill({ muted: true }), { phase: 'muted', label: 'Microphone muted' });
});

test('no connection/listening/speaking scaffolding is left in the client', () => {
  for (const s of ['Connected · Live', 'Connected · Listening', 'Emysa is speaking', 'Emysa speaking', 'Monitor off',
    'Listening in - both sides', 'Connecting to Emysa', 'Connecting to call audio', 'will appear here as the conversation']) {
    assert.ok(!clientSources.includes(s), `still present: ${s}`);
  }
});

test('legitimate call information is still there (nothing over-removed)', () => {
  for (const s of ["label: 'Calling'", "label: 'Ringing'", "'Call rejected'", "'Emysa muted'", "'No answer'", "'Busy'", "'Call failed'", "'Call canceled'", "'Call ended'", "'Ending call…'"]) {
    assert.ok(clientSources.includes(s), `missing legitimate status ${s}`);
  }
  assert.ok(/id="callTimer"/.test(html), 'call duration timer must remain');
  assert.match(app, /Microphone access is blocked|describeMicError/); // actionable mic error path kept
});

test('the hidden pill really hides (inline-flex would otherwise override [hidden])', () => {
  assert.match(read('styles.css'), /\.callStatePill\[hidden\]\s*\{\s*display:\s*none/);
});

// ---- no infrastructure wording reaches a person ------------------------------------

test('no env-var names or hosting jargon inside user-facing strings', () => {
  const offending = clientSources.split('\n').filter((line) => {
    if (/^\s*(\/\/|\*)/.test(line) || /console\.(warn|error|log)/.test(line)) return false;
    return /['"`][^'"`\n]*(PUBLIC_ASSISTANT_WS_URL|ASSISTANT_BRIDGE_SECRET|Vercel|Render service)[^'"`\n]*['"`]/.test(line);
  });
  assert.deepEqual(offending, []);
});

test('every message the call screens can show is free of developer text', () => {
  const texts = [];
  for (const callLive of [true, false, undefined]) {
    texts.push(describeMonitorMessage({ type: 'ready', callLive })?.text, noAudioMessage(callLive));
  }
  for (const reason of ['auth-refused', 'too-many-listeners', 'whatever', undefined]) {
    texts.push(describeMonitorMessage({ type: 'error', reason })?.text, describeAppCallMessage({ type: 'error', reason })?.text);
  }
  for (const code of [undefined, 1006, 1008, 1011, 1013]) {
    for (const opened of [true, false]) {
      for (const hadAudio of [true, false]) {
        texts.push(describeMonitorClose({ opened, code, hadAudio }), describeAppCallClose({ opened, code }));
      }
    }
  }
  for (const name of ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'Other']) texts.push(describeMicError({ name }));
  const shown = texts.filter(Boolean);
  assert.ok(shown.length > 20);
  for (const t of shown) assert.doesNotMatch(t, DEV_TEXT, `developer text shown to user: ${t}`);
});

test('actionable errors are kept: too many listeners, mic blocked, connection dropped', () => {
  assert.match(describeMonitorMessage({ type: 'error', reason: 'too-many-listeners' }).text, /two devices/);
  assert.match(describeMicError({ name: 'NotAllowedError' }), /Allow the microphone/);
  assert.match(describeMonitorClose({ opened: true, code: 1006, hadAudio: true }), /dropped/);
});

// ---- server errors and account labels --------------------------------------------------

test('server configuration errors are replaced; ordinary errors pass through unchanged', () => {
  const fb = 'Calling isn\u2019t available right now.';
  assert.equal(userError('Live calls are not set up: ASSISTANT_BRIDGE_SECRET is missing on Vercel', fb), fb);
  assert.equal(userError('Live calls need a secure URL: set PUBLIC_ASSISTANT_WS_URL to a wss:// address', fb), fb);
  assert.equal(userError('The assistant is not configured yet. No call was prepared.', fb), fb);
  assert.equal(userError('OPENAI_API_KEY is not configured', fb), fb);
  assert.equal(userError('', fb), fb);
  assert.equal(userError(undefined, fb), fb);
  assert.equal(userError('A call to this number is already in progress', fb), 'A call to this number is already in progress');
  assert.equal(userError('Out of minutes. Top up to keep calling.', fb), 'Out of minutes. Top up to keep calling.');
});

test('Telegram login errors become something a person can act on', () => {
  assert.match(userError('PHONE_CODE_INVALID', 'x'), /code isn.t right/);
  assert.match(userError('PHONE_CODE_EXPIRED', 'x'), /expired/);
  assert.match(userError('PASSWORD_HASH_INVALID', 'x'), /password/);
  assert.match(userError('FLOOD_WAIT_300', 'x'), /Too many attempts/);
});

test('connected-account label never shows a raw WhatsApp id', () => {
  assert.equal(friendlyAccountName('15049470572:2@s.whatsapp.net', 'WhatsApp user'), '+15049470572');
  assert.equal(friendlyAccountName('15049470572@c.us', 'WhatsApp user'), '+15049470572');
  assert.equal(friendlyAccountName('99887766554433@lid', 'WhatsApp user'), 'WhatsApp user'); // opaque id, not a number
  assert.equal(friendlyAccountName('Ada Lovelace', 'WhatsApp user'), 'Ada Lovelace');
  assert.equal(friendlyAccountName(null, 'Telegram user'), 'Telegram user');
  assert.match(app, /friendlyAccountName\(wa\.displayName/);
  assert.match(app, /friendlyAccountName\(tg\.displayName/);
});

// ---- the boot screen -------------------------------------------------------------------

test('a boot failure shows a plain message, not a stack trace, and the detail stays behind ?debug', () => {
  assert.doesNotMatch(html, /boot\.innerHTML\s*=/, 'message must not be injected as HTML');
  assert.match(html, /Something went wrong\. Check your connection and try again\./);
  assert.match(html, /\?debug|\[\?&\]debug/);
  assert.doesNotMatch(html, /showBootError\('(Script error|Unhandled rejection|Failed to load app\.js)/, 'raw error must not be the user message');
});
