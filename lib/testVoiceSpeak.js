// Speak one line with the user's own ElevenLabs / Cartesia key (the voice they are
// testing). Used by the in-app call's HTTP speak path; phone calls speak it in the
// Pipecat service. Failures are returned to the caller, never swapped for another voice.
const err = (message, statusCode = 502) => Object.assign(new Error(message), { statusCode });

export async function testVoiceSpeak({ provider, voiceId, apiKey }, text, fetchImpl = fetch) {
  if (provider === 'elevenlabs') {
    const resp = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5' }),
    });
    if (!resp.ok) throw err(`ElevenLabs rejected the request (${resp.status}): ${(await resp.text().catch(() => '')).slice(0, 200)}`);
    return { audio: Buffer.from(await resp.arrayBuffer()), mimeType: 'audio/mpeg' };
  }
  if (provider === 'cartesia') {
    const resp = await fetchImpl('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Cartesia-Version': '2025-04-16', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model_id: 'sonic-2',
        transcript: text,
        voice: { mode: 'id', id: voiceId },
        output_format: { container: 'mp3', bit_rate: 128000, sample_rate: 44100 },
      }),
    });
    if (!resp.ok) throw err(`Cartesia rejected the request (${resp.status}): ${(await resp.text().catch(() => '')).slice(0, 200)}`);
    return { audio: Buffer.from(await resp.arrayBuffer()), mimeType: 'audio/mpeg' };
  }
  throw err('Unknown test voice provider', 400);
}
