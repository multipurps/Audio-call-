# ACAF v1 — Audio Call Assistant Frame protocol

The wire format between the Telegram side (`multipurps/mp-relay`, PHP) and the
Pipecat assistant service. Implemented in
[`pipecat-service/app/protocol.py`](../pipecat-service/app/protocol.py);
reference PHP implementation in
[MP-RELAY-INTEGRATION.md](MP-RELAY-INTEGRATION.md).

## Transport

A single WebSocket connection per call, to `/stream` on the assistant service.
JSON text frames carry control; binary frames carry audio.

**Audio never traverses Vercel.** mp-relay connects to this service directly.

## Binary frame layout

Little-endian throughout.

| Offset | Size | Field | Notes |
| --- | --- | --- | --- |
| 0 | 4 | `magic` | ASCII `ACAF`. Resync anchor. |
| 4 | 1 | `version` | `1` |
| 5 | 1 | `type` | see below |
| 6 | 1 | `encoding` | see below |
| 7 | 1 | `channels` | `1` on both telephony paths |
| 8 | 4 | `sample_rate` | uint32 Hz |
| 12 | 4 | `sequence` | uint32, monotonic per session, wraps |
| 16 | 8 | `timestamp_ms` | uint64. **Must be 64-bit** — epoch ms exceeds uint32. |
| 24 | 4 | `payload_len` | uint32, ≤ 65536 |
| 28 | N | `payload` | raw audio |

Header is **28 bytes**. `sessionId` is carried once in the `hello` handshake
rather than in every frame, which is what keeps overhead at 28 bytes.

### `type`

| Value | Name | Direction | Meaning |
| --- | --- | --- | --- |
| 1 | `AUDIO_IN` | mp-relay → service | Caller's speech |
| 2 | `AUDIO_OUT` | service → mp-relay | Assistant's speech |
| 3 | `PARTIAL_TRANSCRIPT` | service → mp-relay | Reserved; unused while STT is batch |
| 4 | `INTERRUPT` | both | Barge-in |
| 5 | `HEARTBEAT` | both | Liveness on the audio plane |

### `encoding`

| Value | Name | Status |
| --- | --- | --- |
| 1 | `PCM_S16LE` | **Required.** The only encoding this build accepts. |
| 2 | `MULAW` | Decodable inbound (Twilio path). Never emitted. |
| 3 | `OGG_OPUS` | **Rejected with a clear error.** See below. |

**Why PCM16 and not Opus.** Pipecat 1.11 ships no Opus decoder — verified:
`pipecat/audio/utils.py` exposes only mu-law, A-law and WAV helpers. Telegram
speaks Opus at 48 kHz, so *somewhere* has to convert. Putting it on the PHP
side is the right call because MadelineProto v8 already carries a pure-PHP
libtgvoip implementation and a pure-PHP OGG Opus muxer, and the legacy call
engine accepts nothing but OGG Opus for `play()` anyway. The alternative —
adding a native libopus build to a Python service that otherwise needs no
codec — would put a Telegram-specific format inside the Pipecat process, which
the brief explicitly forbids.

## Handshake

The peer must send `hello` first, within 10 s:

```json
{
  "type": "hello",
  "sessionId": "call-abc-123",
  "platform": "telegram",
  "sampleRate": 16000,
  "channels": 1,
  "encoding": "pcm_s16le",
  "secret": "<ASSISTANT_BRIDGE_SECRET>",
  "userId": "<supabase user id, optional>"
}
```

`secret` is required unless `ASSISTANT_MOCK_MODE=true`. Compared in constant
time. A wrong or missing secret closes the socket.

Service replies:

```json
{"type": "ready", "sessionId": "call-abc-123", "platform": "telegram"}
```

`sampleRate` / `channels` / `encoding` default to `16000` / `1` / `pcm_s16le`
when omitted. `encoding` must be `pcm_s16le`; anything else is refused at the
handshake rather than failing per frame for the whole call.

## Control messages

| Type | Direction | Meaning |
| --- | --- | --- |
| `hello` | → service | Handshake (above) |
| `ready` | ← service | Session established |
| `ping` / `pong` | both | Heartbeat. Reply with the opposite. |
| `interrupt` | both | Barge-in: **drop all queued outbound audio immediately** |
| `hangup` | both | Call over; close cleanly |
| `stopped` | ← service | Session torn down; includes `reason` |
| `metrics` | ← service | Periodic counters (below) |
| `error` | ← service | Non-fatal problem |

Control frames larger than 8 KiB are ignored.

### `metrics`

Every 15 s by default:

```json
{
  "type": "metrics", "sessionId": "call-abc-123", "uptimeSecs": 45.2,
  "inbound": {"received": 2100, "missing": 3, "reordered": 0,
              "duplicates": 0, "lossRatio": 0.0014},
  "outboundFramesSent": 1800, "bargeIns": 2, "ttsFramesCancelled": 37
}
```

No audio content, no transcript text, no identifiers beyond the session id.

## Required peer behaviour

1. **Sequence numbers.** Start at 0, increment per frame, wrap at 2³². A gap is
   counted and logged, never retransmitted — by the time a gap is noticed the
   audio in it is stale.
2. **Heartbeat.** Answer `ping` with `pong`. The service closes the bridge if
   heartbeats go unanswered for 2.5 intervals, which is how a half-open socket
   is detected.
3. **`interrupt`.** Clear the outbound playout queue. Audio already written to
   Telegram cannot be recalled, but anything not yet sent must be dropped.
4. **`hangup`.** Discard the Telegram call. The service also sends this when
   the assistant decides the conversation is over.
5. **Backpressure.** Read continuously. The service drops the **oldest**
   outbound frame when its queue is full, so a slow reader loses stale audio
   rather than accumulating latency.
6. **Reconnect.** Reconnect within `reconnect_grace_secs` (15 s) using the
   **same** `sessionId` to resume the conversation with its history intact.
   After the grace period the session is reaped and a new call must start fresh.

## Limits

| Limit | Value | Configurable |
| --- | --- | --- |
| Max payload | 64 KiB | `ASSISTANT_MAX_FRAME_BYTES` |
| Max control frame | 8 KiB | no |
| Hello timeout | 10 s | no |
| Idle timeout | 30 s | `ASSISTANT_IDLE_TIMEOUT_SECS` |
| Heartbeat interval | 10 s | `ASSISTANT_HEARTBEAT_INTERVAL_SECS` |
| Reconnect grace | 15 s | no |
| Outbound queue | 100 frames | `ASSISTANT_OUTBOUND_QUEUE_MAX_FRAMES` |
| Max call duration | 1800 s | `ASSISTANT_MAX_CALL_SECONDS` |
| Max concurrent sessions | 200 | no |
