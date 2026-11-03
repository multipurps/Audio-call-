// Pure helpers for the browser side of a WaCalls call (WhatsApp over WaCalls on Fly).
// Loaded as a plain script, and also testable in Node (see tests/wacalls-media-core.test.mjs).
// Frame formats match wacalls/cmd/server/bridge.go:
//   "pcm"  raw 16 kHz mono s16le, both directions, unframed.
//   "vp8"  H.264 access units, both directions. 5-byte header: flags (bit0 keyframe,
//          bits1-2 rotation in 90-degree steps) + uint32 BE timestamp in ms, then the
//          Annex-B access unit. A 1-byte frame with 0x01 is a keyframe request.
(function (root) {
  'use strict';

  const CONTROL_KEYFRAME_REQUEST = 0x01;
  const VIDEO_HEADER = 5;

  function encodeVideoFrame({ keyframe = false, timestampMs = 0, rotationDeg = 0, payload }) {
    const out = new Uint8Array(VIDEO_HEADER + payload.byteLength);
    const rot = ((Math.round(rotationDeg / 90) % 4) + 4) % 4;
    out[0] = (keyframe ? 1 : 0) | (rot << 1);
    const ts = Math.round(timestampMs) >>> 0;
    out[1] = (ts >>> 24) & 0xff;
    out[2] = (ts >>> 16) & 0xff;
    out[3] = (ts >>> 8) & 0xff;
    out[4] = ts & 0xff;
    out.set(payload, VIDEO_HEADER);
    return out;
  }

  // Returns { control: 'keyframe' } for a control frame, a parsed access unit, or null when too short.
  function decodeVideoFrame(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b.length === 1 && b[0] === CONTROL_KEYFRAME_REQUEST) return { control: 'keyframe' };
    if (b.length < VIDEO_HEADER + 1) return null;
    const flags = b[0];
    const timestampMs = ((b[1] << 24) | (b[2] << 16) | (b[3] << 8) | b[4]) >>> 0;
    return {
      keyframe: (flags & 1) !== 0,
      rotationDeg: ((flags >> 1) & 3) * 90,
      timestampMs,
      payload: b.subarray(VIDEO_HEADER),
    };
  }

  // Copies bytes into a fresh, aligned Int16Array (a view at an odd offset cannot be read as Int16).
  function pcmToInt16(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const copy = b.slice();
    return new Int16Array(copy.buffer, 0, Math.floor(copy.length / 2));
  }

  function int16ToFloat32(int16) {
    const f32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 0x8000;
    return f32;
  }

  // Microphone float samples -> s16le, muted = digital silence.
  function floatToInt16(input, muted) {
    const pcm16 = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const v = Math.max(-1, Math.min(1, input[i]));
      pcm16[i] = muted ? 0 : (v < 0 ? v * 0x8000 : v * 0x7fff);
    }
    return pcm16;
  }

  // Annex-B start-code scan for an IDR slice (5) or SPS (7).
  function annexBHasKeyframe(bytes) {
    const v = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i + 4 < v.length; i++) {
      const is4 = v[i] === 0 && v[i + 1] === 0 && v[i + 2] === 0 && v[i + 3] === 1;
      const is3 = !is4 && v[i] === 0 && v[i + 1] === 0 && v[i + 2] === 1;
      if (!is4 && !is3) continue;
      const nalType = v[i + (is4 ? 4 : 3)] & 0x1f;
      if (nalType === 5 || nalType === 7) return true;
    }
    return false;
  }

  function h264Format(b) {
    if (b.length > 3 && b[0] === 0 && b[1] === 0 && (b[2] === 1 || (b[2] === 0 && b[3] === 1))) return 'annexb';
    return 'avcc';
  }

  function h264HasParamSets(b) {
    let sps = false, pps = false;
    for (let i = 0; i + 4 < b.length && i < 4096; i++) {
      if (b[i] === 0 && b[i + 1] === 0 && (b[i + 2] === 1 || (b[i + 2] === 0 && b[i + 3] === 1))) {
        const nal = b[i + (b[i + 2] === 1 ? 3 : 4)] & 0x1f;
        if (nal === 7) sps = true;
        if (nal === 8) pps = true;
      }
    }
    return sps && pps;
  }

  // avcC: [4] = lengthSize-1 (low 2 bits), [5] = numSPS (low 5 bits), then SPS entries, numPPS, PPS entries.
  function avcCParamSets(desc) {
    const out = [];
    if (!desc || desc.length < 8) return out;
    let o = 5;
    const nSps = desc[o++] & 0x1f;
    for (let i = 0; i < nSps && o + 2 <= desc.length; i++) {
      const l = (desc[o] << 8) | desc[o + 1]; o += 2; out.push(desc.subarray(o, o + l)); o += l;
    }
    const nPps = desc[o++] || 0;
    for (let i = 0; i < nPps && o + 2 <= desc.length; i++) {
      const l = (desc[o] << 8) | desc[o + 1]; o += 2; out.push(desc.subarray(o, o + l)); o += l;
    }
    return out;
  }

  function concatNals(nals) {
    let n = 0;
    nals.forEach((x) => { n += 4 + x.length; });
    const out = new Uint8Array(n);
    let o = 0;
    nals.forEach((x) => { out[o++] = 0; out[o++] = 0; out[o++] = 0; out[o++] = 1; out.set(x, o); o += x.length; });
    return out;
  }

  function prependParamSets(annexb, desc) {
    const ps = concatNals(avcCParamSets(desc));
    const out = new Uint8Array(ps.length + annexb.length);
    out.set(ps, 0);
    out.set(annexb, ps.length);
    return out;
  }

  // Length-prefixed (AVCC) access unit -> Annex-B. Keyframes get SPS/PPS from the avcC. Null if it does not parse.
  function avccToAnnexB(b, desc, isKey) {
    const lenSize = (desc && desc.length > 4) ? ((desc[4] & 3) + 1) : 4;
    const nals = [];
    if (isKey && desc) avcCParamSets(desc).forEach((x) => nals.push(x));
    let o = 0;
    while (o + lenSize <= b.length) {
      let l = 0;
      for (let i = 0; i < lenSize; i++) l = (l * 256) + b[o + i];
      o += lenSize;
      if (l <= 0 || o + l > b.length) return null;
      nals.push(b.subarray(o, o + l));
      o += l;
    }
    if (o !== b.length || !nals.length) return null;
    return concatNals(nals);
  }

  // Encoder output -> Annex-B access unit ready for the vp8 channel, or null if it cannot be converted.
  function toAnnexBAccessUnit(payload, { keyframe, desc }) {
    if (h264Format(payload) === 'annexb') {
      if (keyframe && desc && !h264HasParamSets(payload)) return prependParamSets(payload, desc);
      return payload;
    }
    return avccToAnnexB(payload, desc, keyframe);
  }

  // Source rectangle that fills the canvas without stretching (CSS object-fit: cover).
  function coverCrop(vw, vh, cw, ch) {
    if (!vw || !vh) return { sx: 0, sy: 0, sw: vw || cw, sh: vh || ch };
    const scale = Math.max(cw / vw, ch / vh);
    const sw = cw / scale;
    const sh = ch / scale;
    return { sx: (vw - sw) / 2, sy: (vh - sh) / 2, sw, sh };
  }

  // Destination rectangle that shows the whole picture without stretching (CSS object-fit: contain).
  function containFit(vw, vh, cw, ch) {
    const scale = Math.min(cw / vw, ch / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    return { dx: (cw - dw) / 2, dy: (ch - dh) / 2, dw, dh };
  }

  // The avatar greeting waits until the callee has picked up plus the delay (5 s by default).
  // Returns the milliseconds still to wait, never negative.
  function greetingWaitMs(connectedAt, now, delayMs = 5000) {
    if (!connectedAt) return delayMs;
    return Math.max(0, connectedAt + delayMs - now);
  }

  const api = {
    CONTROL_KEYFRAME_REQUEST, VIDEO_HEADER,
    encodeVideoFrame, decodeVideoFrame, pcmToInt16, int16ToFloat32, floatToInt16,
    annexBHasKeyframe, h264Format, h264HasParamSets, avcCParamSets, concatNals,
    prependParamSets, avccToAnnexB, toAnnexBAccessUnit, coverCrop, containFit, greetingWaitMs,
  };
  root.WaCallsMediaCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
