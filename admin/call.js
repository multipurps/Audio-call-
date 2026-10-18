// Admin "Call Emysa" training call, on its own page inside the admin PWA (/admin/call.html).
//
// It is the same live session as a normal in-app call: one websocket to the assistant service, the
// microphone streaming up, Emysa's voice streaming back, and the same audio libraries in /lib. The
// service starts it as a raw Emysa on draft guidance, and while it runs the server reads the transcript
// and saves what she was taught as draft memories. The server refuses anyone who is not an admin.
//
// Why a separate page instead of opening the app: the admin PWA's scope is /admin/. A link to the app
// (/?trainer=1) is outside it, so iOS opened it in an in-app browser sheet with no way to end the call.
// This page stays inside the scope, so it opens in the installed admin app.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createMicDownsampler, decodeAppCallFrame, describeAppCallMessage, describeAppCallClose, describeMicError } from '../lib/appCallAudio.js';
import { primeAudioSession, createCallOutput, watchLifecycle, pickOutputMode, micNeedsRestart } from '../lib/appCallOutput.js';
import { createPlayback } from '../lib/appCallPlayback.js';
import { assistantCallPill } from '../lib/callStatus.js';

const SUPABASE_URL = 'https://gucblbvfzuraaozswfwd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd1Y2JsYnZmenVyYWFvenN3ZndkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU0NzQ0ODQsImV4cCI6MjA5MTA1MDQ4NH0.OCsEC_FfOJmoL5sQWP8zYnw9SmWuy4xggfcpIIxQw-c';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const ADMIN_HOME = './index.html';
const $ = (id) => document.getElementById(id);
const engine = new URLSearchParams(location.search).get('engine') === 'luna' ? 'luna' : 'live';

let appCall = null;       // the live session while there is one
let trainer = null;       // { engine, nextIndex, busy, timer, learned }
let muted = false;
let phase = 'idle';       // idle | connecting | live | ending | over
let audioCtx = null;
const getCtx = () => { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); return audioCtx; };

async function authedFetch(url, options = {}) {
  const { data } = await supabase.auth.getSession();
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${data.session?.access_token || ''}` };
  return fetch(url, { ...options, headers });
}

// ---------- the same small UI helpers the app's call screen uses ----------
function setPill(kind, label) {
  const pill = $('callStatePill');
  pill.hidden = false;
  pill.dataset.phase = kind || 'connecting';
  pill.textContent = label || 'Connecting…';
}
function applyPill(view) {
  if (view) { setPill(view.phase, view.label); return; }
  const pill = $('callStatePill');
  pill.hidden = true;
  pill.textContent = '';
}
function addLine(speaker, content) {
  const panel = $('transcriptPanel');
  const who = (speaker === 'ai' || speaker === 'assistant') ? 'ai' : 'user';
  const row = document.createElement('div');
  row.className = `transcriptLine ${who}`;
  const bubble = document.createElement('div');
  bubble.className = 'transcriptBubble';
  bubble.textContent = content || '';
  row.append(bubble);
  panel.appendChild(row);
  panel.scrollTop = panel.scrollHeight;
}
let toastTimer = null;
function toast(text) {
  const el = $('trainToast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}
const goBack = () => { location.href = ADMIN_HOME; };

// ---------- learning: the server reads the transcript and saves draft memories ----------
async function learn(t, callId, { force = false, final = false } = {}) {
  if (!t || !callId || (t.busy && !force)) return;
  t.busy = true;
  try {
    const resp = await authedFetch('/api/admin?action=ai-train-learn', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId, fromIndex: t.nextIndex, final }),
    });
    const d = await resp.json().catch(() => ({}));
    if (resp.ok) {
      if (Number.isFinite(d.nextIndex)) t.nextIndex = d.nextIndex;
      for (const n of d.saved || []) { t.learned += 1; toast(`${n.action === 'updated' ? 'Updated' : 'Learned'}: ${n.title}`); }
    }
  } catch { /* the next pass tries again */ } finally { t.busy = false; }
}
async function learnFinal(t, callId) {
  // Give the service a moment to save the last turns, then take one final pass.
  await new Promise((r) => setTimeout(r, 2500));
  // Let a pass that is still running finish first, so the two never save the same lesson twice.
  for (let i = 0; i < 60 && t.busy; i++) await new Promise((r) => setTimeout(r, 500));
  // One last pass over the WHOLE call, so nothing taught in the middle is lost.
  await learn(t, callId, { force: true, final: true });
}

// ---------- ending ----------
function stopSession({ hangUp = false } = {}) {
  const call = appCall;
  appCall = null;
  if (!call) return null;
  clearInterval(call.transcriptTimer);
  if (trainer) clearInterval(trainer.timer);
  try { if (hangUp && call.ws?.readyState === WebSocket.OPEN) call.ws.send(JSON.stringify({ type: 'hangup' })); } catch { /* closing anyway */ }
  const closeSoon = () => { try { call.ws?.close(); } catch { /* ignore */ } };
  if (hangUp) setTimeout(closeSoon, 300); else closeSoon();
  try { call.stream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
  try { call.micNode?.disconnect(); call.source?.disconnect(); } catch { /* ignore */ }
  try { call.playback?.clear(); } catch { /* ignore */ }
  try { call.unwatch?.(); call.output?.dispose(); } catch { /* ignore */ }
  $('waveRow').classList.remove('speaking');
  return call;
}

function showOver(title, text) {
  phase = 'over';
  $('endTitle').textContent = title;
  $('endText').textContent = text;
  $('trainEnd').classList.remove('hidden');
}

// Used for errors and for the service ending the call: release everything, say why, offer the way out.
function finishUi(text, { quiet = false } = {}) {
  const call = stopSession();
  const t = trainer;
  phase = 'over';
  setPill('connecting', text);
  if (call?.callId && t) {
    learnFinal(t, call.callId).then(() => showOver(quiet ? 'Call ended' : text, learnedText(t)));
  } else {
    showOver(quiet ? 'Call ended' : text, '');
  }
}
const learnedText = (t) => (t && t.learned
  ? `Emysa saved ${t.learned} ${t.learned === 1 ? 'lesson' : 'lessons'} as drafts. Review them in the admin before publishing.`
  : 'Nothing was saved from this call.');

// The End button works in every state: during a call it hangs up, and when there is no call it leaves.
async function pressEnd() {
  if (phase === 'ending') return;
  if (phase === 'idle' || phase === 'over') { goBack(); return; }
  phase = 'ending';
  const t = trainer;
  const call = stopSession({ hangUp: true });
  setPill('connecting', 'Ending call…');
  if (call?.callId && t) { await learnFinal(t, call.callId); showOver('Call ended', learnedText(t)); }
  else showOver('Call ended', '');
}

// ---------- the live session ----------
async function startCall() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx || !navigator.mediaDevices?.getUserMedia || !window.WebSocket) {
    setPill('connecting', 'This device cannot do live voice calls');
    return;
  }
  phase = 'connecting';
  muted = false;
  trainer = { engine, nextIndex: 0, busy: false, timer: null, learned: 0 };
  $('trainGate').classList.add('hidden');
  $('trainEnd').classList.add('hidden');
  $('transcriptPanel').textContent = '';
  $('callMuteBtn').classList.remove('active');
  $('callMuteBtn').setAttribute('aria-pressed', 'false');
  setPill('connecting', 'Connecting…');

  // Everything up to getUserMedia runs inside the tap: iOS refuses audio otherwise.
  const session = primeAudioSession(navigator);
  const ctx = getCtx();
  const output = createCallOutput({ ctx, doc: document, nav: navigator, mode: pickOutputMode(localStorage), log: () => {} });
  void output.start('tap');
  void session;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
  } catch (err) {
    output.dispose();
    finishUi(describeMicError(err));
    return;
  }
  if (phase !== 'connecting') { stream.getTracks().forEach((t) => t.stop()); output.dispose(); return; }

  let started;
  try {
    const resp = await authedFetch('/api/admin?action=ai-train-call-start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine }),
    });
    started = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      stream.getTracks().forEach((t) => t.stop());
      output.dispose();
      finishUi(started?.error || 'Could not start the call');
      return;
    }
  } catch {
    stream.getTracks().forEach((t) => t.stop());
    output.dispose();
    finishUi('Could not reach the app server to start the call. Check your connection');
    return;
  }
  if (phase !== 'connecting') { stream.getTracks().forEach((t) => t.stop()); output.dispose(); return; }

  let ws;
  try { ws = new WebSocket(started.url); } catch {
    stream.getTracks().forEach((t) => t.stop());
    output.dispose();
    finishUi('The call couldn\u2019t start. Try again later');
    return;
  }
  ws.binaryType = 'arraybuffer';

  const call = {
    ws, stream, ctx, out: output.input, output, callId: started.callId, opened: false, explained: false, ended: false,
    playback: null, renderedLines: 0, transcriptTimer: null, source: null, micNode: null,
  };
  appCall = call;
  call.playback = createPlayback({
    ctx, out: output.input, log: () => {},
    onSpeaking: (on) => $('waveRow').classList.toggle('speaking', on && appCall === call),
  });

  // microphone -> service
  const downsample = createMicDownsampler(ctx.sampleRate);
  const sendPcm = (floats) => {
    if (muted || ws.readyState !== WebSocket.OPEN) return;
    const pcm = downsample(floats);
    if (pcm.length) ws.send(pcm.buffer);
  };
  call.source = ctx.createMediaStreamSource(stream);
  const startMic = async () => {
    try {
      if (!ctx.audioWorklet) throw new Error('no worklet');
      const code = "class P extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('mic-tap',P)";
      const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(ctx, 'mic-tap');
      let acc = [];
      let n = 0;
      const need = Math.round(ctx.sampleRate * 0.02);
      node.port.onmessage = (e) => {
        acc.push(e.data); n += e.data.length;
        if (n >= need) {
          const merged = new Float32Array(n);
          let o = 0; for (const c of acc) { merged.set(c, o); o += c.length; }
          acc = []; n = 0;
          sendPcm(merged);
        }
      };
      call.source.connect(node);
      output.silentSink(node);
      call.micNode = node;
    } catch {
      // Older Safari: ScriptProcessor still works.
      const node = ctx.createScriptProcessor(1024, 1, 1);
      node.onaudioprocess = (e) => sendPcm(new Float32Array(e.inputBuffer.getChannelData(0)));
      call.source.connect(node);
      output.silentSink(node);
      call.micNode = node;
    }
  };

  // Screen lock / app switch: bring the output back (and the mic, if the OS ended it) on return.
  const reacquireMic = async () => {
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
      if (appCall !== call) { fresh.getTracks().forEach((t) => t.stop()); return; }
      try { call.source?.disconnect(); } catch { /* ignore */ }
      call.stream = fresh;
      call.source = ctx.createMediaStreamSource(fresh);
      if (call.micNode) call.source.connect(call.micNode);
    } catch { /* the next lifecycle event tries again */ }
  };
  call.unwatch = watchLifecycle({
    doc: document, win: window, ctx, output,
    onRecovered: () => { if (appCall === call && micNeedsRestart(call.stream)) void reacquireMic(); },
  });

  // transcript: pushed over the socket the moment a turn is recorded, with the call row as the fallback
  const lineBuf = new Map();
  const showLine = (idx, speaker, text) => {
    if (idx < call.renderedLines || lineBuf.has(idx)) return;
    lineBuf.set(idx, { speaker, text });
    while (lineBuf.has(call.renderedLines)) {
      const l = lineBuf.get(call.renderedLines);
      lineBuf.delete(call.renderedLines);
      if (l.text) addLine(l.speaker, l.text);
      call.renderedLines += 1;
    }
  };
  const pollTranscript = async () => {
    if (appCall !== call || !call.callId) return;
    try {
      const { data } = await supabase.from('calls').select('transcript').eq('id', call.callId).maybeSingle();
      const lines = Array.isArray(data?.transcript) ? data.transcript : [];
      lines.forEach((line, i) => showLine(i, line?.speaker || line?.role, line?.content || line?.text || ''));
    } catch { /* fallback only */ }
  };

  ws.onopen = () => { call.opened = true; };
  ws.onmessage = (event) => {
    if (appCall !== call) return;
    if (typeof event.data === 'string') {
      let msg = null;
      try { msg = JSON.parse(event.data); } catch { /* not JSON */ }
      if (msg?.type === 'interrupt') { call.playback.clear(); return; }
      if (msg?.type === 'transcript' && Number.isFinite(msg.seq)) { showLine(msg.seq - 1, msg.speaker, msg.content); return; }
      const info = describeAppCallMessage(msg);
      if (!info) return;
      if (info.kind === 'error') { call.explained = true; finishUi(info.text); return; }
      if (info.kind === 'ended') { call.ended = true; finishUi('Call ended', { quiet: true }); return; }
      if (msg.type === 'ready') {
        call.opened = true;
        phase = 'live';
        trainer.timer = setInterval(() => learn(trainer, call.callId), 15000);
        startMic();
        applyPill(assistantCallPill({ muted }));
        call.transcriptTimer = setInterval(pollTranscript, 3000);
      }
      return;
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const frame = decodeAppCallFrame(event.data);
    if (frame) call.playback.play(frame);
  };
  const onGone = (event) => {
    if (appCall !== call) return;
    const text = describeAppCallClose({ opened: call.opened, code: event?.code, explained: call.explained, ended: call.ended });
    if (text) finishUi(text); else finishUi('Call ended', { quiet: true });
  };
  ws.onclose = onGone;
  ws.onerror = onGone;
}

// ---------- wiring ----------
$('callEndBtn').addEventListener('click', pressEnd);
$('callMuteBtn').addEventListener('click', () => {
  muted = !muted;
  $('callMuteBtn').classList.toggle('active', muted);
  $('callMuteBtn').setAttribute('aria-pressed', String(muted));
  if (phase === 'live') applyPill(assistantCallPill({ muted }));
});
$('callFaceTimeBtn').addEventListener('click', () => {
  const hidden = $('callScreen').classList.toggle('captionsHidden');
  $('callFaceTimeBtn').classList.toggle('active', !hidden);
});
// The chevron and the last button both leave; during a call they hang up first.
const leave = async () => { if (phase === 'connecting' || phase === 'live') await pressEnd(); goBack(); };
$('callMinimizeBtn').addEventListener('click', leave);
$('callAddBtn').addEventListener('click', leave);
$('gateStart').addEventListener('click', startCall);
$('gateBack').addEventListener('click', goBack);
$('endAgain').addEventListener('click', () => { $('trainEnd').classList.add('hidden'); phase = 'idle'; startCall(); });
$('endBack').addEventListener('click', goBack);

// Whatever happens to the page (closed, swiped away, navigated), the microphone must not stay open.
window.addEventListener('pagehide', () => { stopSession({ hangUp: true }); });

// Only an admin who is signed in can start a call (the server checks it again).
(async () => {
  try {
    const { data } = await supabase.auth.getSession();
    if (data.session?.user) { $('gateStart').disabled = false; return; }
  } catch { /* fall through */ }
  $('gateText').textContent = 'Sign in on the admin page first, then open this screen from Call Emysa.';
})();
