// Drives one WhatsApp call through WaCalls on Fly, from the browser:
// start the call, wait for the callee to pick up, open the media leg, end it cleanly.
// The server does all the WaCalls work (wacalls-media.js only moves media). Every server call goes
// through the `api` function the page passes in, so the page's sign-in is used and no key is in the page.
(function (root) {
  'use strict';
  const POLL_MS = 1500;
  const RING_LIMIT_MS = 90_000;

  // Pure decision: what to do next, given the WaCalls state and what we already did.
  //   'open-media'   the callee picked up and the media leg is not open yet
  //   'finish-ended' the call ended on WaCalls's side
  //   'no-answer'    nobody picked up within the ring limit
  //   'wait'         keep polling
  function decideNext({ flyState, mediaOpen, ringedMs }) {
    if (flyState === 'ended') return 'finish-ended';
    if (flyState === 'active') return mediaOpen ? 'wait' : 'open-media';
    if (!mediaOpen && ringedMs >= RING_LIMIT_MS) return 'no-answer';
    return 'wait';
  }

  const Ctl = {
    api: null,       // async (action, { method, body, query }) -> json, throws on error
    media: null,     // the WaCallsMedia object (wacalls-media.js)
    callId: null,
    video: false,
    phase: 'idle',   // idle | ringing | connected | ending | ended
    timer: null,
    ringedMs: 0,
    mediaOpen: false,
    onUpdate: () => {},

    setup({ api, media, onUpdate }) {
      this.api = api;
      this.media = media || root.WaCallsMedia;
      this.onUpdate = onUpdate || (() => {});
    },

    async start({ to, name = '', video = false }) {
      if (this.phase !== 'idle' && this.phase !== 'ended') throw new Error('A WhatsApp call is already in progress');
      if (!this.api || !this.media) throw new Error('WhatsApp calling is not set up on this page');
      this.phase = 'ringing';
      this.video = !!video;
      this.ringedMs = 0;
      this.mediaOpen = false;
      this.onUpdate({ phase: 'ringing', text: `Calling ${name || to}…` });
      const out = await this.api('whatsapp-fly-call', { method: 'POST', body: { to, video: this.video, contactName: name } });
      this.callId = out.callId;
      this.timer = setInterval(() => this.tick(), POLL_MS);
      return out;
    },

    async tick() {
      if (!this.callId || this.phase === 'ending' || this.phase === 'ended') return;
      this.ringedMs += POLL_MS;
      let fly;
      try {
        fly = await this.api('whatsapp-fly-state', { method: 'GET', query: { callId: this.callId } });
      } catch (err) {
        // A failed poll is not a hang-up: try again on the next tick.
        return;
      }
      const action = decideNext({ flyState: fly.state, mediaOpen: this.mediaOpen, ringedMs: this.ringedMs });
      if (action === 'open-media') return this.openMedia();
      if (action === 'finish-ended') return this.finish('The call ended.');
      if (action === 'no-answer') return this.end('No one picked up.');
    },

    async openMedia() {
      this.mediaOpen = true; // set first so a slow open is not started twice by the next tick
      this.phase = 'connected';
      this.onUpdate({ phase: 'connected', text: 'Connected' });
      try {
        // The server answers with { sdp_answer }; the media leg expects { sdpAnswer }.
        const answer = (out) => ({ sdpAnswer: out.sdp_answer });
        this.media.configure({
          signal: {
            webrtc: async (callId, sdp) => answer(await this.api('whatsapp-fly-webrtc', { method: 'POST', body: { callId, sdp_offer: sdp } })),
            renegotiate: async (callId, sdp) => answer(await this.api('whatsapp-fly-renegotiate', { method: 'POST', body: { callId, sdp_offer: sdp } })),
            videoStart: async (callId) => this.api('whatsapp-fly-video-start', { method: 'POST', body: { callId } }),
            videoAccept: async (callId) => this.api('whatsapp-fly-video-accept', { method: 'POST', body: { callId } }),
          },
          onStatus: (text) => this.onUpdate({ phase: this.phase, text }),
          onFailed: (reason) => this.end(reason),
        });
        await this.media.open({ callId: this.callId, video: this.video });
      } catch (err) {
        this.end(`Could not open the call media: ${err.message}`);
      }
    },

    // Hangs up on WaCalls and in the browser. Safe to call more than once.
    async end(reason = 'The call ended.') {
      if (this.phase === 'ending' || this.phase === 'ended' || this.phase === 'idle') return;
      this.phase = 'ending';
      clearInterval(this.timer);
      this.timer = null;
      try { this.media.close(); } catch (e) {}
      if (this.callId) {
        try { await this.api('whatsapp-fly-end', { method: 'POST', body: { callId: this.callId } }); } catch (e) {}
      }
      this.phase = 'ended';
      this.mediaOpen = false;
      this.onUpdate({ phase: 'ended', text: reason });
    },

    finish(reason) {
      clearInterval(this.timer);
      this.timer = null;
      try { this.media.close(); } catch (e) {}
      this.phase = 'ended';
      this.mediaOpen = false;
      this.onUpdate({ phase: 'ended', text: reason });
    },
  };

  root.WaCallsFlyCall = { setup: (o) => Ctl.setup(o), start: (o) => Ctl.start(o), end: (r) => Ctl.end(r), state: () => Ctl, decideNext };
})(typeof globalThis !== 'undefined' ? globalThis : this);
