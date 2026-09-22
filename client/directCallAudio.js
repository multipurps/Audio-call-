// Direct Caller Mode client.
//
// Owns the browser half of a direct call: capture the microphone, ship it to
// the relay as PCM, and play back whatever the relay sends. Everything the
// relay does with it in between — voice conversion, mu-law encoding, Twilio
// framing — is invisible from here.
//
//     mic -> capture worklet -> WS (int16 @ streamRate) -> relay -> caller
//     caller -> relay -> WS (int16 @ 8 kHz) -> playback worklet -> speaker
//
// There is deliberately no speech recognition, no MediaRecorder and no
// reference to the assistant anywhere in this file: Direct Caller Mode is
// defined by the *absence* of that pipeline, and importing any of it here
// would be how it creeps back in.
//
// iOS/Safari notes, because they cost real debugging time:
//   * getUserMedia with echoCancellation is what stops the caller's voice
//     coming back out of the speaker being re-captured by the mic. It only
//     cancels audio the browser itself played, which is why playback goes
//     through an AudioContext here rather than an <audio> element (the same
//     reasoning app.js documents for getAssistantAudioCtx).
//   * navigator.audioSession.type = 'play-and-record' has to be set inside a
//     real tap handler before any await, or Safari infers a playback-only
//     category and ducks one of the two directions. The caller (app.js) does
//     that; this module just resumes the context.

const DEFAULT_STREAM_RATE = 48000;
const DEFAULT_PLAY_RATE = 8000;
const RECONNECT_MAX_MS = 8000;

export class DirectCallAudio {
  /**
   * @param {object} opts
   * @param {string} opts.wsUrl        relay /direct socket, with its ticket query params
   * @param {number} [opts.streamRate] mic rate the relay expects (from the /directBridge response)
   * @param {number} [opts.playRate]   caller-audio rate the relay sends
   * @param {number} [opts.chunkMs]    mic chunk size — the main latency knob
   * @param {function} [opts.onStatus] ({connected, mode, muted, vc, streamRate}) => void
   * @param {function} [opts.onStats]  ({level, rttMs, dropped, errors}) => void
   * @param {function} [opts.onError]  (message, {fatal}) => void
   */
  constructor(opts) {
    this.wsUrl = opts.wsUrl;
    this.streamRate = opts.streamRate || DEFAULT_STREAM_RATE;
    this.playRate = opts.playRate || DEFAULT_PLAY_RATE;
    this.chunkMs = opts.chunkMs || 128;
    this.onStatus = opts.onStatus || (() => {});
    this.onStats = opts.onStats || (() => {});
    this.onError = opts.onError || (() => {});

    this.audioCtx = null;
    this.stream = null;
    this.captureNode = null;
    this.sourceNode = null;
    this.playbackNode = null;
    this.ws = null;

    this.connected = false;
    this.muted = false;
    this.mode = 'direct';
    this.vc = { configured: false, enabled: true, modelSlot: null };
    this.stopped = false;
    this.retryDelay = 500;
    this.reconnectTimer = null;
    this.level = 0;
    // setVoiceChanger()/setModel() can be called immediately after start(),
    // before the WebSocket has actually opened. Queue those JSON controls so
    // the relay still gets the user's saved defaults on the first connection.
    this.pendingControls = [];
  }

  async start() {
    if (this.stopped) return;

    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.audioCtx.state === 'suspended') await this.audioCtx.resume().catch(() => {});

    // One context serves both worklets, which is what lets the browser's echo
    // canceller see the caller's audio as its reference signal.
    await Promise.all([
      this.audioCtx.audioWorklet.addModule('client/worklets/emysa-capture.js'),
      this.audioCtx.audioWorklet.addModule('client/worklets/emysa-playback.js'),
    ]);

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        // Don't pin channelCount: some Android devices report a mic that
        // can't do the requested layout and fail the whole constraint set.
      },
    });

    this.captureNode = new AudioWorkletNode(this.audioCtx, 'emysa-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      processorOptions: { targetRate: this.streamRate, chunkMs: this.chunkMs },
    });
    this.captureNode.port.onmessage = (e) => this._onCaptureMessage(e.data);

    this.playbackNode = new AudioWorkletNode(this.audioCtx, 'emysa-playback', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      channelCount: 1,
      processorOptions: { sourceRate: this.playRate },
    });
    this.playbackNode.port.onmessage = (e) => {
      if (e.data?.type === 'overflow') this.onError('Falling behind — audio may be choppy', {});
    };
    this.playbackNode.connect(this.audioCtx.destination);

    this.sourceNode = this.audioCtx.createMediaStreamSource(this.stream);
    this.sourceNode.connect(this.captureNode);

    this._connect();
  }

  _onCaptureMessage(msg) {
    if (!msg) return;
    if (msg.type === 'level') {
      this.level = msg.level;
      this.onStats({ level: msg.level });
      return;
    }
    if (msg.type === 'audio' && this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (this.muted) return; // dropped here, not by disabling the track — see setMuted()
      // Binary frame = raw little-endian int16 PCM at streamRate. No JSON
      // wrapper: at ~10 frames a second, base64-in-JSON would add a third to
      // the payload for nothing.
      this.ws.send(msg.pcm);
    }
  }

  _connect() {
    if (this.stopped) return;
    let ws;
    try {
      ws = new WebSocket(this.wsUrl);
    } catch (err) {
      this.onError(`Could not open the direct-call socket: ${err.message}`, { fatal: true });
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.retryDelay = 500;
      while (this.pendingControls.length && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(this.pendingControls.shift()));
      }
      this._emitStatus();
    };

    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') {
        // Caller audio: forwarded straight to the playback worklet, no
        // decoding or processing of any kind.
        this.playbackNode?.port.postMessage({ pcm: e.data }, [e.data]);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      this._onControl(msg);
    };

    ws.onclose = () => {
      const wasConnected = this.connected;
      this.connected = false;
      this._emitStatus();
      if (this.stopped) return;
      if (wasConnected) this.onError('Direct call link dropped — reconnecting', {});
      // Reconnect with backoff. The relay keeps the Twilio side of the call
      // open, so a phone that loses signal for a few seconds picks the call
      // back up rather than ending it.
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this._connect(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, RECONNECT_MAX_MS);
    };

    ws.onerror = () => {
      // onclose follows and does the reconnect; nothing useful to add here.
    };
  }

  _onControl(msg) {
    switch (msg.type) {
      case 'ready':
        this.mode = msg.mode || 'direct';
        if (msg.vc) this.vc = { ...this.vc, ...msg.vc };
        if (msg.streamRate) this.streamRate = msg.streamRate;
        if (msg.playRate) this.playRate = msg.playRate;
        this._emitStatus();
        break;
      case 'mode':
        this.mode = msg.mode;
        // Clear anything queued for the speaker so switching modes doesn't
        // play out a half-second of the previous mode.
        this.playbackNode?.port.postMessage({ type: 'clear' });
        this._emitStatus();
        break;
      case 'status':
        if (msg.vc) this.vc = { ...this.vc, ...msg.vc };
        this._emitStatus();
        break;
      case 'stats':
        this.onStats({ rttMs: msg.lastRttMs, dropped: msg.dropped, errors: msg.errors });
        break;
      case 'error':
        this.onError(msg.message || 'Direct call error', { fatal: !!msg.fatal });
        break;
      default:
        break;
    }
  }

  _emitStatus() {
    this.onStatus({
      connected: this.connected,
      muted: this.muted,
      mode: this.mode,
      vc: { ...this.vc },
      streamRate: this.streamRate,
    });
  }

  /** Voice changer on/off. Off = the caller hears the unconverted mic. */
  setVoiceChanger(enabled, slot) {
    const msg = { type: 'vc', enabled };
    if (slot != null) msg.slot = slot;
    this._send(msg);
    this.vc.enabled = enabled;
    if (slot != null) this.vc.modelSlot = slot;
  }

  /** Switch the RVC voice without touching the on/off state. */
  setModel(slot) {
    this._send({ type: 'vc', slot });
    this.vc.modelSlot = slot;
  }

  /**
   * Mute the outgoing mic only. The capture worklet keeps running so the
   * level meter stays honest and unmuting is instant — the audio is dropped
   * here rather than by disabling the track, which on some devices takes
   * long enough to be audible as a gap.
   */
  setMuted(muted) {
    this.muted = !!muted;
    this._emitStatus();
  }

  /** Whether the caller's voice is played back on this device at all. */
  setMonitor(on) {
    this._send({ type: 'monitor', on });
  }

  /** Hand the call between 'direct' and 'ai'. */
  setMode(mode) {
    this._send({ type: 'mode', mode });
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return;
    }
    this.pendingControls.push(msg);
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    try {
      this.stream?.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    this.stream = null;
    try {
      this.sourceNode?.disconnect();
      this.captureNode?.disconnect();
      this.playbackNode?.disconnect();
    } catch {
      /* ignore */
    }
    this.sourceNode = this.captureNode = this.playbackNode = null;
    try {
      await this.audioCtx?.close();
    } catch {
      /* ignore */
    }
    this.audioCtx = null;
  }
}
