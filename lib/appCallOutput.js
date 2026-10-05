// Output side of the in-app Emysa live call, kept DOM-free (browser objects are
// injected) so the lifecycle can be unit tested without a phone.
//
// WHY THIS EXISTS (iOS Safari / WebKit):
//   The call keeps the microphone open the whole time, with echo cancellation.
//   While capture runs, iOS puts the page's audio session in "play-and-record"
//   and routes capture through the voice-processing unit (VPIO). Audio that
//   WebKit renders as a MediaStreamTrack is rendered THROUGH that same unit, so
//   it stays at call volume and the echo canceller can see it (WebKit bug
//   233316). Plain Web Audio output (AudioBufferSource -> ctx.destination) is
//   NOT: it is attenuated/ducked while the mic is live, can fall back to the
//   receiver, and the echo canceller cannot reference it (WebKit bugs 218012 and
//   236219, the latter still open). OpenAI's realtime playground plays a WebRTC
//   remote track, which is why it does not have the problem.
//
//   So the call's audio graph must never touch `ctx.destination`. Reply audio is
//   mixed into a MediaStreamAudioDestinationNode and played by an <audio>
//   element, which is the workaround WebKit's own engineers recommend.

export const SESSION_TYPE = 'play-and-record';

// Tell WebKit explicitly that this page is a call. Must run BEFORE getUserMedia
// (iOS 16.4+; absent elsewhere, where it is a no-op). Never throws.
export function primeAudioSession(nav) {
  const session = nav && nav.audioSession;
  if (!session) return { supported: false, type: null };
  try {
    if (session.type !== SESSION_TYPE) session.type = SESSION_TYPE;
  } catch { /* an unsupported value must not stop the call */ }
  return { supported: true, type: session.type };
}

// Re-assert the call's session type if something (a lock, a phone call, another
// app) changed it while we were away. Returns true when it had to correct it.
export function reassertAudioSession(nav) {
  const session = nav && nav.audioSession;
  if (!session) return false;
  try {
    if (session.type !== SESSION_TYPE) { session.type = SESSION_TYPE; return true; }
  } catch { /* ignore */ }
  return false;
}

// 'stream' (default) renders through a MediaStreamTrack. 'webaudio' is the old
// ctx.destination path, kept only so the two can be compared on a real phone:
// localStorage.setItem('emysaAudioOut', 'webaudio') then reload.
export function pickOutputMode(storage) {
  try {
    return storage && storage.getItem('emysaAudioOut') === 'webaudio' ? 'webaudio' : 'stream';
  } catch {
    return 'stream';
  }
}

// ctx: AudioContext. doc: document. nav: navigator. Returns the call's output.
export function createCallOutput({ ctx, doc, nav, mode = 'stream', log = () => {} }) {
  const input = ctx.createGain(); // everything audible is connected here
  input.gain.value = 1;
  let dest = null;
  let el = null;
  let disposed = false;

  if (mode === 'webaudio') {
    input.connect(ctx.destination);
  } else {
    dest = ctx.createMediaStreamDestination();
    input.connect(dest);
    el = doc.createElement('audio');
    el.srcObject = dest.stream;
    el.autoplay = true;
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    el.muted = false;
    el.volume = 1;
    el.style.display = 'none';
    doc.body.appendChild(el);
    // iOS pauses a media element when the session is interrupted (lock, a call,
    // Siri). A live call must always be playing, so start it again.
    el.addEventListener('pause', () => { if (!disposed) void start('element-paused'); });
  }

  async function start(reason = 'start') {
    if (disposed) return false;
    let ok = true;
    if (ctx.state !== 'running') {
      try { await ctx.resume(); } catch { ok = false; }
    }
    if (el && el.paused) {
      try { await el.play(); } catch (err) { ok = false; log('element.play failed', reason, err && err.name); }
    }
    return ok && ctx.state === 'running';
  }

  // The mic tap must keep being pulled by the graph without making any sound.
  // Connected to the media-stream destination (not ctx.destination) so the
  // Web Audio output unit is never used in stream mode.
  function silentSink(node) {
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink);
    sink.connect(dest || ctx.destination);
    return sink;
  }

  // Called when the page comes back (unlock, app switch) or the context reports
  // a state change. Brings the audio path back without touching the call.
  async function recover(reason) {
    if (disposed) return { recovered: false };
    const corrected = reassertAudioSession(nav);
    const ok = await start(reason);
    log('recover', reason, { ctx: ctx.state, paused: el ? el.paused : null, corrected });
    return { recovered: ok, corrected };
  }

  function dispose() {
    disposed = true;
    try { input.disconnect(); } catch { /* already gone */ }
    if (el) {
      try { el.pause(); } catch { /* ignore */ }
      el.srcObject = null;
      try { el.remove(); } catch { /* ignore */ }
    }
  }

  return {
    input, silentSink, start, recover, dispose, mode,
    get element() { return el; },
    get destination() { return dest; },
  };
}

// Wire page-lifecycle events to recover(). Returns an unsubscribe function.
export function watchLifecycle({ doc, win, ctx, output, onRecovered = () => {} }) {
  const kick = (reason) => {
    output.recover(reason).then((r) => onRecovered(reason, r)).catch(() => {});
  };
  const onVisibility = () => { if (doc.visibilityState === 'visible') kick('visible'); };
  const onPageShow = () => kick('pageshow');
  // iOS reports 'interrupted' (not 'suspended') when a lock/call/Siri interrupts.
  const onState = () => { if (ctx.state !== 'running' && doc.visibilityState === 'visible') kick(`ctx-${ctx.state}`); };
  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('pageshow', onPageShow);
  ctx.addEventListener('statechange', onState);
  return () => {
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('pageshow', onPageShow);
    ctx.removeEventListener('statechange', onState);
  };
}

// If the OS ended the mic track while we were away (iOS can do this on lock),
// say so, so the caller can reacquire it. A merely muted track unmutes itself.
export function micNeedsRestart(stream) {
  const tracks = stream && stream.getAudioTracks ? stream.getAudioTracks() : [];
  return !tracks.length || tracks.every((t) => t.readyState === 'ended');
}
