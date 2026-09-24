# mp-relay integration spec (PHP side)

Everything the Pipecat assistant service needs from
[`multipurps/mp-relay`](https://github.com/multipurps/mp-relay). This lives in
a **separate repository and a separate pull request** — it is specified here
rather than implemented here because MadelineProto is PHP and that is where
the Telegram call transport belongs.

Read [ACAF-PROTOCOL.md](ACAF-PROTOCOL.md) first for the wire format.

---

## Why this work is necessary

`server-social/social-relay.js` `telegramCall()` sends
`gAHash: crypto.randomBytes(256)`. A real Telegram call requires
`g_a_hash = SHA-256(g_a)` as part of a Diffie-Hellman exchange; random bytes
can never complete one. `mp-relay`'s own README says call-placing is
"intentionally a separate, later piece of work." Until it exists, no Telegram
call carries audio, and the assistant service has nothing to attach to.

Per the instruction that existing code be left untouched, the broken stub is
still there, unmodified.

## What already works and must not be broken

`mp-relay` today implements login only:

| Route | Status |
| --- | --- |
| `POST /sessions/{userId}/start` | working |
| `POST /sessions/{userId}/verify` | working |
| `POST /sessions/{userId}/2fa` | working |
| `GET  /sessions/{userId}/status` | working |
| `DELETE /sessions/{userId}` | working |

All are behind `X-Internal-Secret`. Its `php:8.3-cli` image already has
`gmp sockets pgsql pdo_pgsql`, and MadelineProto v8 carries a pure-PHP
libtgvoip implementation plus a pure-PHP OGG Opus muxer — so **no new PHP
extension, no FFI, and no FFmpeg are required** for the design below.

## New routes to add

```
POST   /calls                 -> place a call, start the assistant
DELETE /calls/{callId}        -> hang up
GET    /calls/{callId}        -> status
GET    /healthz               -> liveness (no secret)
```

`POST /calls` accepts `{"userId": "...", "to": "@username or +E164"}` and
returns `{"callId": "...", "status": "ringing"}`.

## The two MadelineProto hooks that make this work

Both are documented MadelineProto v8 behaviour, not inference:

- **Inbound audio** — `$call->setOutput($stream)`, where `$stream` may be a
  `WritableStream` (MadelineProto's docs: *"Can be used to pipe OGG OPUS audio
  data to ffmpeg, asterisk via amphp/process, amphp/socket"*).
- **Outbound audio** — `$call->play($stream)`, where `$stream` may be a
  `ReadableStream` (maintainer-confirmed: *"a TCP/UDP socket or any other kind
  of stream supported by amphp"*).

So both directions are an amphp socket to the assistant service.

## Audio format conversion

MadelineProto deals in OGG Opus at 48 kHz; ACAF carries PCM16 at 16 kHz. Two
options:

| Option | Approach | Trade-off |
| --- | --- | --- |
| **A (recommended)** | Add `ffmpeg` + `libopus` to the image and use MadelineProto's realtime conversion, which the docs describe for exactly this purpose. | Adds two packages to mp-relay's Dockerfile. Clean, standard algorithm. |
| **B** | Use `@libtgvoip_bot`-style pre-conversion. | Not possible for live audio — it is an offline file conversion. |
| **C** | Set `ASSISTANT_BRIDGE_SAMPLE_RATE=48000` and skip resampling entirely, still converting Opus↔PCM in PHP. | Removes the rate conversion but still needs Opus. Worth considering, since 48 kHz is Telegram's native rate. |

This is the one place where the design has a real choice, and it is a choice
for whoever owns the mp-relay deploy.

## Reference adapter (PHP)

Sketch, not drop-in code — it names the MadelineProto objects and the ACAF
frames, and leaves error handling to the implementer.

```php
<?php declare(strict_types=1);

use Amp\Socket\ConnectContext;
use Amp\Websocket\Client\WebsocketHandshake;
use Amp\Websocket\Client\connect;
use danog\MadelineProto\VoIP;

/**
 * One Telegram call, bridged to the Pipecat assistant over ACAF.
 *
 * Owns: the Telegram call object, the ACAF socket, the outbound playout
 * queue (which is what `interrupt` must clear), and sequence counters.
 */
final class AssistantBridge
{
    private int $inSequence = 0;
    private int $outSequence = 0;
    /** @var array<int, string> queued outbound frames, dropped on interrupt */
    private array $playout = [];

    public function __construct(
        private readonly VoIP $call,
        private readonly string $sessionId,
        private readonly string $bridgeUrl,      // ASSISTANT_BRIDGE_URL
        private readonly string $bridgeSecret,   // ASSISTANT_BRIDGE_SECRET
        private readonly int $sampleRate,        // ASSISTANT_BRIDGE_SAMPLE_RATE
    ) {}

    public function run(): void
    {
        $context = (new ConnectContext)->withConnectTimeout(10);
        $handshake = (new WebsocketHandshake($this->bridgeUrl))
            ->withHeader('X-Assistant-Session', $this->sessionId);
        $socket = connect($handshake, null, $context);
        $connection = $socket->connect();

        // --- handshake --------------------------------------------------
        // `secret` is compared in constant time on the service side.
        $connection->sendText(json_encode([
            'type'       => 'hello',
            'sessionId'  => $this->sessionId,
            'platform'   => 'telegram',
            'sampleRate' => $this->sampleRate,
            'channels'   => 1,
            'encoding'   => 'pcm_s16le',
            'secret'     => $this->bridgeSecret,
        ], JSON_THROW_ON_ERROR));

        // --- outbound: assistant audio -> Telegram -----------------------
        // `play()` takes a ReadableStream; feed it from the socket.
        // MadelineProto converts PCM -> OGG Opus (see options A/C above).
        $this->call->play($this->assistantAudioStream($connection));

        // --- inbound: caller audio -> assistant --------------------------
        // `setOutput()` takes a WritableStream, so this is where the caller's
        // audio leaves Telegram.
        $this->call->setOutput($this->acafWritableStream($connection));

        $this->pumpControlMessages($connection);
    }

    /** Build one ACAF frame. Header is 28 bytes, little-endian. */
    private function frame(int $type, string $payload): string
    {
        return pack(
            'a4CCCCIIQI',
            'ACAF',
            1,                      // version
            $type,                  // 1=in 2=out 3=partial 4=interrupt 5=heartbeat
            1,                      // encoding: 1 = PCM_S16LE
            1,                      // channels
            $this->sampleRate,
            $this->outSequence++,
            (int) (microtime(true) * 1000),
            strlen($payload),
        ) . $payload;
    }

    /** Parse an inbound ACAF frame. */
    private function parse(string $data): array
    {
        if (strlen($data) < 28) {
            throw new RuntimeException('short ACAF frame');
        }
        $h = unpack('a4magic/Cversion/Ctype/Cencoding/Cchannels/Irate/Iseq/Pts/Ilen', $data);
        if ($h['magic'] !== 'ACAF') {
            throw new RuntimeException('bad ACAF magic');
        }
        if ($h['version'] !== 1) {
            throw new RuntimeException("unsupported ACAF version {$h['version']}");
        }
        $payload = substr($data, 28, $h['len']);
        if (strlen($payload) !== $h['len']) {
            throw new RuntimeException('truncated ACAF payload');
        }
        return $h + ['payload' => $payload];
    }

    /** `interrupt` must clear the playout queue, not just be logged. */
    private function onInterrupt(): void
    {
        $this->playout = [];
    }
}
```

### Five things the implementation must get right

1. **`interrupt` clears the playout queue.** This is the whole mechanism
   behind barge-in. Audio already handed to Telegram cannot be recalled;
   everything still queued must be dropped immediately.
2. **Sequence numbers start at 0 and increment per frame**, per direction.
   Wrap at 2³². Do not reset them on reconnect — a reset shows up as a
   phantom loss spike.
3. **Answer `ping` with `pong`.** Unanswered heartbeats for 2.5 intervals make
   the service close the bridge, which is how it detects a half-open socket.
   Do not treat that close as a Telegram-side hangup.
4. **Reconnect with the same `sessionId`** to resume within the 15 s grace.
   A different id starts a fresh conversation and loses the history.
5. **Never log the bridge secret or audio payloads.** Log frame *metadata*
   (sequence, byte count, level) — the service's `metrics` frames exist so
   call health can be diagnosed without either.

## Testing the PHP side without a real call

Point `ASSISTANT_BRIDGE_URL` at a locally running service in mock mode:

```bash
cd pipecat-service && ASSISTANT_MOCK_MODE=true python -m app.main
# ASSISTANT_BRIDGE_URL=ws://localhost:8080/stream in the PHP process
```

Mock mode needs no credentials and no provider keys. The service's
`tests/test_integration_bridge.py` is the reference for exactly what a
correctly-behaving peer sends and expects.

## Open question for the mp-relay author

The current stub advertises `libraryVersions: ['4.0.0']`, `minLayer: 65`,
`maxLayer: 92` — the legacy libtgvoip generation. MadelineProto v8 also has
newer WebRTC engines, and the OGG-Opus-only restriction applies to the
**legacy** engine for 1:1 calls. Which engine a real call negotiates determines
the exact outbound container, and this can only be settled against a live
account. If the newer engines are selected, option A/C above gets simpler.
