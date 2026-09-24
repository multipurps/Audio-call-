"""ACAF <-> Pipecat frame serializer.

Implements Pipecat's `FrameSerializer` interface (verified against
pipecat-ai 1.11.0's `pipecat/serializers/base_serializer.py`) so the ACAF
bridge plugs into a standard `FastAPIWebsocketTransport` with no bespoke
transport plumbing.

This module is the *only* place that knows both the wire protocol and
Pipecat's frames. Everything Telegram-specific lives on the PHP side of the
bridge; everything Pipecat-specific lives here; the protocol module in
between knows neither.

Interruption handling (the brief's barge-in requirement) is worth spelling
out, because it is the difference between an assistant that feels responsive
and one that talks over people:

  * Inbound: an `INTERRUPT` control message, or the caller simply starting to
    speak, produces Pipecat's normal `UserStartedSpeakingFrame` flow via the
    transport's VAD. Pipecat then emits `InterruptionFrame` internally, which
    `serialize` turns into an outbound `INTERRUPT` control frame.
  * Outbound: when `serialize` sees `InterruptionFrame`, it (a) flushes the
    pending sequence state for the outgoing stream and (b) returns the
    control frame. The bridge, on receiving it, must clear its own playout
    queue -- audio already handed to Telegram cannot be un-handed, but audio
    not yet sent can and must be dropped.
  * `TTSSpeakFrame`-driven audio that has already been converted to ACAF
    `AUDIO_OUT` frames but is still queued is dropped by the bridge, not here,
    because that is where the queue lives.
"""

from __future__ import annotations

import json
import time
from typing import Any

from loguru import logger

from pipecat.frames.frames import (
    AudioRawFrame,
    CancelFrame,
    EndFrame,
    Frame,
    InputAudioRawFrame,
    InterruptionFrame,
    OutputTransportMessageFrame,
    OutputTransportMessageUrgentFrame,
)
from pipecat.processors.frame_processor import FrameProcessorSetup
from pipecat.serializers.base_serializer import FrameSerializer

from app.audio import PCM16Resampler, mulaw_to_pcm16

# Note on why Pipecat's own audio helpers are not used on this path.
#
# `pipecat.audio.utils.create_stream_resampler()` returns a soxr streaming
# resampler. Verified against pipecat-ai 1.11.0 in this environment: fed
# 20 ms telephony frames it returns **0 bytes** for the first ~6 frames
# (measured: 5 frames of 320 B in, still 0 B out; the 6th frame's call
# returned 3032 B at once). Two consequences make it unusable for a carrier
# bridge:
#
#   1. ~120 ms of dead air at the start of every call, and
#   2. bursty output -- soxr emits nothing, then a large block -- which
#      breaks the steady 20 ms cadence Telegram and Twilio both require.
#
# `PCM16Resampler` in app/audio.py is deterministic per frame and stateful
# across frames, which is the contract a telephony bridge actually needs. It
# is also the implementation covered by the audio unit tests against ITU-T
# G.711 reference vectors.
#
# mu-law likewise uses the local `mulaw_to_pcm16` rather than Pipecat's
# `ulaw_to_pcm`, so that mulaw decode *and* resample are one tested path
# instead of a same-rate Pipecat path and a rate-change local path.
from app.protocol import (
    CONTROL_HANGUP,
    CONTROL_INTERRUPT,
    CONTROL_METRICS,
    AudioFrame,
    ControlMessage,
    Encoding,
    FrameType,
    ProtocolError,
    SequenceTracker,
)

JSON_CONTROL = "json"
BINARY_AUDIO = "binary"


class TelegramFrameSerializer(FrameSerializer):
    """Serializer for the ACAF bridge protocol.

    Configured by the bridge's `hello` handshake: the peer declares its audio
    format, this serializer adapts to it. Nothing about the negotiated format
    is assumed -- the report's codec table exists because Telegram (48 kHz
    Opus), Twilio (8 kHz mu-law) and Pipecat (16/24 kHz PCM) genuinely differ.
    """

    class InputParams(FrameSerializer.InputParams):
        """Configuration for the ACAF serializer.

        Parameters:
            bridge_sample_rate: Sample rate the peer declared in `hello`.
                Frames are converted between this and the pipeline rate.
            bridge_channels: Channel count the peer declared. Always 1 on
                both telephony paths, but carried explicitly rather than
                assumed.
            auto_hang_up: Emit a `hangup` control message on EndFrame/CancelFrame
                so the PHP side discards the call instead of leaving it ringing.
            metrics_interval_secs: How often to emit a `metrics` control frame.
                Zero disables it.
        """

        bridge_sample_rate: int = 16000
        bridge_channels: int = 1
        auto_hang_up: bool = True
        metrics_interval_secs: float = 15.0

    def __init__(
        self,
        session_id: str,
        params: InputParams | None = None,
    ) -> None:
        params = params or TelegramFrameSerializer.InputParams()
        super().__init__(params)
        self._params: TelegramFrameSerializer.InputParams = params
        self._session_id = session_id

        self._bridge_rate = params.bridge_sample_rate
        self._bridge_channels = params.bridge_channels
        self._pipeline_rate = params.bridge_sample_rate  # replaced in setup()

        # One resampler per (in_rate, out_rate) pair, per direction. Sharing
        # a single instance across two different conversions would feed each
        # the other's filter state and produce audible artefacts.
        self._in_resamplers: dict[tuple[int, int], PCM16Resampler] = {}
        self._out_resamplers: dict[tuple[int, int], PCM16Resampler] = {}

        self._in_sequence = SequenceTracker()
        self._out_sequence = 0
        self._started_at = time.monotonic()
        self._last_metrics_at = self._started_at
        self._hangup_sent = False
        #: Caller-initiated interruptions (inbound). Counted once per event.
        self.barge_in_count = 0
        #: InterruptionFrames emitted outbound, i.e. the TTS/LLM turn actually
        #: being torn down. Deliberately a separate counter from barge_in_count:
        #: one caller interruption produces one inbound signal and one (or
        #: more) outbound cancellations, and collapsing them into a single
        #: number would double-count every barge-in and make the metric
        #: useless for spotting a pipeline that cancels more than it is asked to.
        self.cancelled_frames = 0
        self._assistant_speaking = False

    # -- lifecycle -------------------------------------------------------

    async def setup(self, setup: FrameProcessorSetup) -> None:
        """Adopt the pipeline's negotiated sample rate."""
        self._pipeline_rate = setup.audio_in_sample_rate
        if self._pipeline_rate != self._bridge_rate:
            logger.info(
                "ACAF bridge resampling active",
                extra={
                    "sessionId": self._session_id,
                    "bridgeRate": self._bridge_rate,
                    "pipelineRate": self._pipeline_rate,
                },
            )

    # -- inbound: carrier bytes -> Pipecat frames -------------------------

    async def deserialize(self, data: str | bytes) -> Frame | None:
        """Parse one WebSocket message into a Pipecat frame, or None."""
        if isinstance(data, str):
            return self._deserialize_control(data)
        return await self._deserialize_audio(data)

    def _deserialize_control(self, data: str) -> Frame | None:
        try:
            body = json.loads(data)
        except (TypeError, ValueError):
            logger.warning(
                "ACAF control message was not valid JSON",
                extra={"sessionId": self._session_id, "bytes": len(data)},
            )
            return None

        try:
            message = ControlMessage.from_dict(body)
        except ProtocolError as exc:
            logger.warning(
                f"ACAF control message rejected: {exc}",
                extra={"sessionId": self._session_id},
            )
            return None

        # Never log the raw body: `hello` carries the bridge secret.
        logger.debug(
            "ACAF control received",
            extra={"sessionId": self._session_id, "type": message.type},
        )

        if message.type == CONTROL_INTERRUPT:
            self.barge_in_count += 1
            # Surfacing this as an InterruptionFrame is what tells Pipecat to
            # stop the LLM/TTS turn in flight. Without it, barge-in would be
            # recorded and ignored.
            return InterruptionFrame()

        if message.type == CONTROL_HANGUP:
            return EndFrame()

        # `ping`/`ready`/unknown types are transport-level and produce no
        # pipeline frame. Returning None is correct, not a dropped message:
        # the transport's own heartbeat handling deals with them.
        return None

    async def _deserialize_audio(self, data: bytes) -> Frame | None:
        try:
            frame = AudioFrame.decode(data)
        except ProtocolError as exc:
            # A malformed frame must not kill the call. Count it and move on;
            # a persistent rate of these shows up in the metrics control frame.
            logger.warning(
                f"ACAF frame rejected: {exc}",
                extra={"sessionId": self._session_id, "bytes": len(data)},
            )
            return None

        skipped = self._in_sequence.observe(frame.sequence)
        if skipped:
            # Audio is not retransmittable -- by the time a gap is noticed the
            # audio in it is stale. Record it for metrics and continue.
            logger.debug(
                "ACAF inbound frame gap",
                extra={
                    "sessionId": self._session_id,
                    "skipped": skipped,
                    "seq": frame.sequence,
                },
            )

        if frame.type is FrameType.INTERRUPT:
            self.barge_in_count += 1
            return InterruptionFrame()

        if frame.type is not FrameType.AUDIO_IN:
            return None

        pcm = await self._to_pcm(frame)
        if not pcm:
            return None

        return InputAudioRawFrame(
            audio=pcm,
            sample_rate=self._pipeline_rate,
            num_channels=frame.channels,
        )

    async def _to_pcm(self, frame: AudioFrame) -> bytes:
        """Convert an inbound frame's payload to pipeline-rate PCM16.

        Opus is deliberately not handled here. Pipecat 1.11 ships no Opus
        decoder (verified: `pipecat/audio/utils.py` exposes only mu-law,
        A-law and WAV helpers), so a peer that wants to send Opus must decode
        it itself -- which is the correct division anyway, since decoding
        Telegram's codec is Telegram-specific work and belongs on the PHP side
        of the bridge.
        """
        payload = frame.payload
        if frame.encoding is Encoding.OGG_OPUS:
            logger.error(
                "ACAF received Opus frames but this build has no Opus decoder; "
                "configure the bridge to send pcm_s16le instead",
                extra={"sessionId": self._session_id},
            )
            return b""

        if frame.encoding is Encoding.MULAW:
            payload = mulaw_to_pcm16(payload)
        elif frame.encoding is not Encoding.PCM_S16LE:
            return b""  # pragma: no cover - Encoding is exhaustive above

        # Normalise to the bridge rate, then to the pipeline rate. The two
        # steps are distinct because a peer may declare a rate that differs
        # from both (e.g. Telegram's 48 kHz into an 8 kHz bridge feeding a
        # 16 kHz pipeline).
        if frame.sample_rate != self._bridge_rate:
            payload = self._resample(
                payload, frame.sample_rate, self._bridge_rate, direction="in"
            )
        if self._bridge_rate != self._pipeline_rate:
            payload = self._resample(
                payload, self._bridge_rate, self._pipeline_rate, direction="in"
            )
        return payload

    # -- outbound: Pipecat frames -> carrier bytes ------------------------

    async def serialize(self, frame: Frame) -> str | bytes | None:
        """Convert a Pipecat frame to an ACAF message, or None."""
        if isinstance(frame, InterruptionFrame):
            # Barge-in. The bridge must clear its playout queue on this.
            self.cancelled_frames += 1
            return json.dumps(ControlMessage(CONTROL_INTERRUPT, self._session_id).to_dict())

        if isinstance(frame, (EndFrame, CancelFrame)) and self._params.auto_hang_up:
            if not self._hangup_sent:
                self._hangup_sent = True
                return json.dumps(ControlMessage(CONTROL_HANGUP, self._session_id).to_dict())
            return None

        if isinstance(frame, AudioRawFrame):
            return await self._serialize_audio(frame)

        if isinstance(frame, (OutputTransportMessageFrame, OutputTransportMessageUrgentFrame)):
            if self.should_ignore_frame(frame):
                return None
            # Only pass through messages that are already control-shaped; a
            # transport message carrying arbitrary content would let pipeline
            # code write whatever it liked onto the bridge.
            if isinstance(frame.message, dict) and isinstance(frame.message.get("type"), str):
                return json.dumps(frame.message)
            return None

        return None

    async def _serialize_audio(self, frame: AudioRawFrame) -> bytes | None:
        pcm = frame.audio
        if not pcm:
            return None

        if frame.sample_rate != self._bridge_rate:
            pcm = self._resample(
                pcm, frame.sample_rate, self._bridge_rate, direction="out"
            )
        if not pcm:
            return None

        wire = AudioFrame.audio_out(
            pcm,
            sequence=self._out_sequence,
            timestamp_ms=int(time.monotonic() * 1000),
            sample_rate=self._bridge_rate,
            channels=self._bridge_channels,
            encoding=Encoding.PCM_S16LE,
        )
        self._out_sequence = (self._out_sequence + 1) & 0xFFFFFFFF
        self._assistant_speaking = True
        return wire.encode()

    def _resample(
        self, pcm: bytes, in_rate: int, out_rate: int, *, direction: str
    ) -> bytes:
        """Resample PCM16 between two rates, deterministically and per frame.

        Always emits a proportional amount of output for the input it is
        given, which is what keeps the frame cadence steady on both carriers.
        See the module docstring for why Pipecat's soxr resampler is not used
        here. The resampler is cached per rate pair so its filter state
        carries across frames -- a fresh instance per frame would inject a
        discontinuity every 20 ms.
        """
        if in_rate == out_rate or not pcm:
            return pcm
        cache = self._in_resamplers if direction == "in" else self._out_resamplers
        key = (in_rate, out_rate)
        resampler = cache.get(key)
        if resampler is None:
            resampler = PCM16Resampler(in_rate, out_rate)
            cache[key] = resampler
        return resampler.process(pcm)

    # -- metrics ---------------------------------------------------------

    def maybe_metrics(self) -> str | None:
        """Emit a periodic metrics control message, or None if not due.

        Called by the transport's heartbeat loop rather than from
        `serialize`, so metrics cadence is wall-clock based and does not
        depend on audio flowing -- a silent call is exactly when you most
        want to see the counters.
        """
        interval = self._params.metrics_interval_secs
        if interval <= 0:
            return None
        now = time.monotonic()
        if (now - self._last_metrics_at) < interval:
            return None
        self._last_metrics_at = now
        message = ControlMessage(
            CONTROL_METRICS,
            self._session_id,
            extra={
                "uptimeSecs": round(now - self._started_at, 1),
                "inbound": self._in_sequence.as_metrics(),
                "outboundFramesSent": self._out_sequence,
                "bargeIns": self.barge_in_count,
                "ttsFramesCancelled": self.cancelled_frames,
            },
        )
        return json.dumps(message.to_dict())

    def stats(self) -> dict[str, Any]:
        return {
            "bridgeSampleRate": self._bridge_rate,
            "pipelineSampleRate": self._pipeline_rate,
            "bridgeChannels": self._bridge_channels,
            "inbound": self._in_sequence.as_metrics(),
            "outboundFramesSent": self._out_sequence,
            "bargeIns": self.barge_in_count,
            "ttsFramesCancelled": self.cancelled_frames,
            "hangupSent": self._hangup_sent,
        }

    def note_assistant_stopped_speaking(self) -> None:
        self._assistant_speaking = False

    @property
    def assistant_speaking(self) -> bool:
        return self._assistant_speaking
