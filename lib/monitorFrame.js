// Decodes one frame from the assistant service's /monitor websocket:
//   byte 0      direction (caller / Emysa)
//   bytes 1-4   sample rate, uint32 little-endian
//   bytes 5...  PCM16 little-endian mono
// The PCM starts at an ODD byte offset, and a typed array view must start on
// a multiple of its element size, so `new Int16Array(buf, 5, n)` throws a
// RangeError and no audio ever plays. The payload is copied to an aligned
// buffer first.
export function decodeMonitorFrame(buf) {
  if (!buf || buf.byteLength < 7) return null;
  const view = new DataView(buf);
  const direction = view.getUint8(0);
  const rate = view.getUint32(1, true) || 16000;
  const pcm = buf.slice(5);
  const samples = new Int16Array(pcm, 0, Math.floor(pcm.byteLength / 2));
  if (!samples.length) return null;
  return { direction, rate, samples };
}
