// Connects a Signal call's virtual PulseAudio devices to raw PCM streams.
// Format (from the tunnel docs): 48 kHz, mono, signed 16-bit little-endian.
// Device naming follows the signal-call-tunnel README (UNVERIFIED on a live call):
//   write to  sink_for_<inputDeviceName>      (audio the caller hears)
//   read from <outputDeviceName>.monitor      (audio the caller says)
import { spawn } from 'node:child_process';

const FMT = ['--rate=48000', '--channels=1', '--format=s16le', '--raw'];

export function attachAudio({ callId, inputDeviceName, outputDeviceName }) {
  const rec = spawn('parecord', [`--device=${outputDeviceName}.monitor`, ...FMT]);
  const play = spawn('pacat', ['--playback', `--device=sink_for_${inputDeviceName}`, ...FMT]);
  const log = (p, d) => console.error(`[audio ${callId} ${p}] ${String(d).trim()}`);
  rec.stderr.on('data', (d) => log('rec', d));
  play.stderr.on('data', (d) => log('play', d));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    rec.kill('SIGTERM');
    play.stdin.end();
    play.kill('SIGTERM');
  };
  rec.on('exit', close);
  play.on('exit', close);
  return { fromCaller: rec.stdout, toCaller: play.stdin, close };
}

// ASSISTANT_MODE=echo: the caller hears themselves (about 1s late). This proves the whole
// path (signal-cli -> tunnel -> PulseAudio -> bridge -> back) before any AI is attached.
export function attachAssistant(audio, mode = process.env.ASSISTANT_MODE || 'echo') {
  if (mode === 'echo') {
    const delayChunks = [];
    audio.fromCaller.on('data', (chunk) => {
      delayChunks.push(chunk);
      if (delayChunks.length > 10) audio.toCaller.write(delayChunks.shift());
    });
    return;
  }
  // The Pipecat / ACAF v1 adapter belongs here. It needs the protocol spec from the
  // Audio-call- repo (pipecat-service/), which this session has not read yet.
  throw new Error(`ASSISTANT_MODE "${mode}" is not implemented yet`);
}
