// The browser half of a WaCalls call (WhatsApp over WaCalls on Fly).
// Media flows directly between this page and the WaCalls service over WebRTC data channels:
//   "pcm": 16 kHz mono s16le, both ways. Up = the outgoing call audio (the avatar's voice or the mic).
//   "vp8": H.264 access units, both ways (5-byte header, see wacalls-media-core.js). Up = the avatar video.
// Signaling goes through our server (which holds the WaCalls key); this file never sees the key.
// Everything page-specific is injected through WaCallsMedia.configure(), so the screens stay in app.js.
(function (root) {
  'use strict';
  const C = root.WaCallsMediaCore;
  const STUN = 'stun:stun.l.google.com:19302';
  const FRAME_W = 480;
  const FRAME_H = 640;
  const FPS = 15;
  const VIDEO_BUFFER_LIMIT = 128 * 1024;

  let deps = {
    signal: null,            // { webrtc(callId, sdp), renegotiate(callId, sdp), videoStart(callId), videoAccept(callId) } -> { sdpAnswer } | {}
    remoteCanvas: null,      // canvas that shows the callee's video
    getOutgoingAudio: null,  // () => MediaStream with the audio to send (the avatar's voice, or the mic)
    getAvatarVideo: null,    // () => HTMLVideoElement | HTMLCanvasElement | null, the picture to send
    onStatus: () => {},
    onFailed: () => {},
  };

  const Leg = {
    pc: null, pcmDC: null, videoDC: null,
    callId: null, active: false, muted: false,
    micCtx: null, micSource: null, micNode: null, silenceTimer: null,
    canvas: null, ctx: null, encoder: null, encodeTimer: null,
    forceKeyframe: true, lastKeyframeAt: 0, kfTimers: [], avcDesc: null, frameCount: 0,
    sent: { audioFrames: 0, videoFrames: 0 }, received: { audioFrames: 0, videoFrames: 0 },
    player: null,

    configure(next) { deps = Object.assign(deps, next || {}); },

    supported() { return typeof root.VideoEncoder !== 'undefined' && typeof root.VideoFrame !== 'undefined' && typeof root.VideoDecoder !== 'undefined'; },

    setMuted(m) { this.muted = !!m; },

    // Opens the media leg for a call that the WaCalls service has already started.
    async open({ callId, video = true } = {}) {
      if (!callId) throw new Error('No call to open the media for');
      if (this.active) this.close();
      this.callId = callId;
      this.active = true;
      this.sent = { audioFrames: 0, videoFrames: 0 };
      this.received = { audioFrames: 0, videoFrames: 0 };
      this.player = PeerPlayout;
      PeerPlayout.reset(deps.remoteCanvas);
      const pc = new RTCPeerConnection({ iceServers: [{ urls: STUN }] });
      this.pc = pc;
      const pcmDC = pc.createDataChannel('pcm', { ordered: true });
      pcmDC.binaryType = 'arraybuffer';
      pcmDC.onmessage = (e) => this.onPcm(e.data);
      this.pcmDC = pcmDC;
      this.video = !!video;
      if (this.video) {
        // Video must not wait for resends: a lost packet would hold every later frame back.
        const videoDC = pc.createDataChannel('vp8', { ordered: true, maxPacketLifeTime: 200 });
        videoDC.binaryType = 'arraybuffer';
        videoDC.onmessage = (e) => this.onVideo(e.data);
        this.videoDC = videoDC;
      }
      pc.oniceconnectionstatechange = () => {
        if (!this.active) return;
        const st = pc.iceConnectionState;
        deps.onStatus('media link: ' + st);
        if (st === 'failed') { deps.onFailed('Call media connection lost'); }
      };
      this.startAudio();
      if (this.video) this.startVideo();

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIce(pc, 2500);
      let answer;
      try {
        answer = await deps.signal.webrtc(callId, pc.localDescription.sdp);
      } catch (e) {
        this.close();
        throw e;
      }
      if (!answer || !answer.sdpAnswer) { this.close(); throw new Error('WaCalls did not answer the media offer'); }
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdpAnswer });
      deps.onStatus('media leg negotiated');
      return this;
    },

    // --- audio up ---------------------------------------------------------
    startAudio() {
      this.stopAudioCapture();
      const stream = deps.getOutgoingAudio ? deps.getOutgoingAudio() : null;
      if (!stream || !stream.getAudioTracks().length) {
        // No audio yet (the avatar's voice arrives later): send silence so the callee's phone keeps receiving packets.
        this.startSilence();
        return;
      }
      this.stopSilence();
      try {
        const AudioCtx = root.AudioContext || root.webkitAudioContext;
        this.micCtx = new AudioCtx({ sampleRate: 16000 });
        if (this.micCtx.state === 'suspended') this.micCtx.resume().catch(() => {});
        this.micSource = this.micCtx.createMediaStreamSource(stream);
        this.micNode = this.micCtx.createScriptProcessor(2048, 1, 1);
        this.micNode.onaudioprocess = (evt) => {
          if (!this.active || !this.pcmDC || this.pcmDC.readyState !== 'open') return;
          const pcm16 = C.floatToInt16(evt.inputBuffer.getChannelData(0), this.muted);
          this.sendPcm(new Uint8Array(pcm16.buffer));
        };
        this.micSource.connect(this.micNode);
        // Connected to the destination only to keep the processor running; it writes silence.
        this.micNode.connect(this.micCtx.destination);
      } catch (e) {
        deps.onStatus('could not start call audio: ' + e.message);
      }
    },
    stopAudioCapture() {
      if (this.micNode) { try { this.micNode.disconnect(); } catch (e) {} this.micNode = null; }
      if (this.micSource) { try { this.micSource.disconnect(); } catch (e) {} this.micSource = null; }
      if (this.micCtx) { try { this.micCtx.close(); } catch (e) {} this.micCtx = null; }
    },
    startSilence() {
      if (this.silenceTimer) return;
      const frame = new Uint8Array(320 * 2);
      this.silenceTimer = setInterval(() => {
        if (!this.active || !this.pcmDC || this.pcmDC.readyState !== 'open') return;
        this.sendPcm(frame);
      }, 20);
    },
    stopSilence() {
      if (this.silenceTimer) { clearInterval(this.silenceTimer); this.silenceTimer = null; }
    },
    sendPcm(bytes) {
      try { this.pcmDC.send(bytes); this.sent.audioFrames++; } catch (e) {}
    },
    onPcm(data) {
      try {
        this.received.audioFrames++;
        PeerPlayout.playPcm(C.pcmToInt16(new Uint8Array(data)));
      } catch (e) {}
    },

    // --- video up ---------------------------------------------------------
    startVideo() {
      if (!this.supported()) { deps.onStatus('this browser cannot encode video for the call (no WebCodecs)'); return; }
      this.canvas = document.createElement('canvas');
      this.canvas.width = FRAME_W;
      this.canvas.height = FRAME_H;
      this.ctx = this.canvas.getContext('2d');
      this.encoder = new root.VideoEncoder({
        output: (chunk, meta) => this.sendEncoded(chunk, meta),
        error: (e) => deps.onStatus('video encoder error: ' + (e.message || e)),
      });
      this.encoder.configure({
        codec: 'avc1.42E01F',
        avc: { format: 'annexb' },
        latencyMode: 'realtime',
        width: FRAME_W,
        height: FRAME_H,
        bitrate: 600_000,
        framerate: FPS,
      });
      clearInterval(this.encodeTimer);
      this.encodeTimer = setInterval(() => this.encodeFrame(), 1000 / FPS);
    },
    encodeFrame() {
      if (!this.active || !this.encoder || this.encoder.state !== 'configured') return;
      if (!this.videoDC || this.videoDC.readyState !== 'open') return;
      // Drop frames instead of queueing them: queued frames are what makes the callee's picture lag further behind.
      if (this.videoDC.bufferedAmount > VIDEO_BUFFER_LIMIT) return;
      if (this.encoder.encodeQueueSize > 2) return;
      const src = deps.getAvatarVideo ? deps.getAvatarVideo() : null;
      const hasSize = !!(src && (src.videoWidth || src.width));
      // A canvas is ready as soon as it has a size; a video element needs decoded data (readyState >= 2).
      const live = hasSize && (src.tagName === 'CANVAS' || src.readyState >= 2);
      try {
        if (live) {
          const vw = src.videoWidth || src.width;
          const vh = src.videoHeight || src.height;
          const c = C.coverCrop(vw, vh, FRAME_W, FRAME_H);
          this.ctx.drawImage(src, c.sx, c.sy, c.sw, c.sh, 0, 0, FRAME_W, FRAME_H);
        } else {
          // Until the avatar produces frames, send a dark frame so the callee gets video right away.
          this.ctx.fillStyle = '#101010';
          this.ctx.fillRect(0, 0, FRAME_W, FRAME_H);
        }
      } catch (e) { return; }
      const ts = Math.round(performance.now() * 1000);
      let frame;
      try { frame = new root.VideoFrame(this.canvas, { timestamp: ts }); } catch (e) { return; }
      const wantKey = this.forceKeyframe || (ts - this.lastKeyframeAt) > 2_000_000;
      try { this.encoder.encode(frame, { keyFrame: wantKey }); } catch (e) {}
      if (wantKey) { this.forceKeyframe = false; this.lastKeyframeAt = ts; }
      try { frame.close(); } catch (e) {}
    },
    sendEncoded(chunk, meta) {
      if (!this.videoDC || this.videoDC.readyState !== 'open') return;
      try {
        const desc = meta && meta.decoderConfig && meta.decoderConfig.description;
        if (desc) this.avcDesc = new Uint8Array(desc.buffer ? desc.buffer.slice(desc.byteOffset, desc.byteOffset + desc.byteLength) : desc);
        const raw = new Uint8Array(chunk.byteLength);
        chunk.copyTo(raw);
        const keyframe = chunk.type === 'key';
        // Safari may hand back length-prefixed (AVCC) data; the call server only takes Annex-B.
        const annexb = C.toAnnexBAccessUnit(raw, { keyframe, desc: this.avcDesc });
        if (!annexb) return;
        const tsMs = Math.round(chunk.timestamp / 1000);
        this.videoDC.send(C.encodeVideoFrame({ keyframe, timestampMs: tsMs, payload: annexb }));
        this.sent.videoFrames++;
      } catch (e) {}
    },
    onVideo(data) {
      const m = C.decodeVideoFrame(new Uint8Array(data));
      if (!m) return;
      if (m.control === 'keyframe') { this.forceKeyframe = true; return; }
      this.received.videoFrames++;
      PeerPlayout.pushH264(m.payload, m);
    },
    keyframeBurst() {
      (this.kfTimers || []).forEach(clearTimeout);
      this.kfTimers = [];
      [0, 700, 1800, 3500].forEach((ms) => this.kfTimers.push(setTimeout(() => { this.forceKeyframe = true; }, ms)));
    },

    // Adds the video channel to a call that started as audio only, then tells WaCalls to signal the upgrade.
    async upgradeToVideo() {
      if (!this.active || this.video) return;
      if (!this.supported()) throw new Error('this browser cannot encode video for the call');
      this.video = true;
      const videoDC = this.pc.createDataChannel('vp8', { ordered: true, maxPacketLifeTime: 200 });
      videoDC.binaryType = 'arraybuffer';
      videoDC.onmessage = (e) => this.onVideo(e.data);
      this.videoDC = videoDC;
      this.startVideo();
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      await waitForIce(this.pc, 2500);
      const answer = await deps.signal.renegotiate(this.callId, this.pc.localDescription.sdp);
      if (!answer || !answer.sdpAnswer) throw new Error('WaCalls did not answer the video upgrade');
      await this.pc.setRemoteDescription({ type: 'answer', sdp: answer.sdpAnswer });
      await deps.signal.videoStart(this.callId);
    },

    close() {
      const wasActive = this.active;
      this.active = false;
      (this.kfTimers || []).forEach(clearTimeout);
      this.kfTimers = [];
      this.stopSilence();
      this.stopAudioCapture();
      clearInterval(this.encodeTimer);
      this.encodeTimer = null;
      if (this.encoder) { try { this.encoder.close(); } catch (e) {} this.encoder = null; }
      if (this.pcmDC) { try { this.pcmDC.close(); } catch (e) {} this.pcmDC = null; }
      if (this.videoDC) { try { this.videoDC.close(); } catch (e) {} this.videoDC = null; }
      if (this.pc) { try { this.pc.close(); } catch (e) {} this.pc = null; }
      this.forceKeyframe = true;
      this.lastKeyframeAt = 0;
      this.avcDesc = null;
      PeerPlayout.stop();
      if (wasActive) deps.onStatus(`media leg closed (sent ${this.sent.audioFrames} audio / ${this.sent.videoFrames} video, received ${this.received.audioFrames} audio / ${this.received.videoFrames} video)`);
      this.callId = null;
    },
  };

  function waitForIce(pc, maxMs) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const t = setTimeout(resolve, maxMs);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
      });
    });
  }

  // Plays the callee's voice and draws the callee's video (decoded H.264) onto the remote canvas.
  const PeerPlayout = {
    audioCtx: null, nextPlayTime: 0, decoder: null, canvas: null, c2d: null, rotation: 0,
    reset(canvas) {
      this.canvas = canvas || null;
      this.c2d = this.canvas ? this.canvas.getContext('2d') : null;
    },
    ensureAudio() {
      if (!this.audioCtx) {
        this.audioCtx = new (root.AudioContext || root.webkitAudioContext)({ sampleRate: 16000 });
        this.nextPlayTime = 0;
      }
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {});
      return this.audioCtx;
    },
    playPcm(int16) {
      try {
        const ctx = this.ensureAudio();
        const buf = ctx.createBuffer(1, int16.length, 16000);
        buf.copyToChannel(C.int16ToFloat32(int16), 0);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        // Back to back with a small lead so frame gaps do not click; resync if we fell behind.
        const now = ctx.currentTime;
        if (this.nextPlayTime < now) this.nextPlayTime = now + 0.06;
        src.start(this.nextPlayTime);
        this.nextPlayTime += buf.duration;
      } catch (e) {}
    },
    ensureDecoder() {
      if (this.decoder) return this.decoder;
      if (typeof root.VideoDecoder === 'undefined' || !this.canvas) return null;
      try {
        this.decoder = new root.VideoDecoder({
          output: (frame) => {
            try {
              const rot = this.rotation || 0;
              const fw = frame.displayWidth, fh = frame.displayHeight;
              const swap = rot === 90 || rot === 270;
              const cw = swap ? fh : fw, ch = swap ? fw : fh;
              if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
              this.c2d.save();
              this.c2d.translate(cw / 2, ch / 2);
              this.c2d.rotate((-rot * Math.PI) / 180);
              this.c2d.drawImage(frame, -fw / 2, -fh / 2, fw, fh);
              this.c2d.restore();
            } catch (e) {}
            try { frame.close(); } catch (e) {}
          },
          error: () => { this.decoder = null; },
        });
        this.decoder.configure({ codec: 'avc1.42E01F', optimizeForLatency: true });
      } catch (e) { this.decoder = null; }
      return this.decoder;
    },
    pushH264(bytes, wire) {
      if (wire && typeof wire.rotationDeg === 'number') this.rotation = wire.rotationDeg;
      const dec = this.ensureDecoder();
      if (!dec || dec.state !== 'configured') return;
      const keyframe = wire && typeof wire.keyframe === 'boolean' ? wire.keyframe : C.annexBHasKeyframe(bytes);
      const ts = wire && wire.timestampMs ? Math.round(wire.timestampMs * 1000) : Math.round(performance.now() * 1000);
      try { dec.decode(new root.EncodedVideoChunk({ type: keyframe ? 'key' : 'delta', timestamp: ts, data: bytes })); } catch (e) {}
    },
    stop() {
      this.rotation = 0;
      if (this.decoder) { try { this.decoder.close(); } catch (e) {} this.decoder = null; }
      if (this.audioCtx) { try { this.audioCtx.close(); } catch (e) {} this.audioCtx = null; }
      this.nextPlayTime = 0;
    },
  };

  root.WaCallsMedia = { configure: (n) => Leg.configure(n), open: (o) => Leg.open(o), leg: Leg, close: () => Leg.close(), setMuted: (m) => Leg.setMuted(m), upgradeToVideo: () => Leg.upgradeToVideo(), keyframeBurst: () => Leg.keyframeBurst(), supported: () => Leg.supported() };
})(typeof globalThis !== 'undefined' ? globalThis : this);
