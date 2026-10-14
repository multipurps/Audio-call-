// Reply-audio scheduler for the in-app Emysa call and the admin "Call Emysa" training
// call. It used to be copy-pasted into app.js and admin/trainerCall.js; it lives here so
// both calls behave the same and so it can be tested with a fake clock (no phone needed).
//
// The service releases 20 ms PCM frames at real-time speed (PacedAudioSender, 200 ms lead).
// Each frame becomes one AudioBufferSource scheduled back-to-back on the Web Audio clock.
//
// WHAT WAS WRONG (reproduced with a fake clock, see tests/app-call-playback-scheduler.test.mjs):
//   When the transport stalled (mobile network, tab throttled, TCP head-of-line) and then
//   delivered the backlog in one burst, the old code scheduled the backlog and then
//   `return`ed on every frame that landed more than MAX_LAG past the playhead. That threw
//   away the NEWEST audio, the end of the sentence, silently and with no counter. A 3 s
//   stall during a 6 s reply lost 700 ms of the reply's tail.
//
// POLICY NOW:
//   * A frame is never thrown away on arrival.
//   * If the backlog would run past MAX_LAG, the playhead has fallen behind real time, so
//     the STALE, not-yet-started audio is dropped (oldest first) and playback re-primes on
//     the audio that is current. What the person hears is what Emysa is saying now.
//   * Every decision is counted (see stats()) so a real call can be diagnosed from the
//     numbers instead of guessed at.

export const PLAYBACK_DEFAULTS = Object.freeze({
  // The voice arrives in bursts (a streamed test voice especially), so a tiny cushion
  // underran on the first late chunk. Start with a real cushion, re-prime with it after an
  // underrun and deepen it when the underrun happens mid-sentence. A long gap is just
  // Emysa pausing, so it does not deepen the cushion.
  jitterStart: 0.2,
  jitterMax: 0.6,
  jitterStep: 0.1,
  // More than this far ahead of the playhead means we are playing stale audio.
  maxLag: 2.5,
  // An underrun this much after the schedule ran dry is mid-sentence; longer is a pause.
  midSentenceGap: 1.0,
});

// ctx: AudioContext (or a fake with the same surface). out: the node replies are mixed into.
export function createPlayback({ ctx, out, onSpeaking = () => {}, log = () => {}, config = {} }) {
  const cfg = { ...PLAYBACK_DEFAULTS, ...config };
  // source -> { start, end } on the context clock, so stale audio can be told from audio
  // that is already playing.
  const scheduled = new Map();
  let nextTime = 0;
  let jitter = cfg.jitterStart;
  let speaking = false;

  const stats = {
    framesIn: 0,
    framesScheduled: 0,
    badFrames: 0,
    audioInMs: 0,
    scheduledMs: 0,
    underruns: 0,
    silenceMs: 0,
    resyncs: 0,
    trimmedFrames: 0,
    trimmedMs: 0,
    maxLagMs: 0,
    clears: 0,
  };

  const setSpeaking = (next) => {
    if (speaking === next) return;
    speaking = next;
    try { onSpeaking(next); } catch { /* UI must never break audio */ }
  };

  // Stop everything that has not started yet. Audio that is already sounding is left to
  // finish: cutting it mid-word would add a click on top of the gap.
  function dropUnstarted(now) {
    let frames = 0;
    let secs = 0;
    for (const [src, span] of scheduled) {
      if (span.start > now) {
        try { src.stop(); } catch { /* never started or already ended */ }
        src.onended = null;
        scheduled.delete(src);
        frames += 1;
        secs += span.end - span.start;
      }
    }
    return { frames, secs };
  }

  function play(frame) {
    stats.framesIn += 1;
    const rate = frame && frame.rate;
    const samples = frame && frame.samples;
    if (!samples || !samples.length || !(rate > 0)) { stats.badFrames += 1; return false; }
    const dur = samples.length / rate;
    stats.audioInMs += dur * 1000;

    const now = ctx.currentTime;
    if (!nextTime) {
      nextTime = now + jitter;
    } else if (nextTime < now) {
      // The schedule ran dry before this frame arrived: an underrun.
      stats.underruns += 1;
      stats.silenceMs += (now - nextTime) * 1000;
      if (now - nextTime < cfg.midSentenceGap) jitter = Math.min(cfg.jitterMax, jitter + cfg.jitterStep);
      nextTime = now + jitter;
    }

    if (nextTime + dur - now > cfg.maxLag) {
      // Behind real time: drop what is stale, keep what is current.
      const dropped = dropUnstarted(now);
      let playingUntil = now;
      for (const span of scheduled.values()) playingUntil = Math.max(playingUntil, span.end);
      nextTime = Math.max(now + jitter, playingUntil);
      stats.resyncs += 1;
      stats.trimmedFrames += dropped.frames;
      stats.trimmedMs += dropped.secs * 1000;
      log('resync', { trimmedFrames: dropped.frames, trimmedMs: Math.round(dropped.secs * 1000) });
    }

    let buffer;
    try {
      buffer = ctx.createBuffer(1, samples.length, rate);
    } catch {
      // A corrupt rate in the frame header: skip the frame, keep the call.
      stats.badFrames += 1;
      return false;
    }
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(out);
    const start = nextTime;
    src.start(start);
    nextTime = start + buffer.duration;
    scheduled.set(src, { start, end: nextTime });
    stats.framesScheduled += 1;
    stats.scheduledMs += buffer.duration * 1000;
    stats.maxLagMs = Math.max(stats.maxLagMs, (nextTime - now) * 1000);
    setSpeaking(true);
    src.onended = () => {
      scheduled.delete(src);
      if (!scheduled.size) setSpeaking(false);
    };
    return true;
  }

  // Barge-in / interrupt: everything queued is cancelled and the next frame starts fresh.
  function clear() {
    for (const src of scheduled.keys()) {
      try { src.stop(); } catch { /* ignore */ }
      src.onended = null;
    }
    scheduled.clear();
    nextTime = 0;
    stats.clears += 1;
    setSpeaking(false);
  }

  return {
    play,
    clear,
    stats: () => ({
      ...stats,
      jitterMs: Math.round(jitter * 1000),
      queuedMs: Math.max(0, Math.round((nextTime - ctx.currentTime) * 1000)),
      audioInMs: Math.round(stats.audioInMs),
      scheduledMs: Math.round(stats.scheduledMs),
      silenceMs: Math.round(stats.silenceMs),
      trimmedMs: Math.round(stats.trimmedMs),
      maxLagMs: Math.round(stats.maxLagMs),
    }),
    get sources() { return scheduled.keys(); },
    get nextTime() { return nextTime; },
    get jitter() { return jitter; },
  };
}
