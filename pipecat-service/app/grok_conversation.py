"""A call on the Grok speech-to-speech agent, with the app's own instructions and the chosen voice.

Used when the user has chosen the Agent voice (table user_agents, active = true). Same
instructions GPT-Live gets (one brain). Caller audio goes up as it arrives; agent audio is
paced back; an interruption drops queued agent audio; transcripts go to the call record.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from app.call_context import _Rest
from app.config import Settings
from app.conversation import PacedAudioSender
from app.call_wrapup import is_hard_cue
from app.emotion import should_end_call
from app.grok_realtime import END_CALL_TOOL, GrokRealtimeClient, build_session_update
from app.inworld_realtime import InworldRealtimeClient, build_inworld_session
from app.monitor import DIRECTION_CALLER, DIRECTION_EMYSA, get_hub
from app.own_brain import HANGUP_RULES as BRAIN_HANGUP_RULES

logger = logging.getLogger("emysa.agent")

_KEY_CACHE: dict[str, Any] = {"value": None, "at": 0.0}
_KEY_TTL_SECS = 60.0
# The agent provider can refuse every reply (a model the account may not use, no credits). Such a
# call hears the first line and then nothing, while the provider keeps billing for listening. After
# this many failed replies in a row, with no speech between them, the call ends and says why.
MAX_CONSECUTIVE_AGENT_ERRORS = 3
# With our own brain: how long to wait for the line being spoken to finish before sending the next one.
SPEAK_DONE_TIMEOUT_SECS = 12.0
# An error right after we cancelled speech is the provider answering the cancel, not a failed reply.
CANCEL_ERROR_GRACE_SECS = 1.5
# Grok hangs up by calling end_call: after the model's goodbye (the response that follows the call)
# has finished. If that never completes, the call still ends after this long.
END_CALL_RESPONSE_TIMEOUT_SECS = 8.0
# Said once if the brain fails to write a reply, so the caller is not left in silence.
BRAIN_FALLBACK_LINE = "Sorry, I lost my train of thought. Could you say that again?"


@dataclass(frozen=True)
class AgentLink:
    voice_id: str | None
    provider: str  # 'grok' (Live presets) or 'inworld' (Custom clones)


async def fetch_agent_link(settings: Settings, user_id: str | None, session_id: str) -> AgentLink | None:
    """The user's Custom (Grok) choice, or None when they use a Standard voice. A failed read raises."""
    url = getattr(settings, "supabase_url", None)
    service_key = getattr(settings, "supabase_service_role_key", None)
    if getattr(settings, "mock_mode", False) or not user_id or not url or not service_key:
        return None
    rest = _Rest(url, service_key, timeout_secs=4.0)
    try:
        filters = {"user_id": f"eq.{user_id}", "active": "eq.true"}
        try:
            rows = await rest.select("user_agents", select="voice_id,active,provider", filters=filters, limit=1)
        except Exception as exc:  # noqa: BLE001
            # This lookup runs on EVERY call. If the provider column has not been added to the
            # database yet (HTTP 400, "column ... does not exist"), a missing column must not
            # stop every call from connecting: read without it. Before the column exists the only
            # agent is Grok, so that is what such a row means. Any other failure still raises.
            if "HTTP 400" not in str(exc) or "provider" not in str(exc):
                raise
            logger.warning("user_agents.provider column missing; reading without it session=%s", session_id)
            rows = await rest.select("user_agents", select="voice_id,active", filters=filters, limit=1)
    except Exception as exc:  # noqa: BLE001 - the Custom voice must not silently become GPT-Live
        logger.error("agent lookup failed session=%s error=%s; call not connected", session_id, type(exc).__name__)
        raise RuntimeError("the Custom voice could not be checked; call not connected") from None
    finally:
        await rest.aclose()
    if not rows:
        return None
    provider = "inworld" if rows[0].get("provider") == "inworld" else "grok"
    return AgentLink(voice_id=str(rows[0]["voice_id"]) if rows[0].get("voice_id") else None, provider=provider)


async def resolve_xai_key(settings: Settings) -> str | None:
    """The xAI key: the one saved in admin (app_secrets) first, then the server setting. Cached a minute."""
    now = time.monotonic()
    if _KEY_CACHE["value"] and now - _KEY_CACHE["at"] < _KEY_TTL_SECS:
        return _KEY_CACHE["value"]
    saved = None
    url = getattr(settings, "supabase_url", None)
    service_key = getattr(settings, "supabase_service_role_key", None)
    if not getattr(settings, "mock_mode", False) and url and service_key:
        rest = _Rest(url, service_key, timeout_secs=4.0)
        try:
            rows = await rest.select("app_secrets", select="value", filters={"name": "eq.XAI_API_KEY"}, limit=1)
            if rows and rows[0].get("value"):
                saved = str(rows[0]["value"]).strip()
        except Exception:  # noqa: BLE001 - fall back to the server setting
            saved = None
        finally:
            await rest.aclose()
    value = saved or getattr(settings, "xai_api_key", None) or None
    _KEY_CACHE.update(value=value, at=now)
    return value


async def resolve_inworld_key(settings: Settings) -> str | None:
    """The Inworld key: saved in admin (app_secrets) first, then the server setting. Cached a minute."""
    cache = _INWORLD_KEY_CACHE
    now = time.monotonic()
    if cache["value"] and now - cache["at"] < _KEY_TTL_SECS:
        return cache["value"]
    saved = None
    url = getattr(settings, "supabase_url", None)
    service_key = getattr(settings, "supabase_service_role_key", None)
    if not getattr(settings, "mock_mode", False) and url and service_key:
        rest = _Rest(url, service_key, timeout_secs=4.0)
        try:
            rows = await rest.select("app_secrets", select="value", filters={"name": "eq.INWORLD_API_KEY"}, limit=1)
            if rows and rows[0].get("value"):
                saved = str(rows[0]["value"]).strip()
        except Exception:  # noqa: BLE001 - fall back to the server setting
            saved = None
        finally:
            await rest.aclose()
    value = saved or getattr(settings, "inworld_api_key", None) or None
    cache.update(value=value, at=now)
    return value


_INWORLD_KEY_CACHE: dict[str, Any] = {"value": None, "at": 0.0}


class GrokAgentConversation:
    """One call on the Grok agent. Same shape as the other conversations the bridge drives."""

    def __init__(
        self,
        *,
        settings: Settings,
        session_id: str,
        serializer: Any,
        send_audio: Callable[[bytes], Awaitable[None]],
        send_control: Callable[[str], Awaitable[None]],
        on_ended: Callable[[str], Awaitable[None]] | None,
        prompt: str,
        greeting: str | None,
        voice_id: str | None,
        transcript: Any = None,
        provider: str = "grok",
        brain: Any = None,
        on_end_call: Callable[[], None] | None = None,
    ) -> None:
        self._settings = settings
        self._provider = provider
        self._session_id = session_id
        self._on_ended = on_ended
        self._transcript = transcript
        self._greeting = greeting
        # Our own model writes the replies when one is given (Inworld only hears, takes turns and speaks).
        self._brain = brain if provider == "inworld" else None
        self._prompt = prompt
        # Hanging up: the call conversation passes this in; it ends the call once the goodbye has played.
        self._on_end_call = on_end_call
        self._hangup_requested = False
        self._last_user_text = ""
        self._cues: list[str] = []          # wrap-up cues for Luna's next reply (time budget)
        self._cue_task: asyncio.Task[None] | None = None
        self._ending_after_done = False     # Grok called end_call: hang up when its goodbye is done
        self._end_skip_dones = 0            # response.done events to let pass first (the one that carried the call)
        self._spoke_this_response = False   # the response in progress has produced audio (a goodbye)
        self._end_timer: asyncio.Task[None] | None = None
        if provider == "inworld":
            model = getattr(settings, "inworld_model", None)
            extra = {"model": model} if model else {}
            self._session_update = build_inworld_session(
                instructions=prompt, voice_id=voice_id, rate=settings.bridge_sample_rate,
                own_llm=self._brain is not None, **extra,
            )
        else:
            self._session_update = build_session_update(
                instructions=prompt, voice_id=voice_id, rate=settings.bridge_sample_rate,
                end_call_tool=on_end_call is not None,
            )
        self._client: GrokRealtimeClient | None = None
        self._task: asyncio.Task[None] | None = None
        self._stopped = False
        self._warned_rate = False
        # Reply timing: from the moment the caller stops talking to the first agent audio.
        self._turn_ended_at: float | None = None
        self._opened_at: float | None = None
        self._greeting_timed = False
        self._latencies_ms: list[int] = []
        self._errors_in_row = 0
        # Own-brain state: what has been said, the reply being written/spoken, and what Inworld is still speaking.
        self._history: list[dict[str, str]] = []
        self._turn_task: asyncio.Task[None] | None = None
        self._inflight = 0          # lines sent to be spoken whose response.done has not arrived
        self._stale_dones = 0       # response.done events still owed by lines we cancelled
        self._idle = asyncio.Event()
        self._idle.set()
        self._drop_audio = False    # after a barge-in, audio of the cut-off line is not played
        self._cancel_sent_at: float | None = None
        self._brain_failures = 0
        self.call_active = False
        self.sender = PacedAudioSender(
            session_id=session_id,
            serializer=serializer,
            send_audio=send_audio,
            send_control=send_control,
            on_chunk=lambda pcm, rate, channels: get_hub().publish(session_id, DIRECTION_EMYSA, rate, pcm),
        )

    async def start(self) -> None:
        if self._provider == "inworld":
            key = await resolve_inworld_key(self._settings)
            if not key:
                raise RuntimeError("the Inworld key is not set")
            self._client = InworldRealtimeClient(api_key=key, session_update=self._session_update)
        else:
            key = await resolve_xai_key(self._settings)
            if not key:
                raise RuntimeError("the xAI key is not set")
            self._client = GrokRealtimeClient(api_key=key, session_update=self._session_update)
        await self._client.start()
        self._opened_at = time.monotonic()
        self.sender.start()
        if self._brain is not None:
            logger.info("agent brain=own model=%s session=%s", getattr(self._brain, "model", "?"), self._session_id)
        if self._greeting:
            if self._brain is not None:
                self._history.append({"role": "assistant", "content": self._greeting})
                await self._speak(self._greeting)
            else:
                await self._client.send_greeting(self._greeting)
        self._task = asyncio.create_task(self._pump(), name=f"grok-events-{self._session_id}")

    async def push_audio(self, frame: Any) -> None:
        """Caller audio, sent as it arrives."""
        if self._client is None or self._stopped:
            return
        rate = getattr(frame, "sample_rate", None)
        if rate != self._settings.bridge_sample_rate:
            if not self._warned_rate:
                self._warned_rate = True
                logger.warning("agent needs %s Hz caller audio, got %s; dropping", self._settings.bridge_sample_rate, rate)
            return
        get_hub().publish(self._session_id, DIRECTION_CALLER, rate, frame.audio)
        await self._client.send_caller_audio(frame.audio)

    async def note_call_active(self, source: str) -> bool:
        self.call_active = True
        return True

    async def _pump(self) -> None:
        """Agent events in, agent audio out. Ends when the agent side closes, or gives up on it."""
        ended_reason = "agent-ended"
        try:
            assert self._client is not None
            async for event in self._client.events():
                if event.kind == "user_transcript" and event.text:
                    self._last_user_text = event.text
                if event.kind == "audio":
                    if self._drop_audio:
                        continue  # the tail of a line the caller cut off
                    self._errors_in_row = 0
                    self._spoke_this_response = True
                    self._note_first_audio()
                    await self.sender.enqueue(event.audio, self._settings.bridge_sample_rate)
                elif event.kind == "interrupted":
                    await self.sender.interrupt()
                    if self._ending_after_done:
                        # The caller spoke over the goodbye ("bye... oh, one more thing"): never hang up on them.
                        self._ending_after_done = False
                        logger.info("agent hangup cancelled, caller spoke session=%s", self._session_id)
                    if self._brain is not None:
                        await self._barge_in()
                elif event.kind == "function_call":
                    await self._on_function_call(event)
                elif event.kind == "response_done":
                    self._line_done()
                    logger.info("agent event type=response.done session=%s", self._session_id)
                elif event.kind == "user_transcript" and event.text and self._transcript is not None:
                    self._transcript.note("contact", event.text)
                    if self._brain is not None:
                        await self._start_turn(event.text)
                elif event.kind == "user_transcript" and event.text and self._brain is not None:
                    await self._start_turn(event.text)
                elif event.kind == "agent_transcript" and event.text and self._transcript is not None and self._brain is None:
                    # With our own brain the spoken lines are noted as they are sent (see _speak).
                    self._transcript.note("ai", event.text)
                elif event.kind == "error":
                    if self._cancel_sent_at is not None and time.monotonic() - self._cancel_sent_at < CANCEL_ERROR_GRACE_SECS:
                        logger.info("agent error right after cancel, not counted session=%s message=%s", self._session_id, event.text)
                        continue
                    self._errors_in_row += 1
                    logger.warning("agent error session=%s message=%s", self._session_id, event.text)
                    if self._errors_in_row >= MAX_CONSECUTIVE_AGENT_ERRORS:
                        logger.error(
                            "agent gave up session=%s after %d failed replies in a row; ending the call. Last error: %s",
                            self._session_id, self._errors_in_row, event.text,
                        )
                        ended_reason = "agent-error"
                        break
                elif event.kind == "other":
                    if event.raw_type == "response.created":
                        self._spoke_this_response = False
                    elif event.raw_type == "response.done":
                        if self._ending_after_done:
                            if self._end_skip_dones > 0:
                                self._end_skip_dones -= 1   # the response that carried the call; the goodbye follows
                            else:
                                self._ending_after_done = False
                                self._request_hangup("assistant-ended-call")
                        self._spoke_this_response = False
                    if event.raw_type == "input_audio_buffer.speech_stopped":
                        self._turn_ended_at = time.monotonic()
                    logger.info("agent event type=%s session=%s", event.raw_type or "-", self._session_id)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - reported; the call is then hung up
            logger.warning("agent event loop ended session=%s error=%s", self._session_id, type(exc).__name__)
        finally:
            if not self._stopped and self._on_ended is not None:
                await self._on_ended(ended_reason)

    # -- own brain ---------------------------------------------------------------------------

    async def _speak(self, text: str) -> None:
        """Send one line to be spoken. Lines go one at a time: the next waits for this one's response.done."""
        assert self._client is not None
        self._drop_audio = False
        self._inflight += 1
        self._idle.clear()
        if self._brain is not None and self._transcript is not None:
            self._transcript.note("ai", text)  # lets the goodbye detector see what Emysa said
        await self._client.send_speak(text)

    def _line_done(self) -> None:
        if self._stale_dones > 0:
            self._stale_dones -= 1  # the end of a line we cancelled
        else:
            self._inflight = max(0, self._inflight - 1)
        if self._inflight == 0:
            self._idle.set()

    async def _wait_idle(self) -> None:
        try:
            await asyncio.wait_for(self._idle.wait(), SPEAK_DONE_TIMEOUT_SECS)
        except asyncio.TimeoutError:
            logger.warning("agent line never finished; sending the next anyway session=%s", self._session_id)
            self._inflight = 0
            self._stale_dones = 0
            self._idle.set()

    async def _cancel_turn(self) -> None:
        task, self._turn_task = self._turn_task, None
        if task is None or task.done() or task is asyncio.current_task():
            return  # a turn that is ending the call is already finishing: never cancel it from inside
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001 - its own errors were handled in the task
            pass

    async def _barge_in(self) -> None:
        """The caller started talking: stop writing the reply, stop what is being spoken."""
        self._drop_audio = True
        await self._cancel_turn()
        if self._inflight > 0 and self._client is not None:
            self._stale_dones += self._inflight
            self._inflight = 0
            self._idle.set()
            self._cancel_sent_at = time.monotonic()
            try:
                await self._client.send_cancel()
            except Exception:  # noqa: BLE001 - the socket may be closing
                pass

    async def _start_turn(self, text: str) -> None:
        """The caller finished a turn: Luna writes the reply."""
        await self._cancel_turn()  # the previous reply (and its partial history) is settled first
        if self._turn_ended_at is not None:
            logger.info("agent stt ms=%d session=%s", int((time.monotonic() - self._turn_ended_at) * 1000), self._session_id)
        self._last_user_text = text
        self._history.append({"role": "user", "content": text})
        self._turn_task = asyncio.create_task(self._run_turn(), name=f"agent-brain-{self._session_id}")

    def _brain_prompt(self, cues: list[str]) -> str:
        """The instructions Luna gets: the app's, how to hang up, and any time-budget cue for this reply."""
        parts = [self._prompt, BRAIN_HANGUP_RULES, *cues]
        return "\n\n".join(parts)

    async def _run_turn(self) -> None:
        started = time.monotonic()
        queue: asyncio.Queue[str | None] = asyncio.Queue()
        spoken: list[str] = []
        cues, self._cues = self._cues, []
        prompt = self._brain_prompt(cues)
        end_requested = False

        async def produce() -> None:
            try:
                first = True
                async for sentence in self._brain.stream_sentences(prompt, list(self._history)):
                    if first:
                        first = False
                        logger.info("agent brain first_sentence_ms=%d session=%s", int((time.monotonic() - started) * 1000), self._session_id)
                    await queue.put(sentence)
            finally:
                await queue.put(None)

        producer = asyncio.create_task(produce())
        failed = False
        try:
            while True:
                sentence = await queue.get()
                if sentence is None:
                    break
                # Luna hangs up with [[END_CALL]] at the end of her goodbye. It is never spoken. The same
                # guard as the classic engine applies: not while the caller is still asking or talking.
                end, sentence = should_end_call(sentence, self._last_user_text)
                if end:
                    end_requested = True
                if not sentence:
                    continue
                await self._wait_idle()
                await self._speak(sentence)
                spoken.append(sentence)
            await producer  # surfaces a failure of the model call
            self._brain_failures = 0
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - reported; after repeated failures the call ends
            failed = True
            self._brain_failures += 1
            logger.warning("agent brain failed session=%s count=%d error=%s: %s", self._session_id,
                           self._brain_failures, type(exc).__name__, str(exc)[:200])
        finally:
            producer.cancel()
            if spoken:
                self._history.append({"role": "assistant", "content": " ".join(spoken)})
        if end_requested and not failed:
            await self._wait_idle()  # the goodbye has been spoken in full
            self._request_hangup("assistant-ended-call")
            return
        if failed:
            if self._brain_failures >= MAX_CONSECUTIVE_AGENT_ERRORS:
                logger.error("agent gave up session=%s after %d failed replies in a row; ending the call", self._session_id, self._brain_failures)
                if not self._stopped and self._on_ended is not None:
                    await self._on_ended("agent-error")
            elif not spoken:
                await self._wait_idle()
                await self._speak(BRAIN_FALLBACK_LINE)

    # -- hanging up --------------------------------------------------------------------------

    def _request_hangup(self, reason: str) -> None:
        """Ask the call to end. It waits for the goodbye audio to play out before hanging up."""
        if self._hangup_requested or self._stopped:
            return
        self._hangup_requested = True
        logger.info("agent requested hangup session=%s reason=%s", self._session_id, reason)
        if self._on_end_call is not None:
            self._on_end_call()

    def is_speaking(self) -> bool:
        """True while a line is still being spoken or its audio is still being played to the caller."""
        return self._inflight > 0 or bool(getattr(self.sender, "speaking", False))

    async def _on_function_call(self, event: Any) -> None:
        """Grok called a function. The only one it has is end_call (hang up)."""
        if self._client is None or not event.call_id:
            return
        if event.text != END_CALL_TOOL:
            logger.warning("agent called an unknown function session=%s name=%s", self._session_id, event.text)
            await self._client.send_function_result(event.call_id, {"ok": False, "note": "Unknown action."})
            return
        end, _ = should_end_call("[[END_CALL]]", self._last_user_text)
        if not end:
            # The same guard as the other engines: the person is still asking or talking.
            logger.info("agent end_call ignored, caller is still talking session=%s", self._session_id)
            await self._client.send_function_result(
                event.call_id, {"ok": False, "note": "The person is still talking. Do not hang up; carry on."},
            )
            await self._client.send_response_create()
            return
        logger.info("agent called end_call session=%s", self._session_id)
        # The model is told to say goodbye first, then call end_call: in that case its goodbye is already
        # in this response and the call ends when it is done. A silent call gets a goodbye asked for.
        said_goodbye = self._spoke_this_response
        self._ending_after_done = True
        self._end_skip_dones = 0 if said_goodbye else 1
        await self._client.send_function_result(
            event.call_id, {"ok": True, "note": "The call is ending. If you have not already, say a brief goodbye."},
        )
        if not said_goodbye:
            await self._client.send_response_create()
        if self._end_timer is not None:
            self._end_timer.cancel()
        self._end_timer = asyncio.create_task(self._end_call_timeout(), name=f"agent-end-{self._session_id}")

    async def _end_call_timeout(self) -> None:
        await asyncio.sleep(END_CALL_RESPONSE_TIMEOUT_SECS)
        if self._ending_after_done:
            self._ending_after_done = False
            self._request_hangup("assistant-ended-call")

    async def inject_cue(self, text: str) -> None:
        """A wrap-up cue from the time budget. Luna sees it in her next reply; "time is up" starts that reply now."""
        if self._stopped:
            return
        if self._brain is None:
            # Grok writes its own replies and has no way to be told mid-call. The budget's final
            # force-hangup still ends the call; goodbyes and end_call end it earlier.
            logger.info("agent wrap-up cue not delivered (no own brain) session=%s", self._session_id)
            return
        self._cues.append(text)
        if is_hard_cue(text):
            if self._cue_task is not None:
                self._cue_task.cancel()
            self._cue_task = asyncio.create_task(self._run_cue_turn(), name=f"agent-cue-{self._session_id}")

    async def _run_cue_turn(self) -> None:
        prev = self._turn_task
        if prev is not None and not prev.done():
            await asyncio.wait({prev})  # let the reply being spoken finish; never cut it off
        if self._stopped or self._hangup_requested or not self._cues:
            return
        await self._wait_idle()
        if self._turn_task is not None and not self._turn_task.done():
            return  # the caller spoke meanwhile; that reply carries the cue
        self._turn_task = asyncio.create_task(self._run_turn(), name=f"agent-brain-{self._session_id}")

    def _note_first_audio(self) -> None:
        """Log how long the agent took: the opening line after connect, and each reply after the caller stopped."""
        now = time.monotonic()
        if self._turn_ended_at is not None:
            ms = int((now - self._turn_ended_at) * 1000)
            self._turn_ended_at = None
            self._latencies_ms.append(ms)
            logger.info("agent latency ms=%d kind=reply session=%s", ms, self._session_id)
        elif not self._greeting_timed and self._opened_at is not None:
            self._greeting_timed = True
            logger.info("agent latency ms=%d kind=greeting session=%s", int((now - self._opened_at) * 1000), self._session_id)

    async def stop(self, reason: str = "stopped") -> None:
        self._stopped = True
        for helper in (self._end_timer, self._cue_task):
            if helper is not None and helper is not asyncio.current_task():
                helper.cancel()
        await self._cancel_turn()
        task = self._task
        if task is not None and task is not asyncio.current_task():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        elif task is not None:
            task.cancel()
        if self._client is not None:
            try:
                await self._client.close()
            except Exception:  # noqa: BLE001 - closing a dead socket is not an error
                pass
        await self.sender.stop()
        get_hub().close_room(self._session_id)
        logger.info("agent conversation stopped session=%s reason=%s", self._session_id, reason)

    def stats(self) -> dict[str, Any]:
        out: dict[str, Any] = {"engine": "agent", **self.sender.stats()}
        if self._latencies_ms:
            out["replyLatencyMsLast"] = self._latencies_ms[-1]
            out["replyLatencyMsAvg"] = int(sum(self._latencies_ms) / len(self._latencies_ms))
            out["replies"] = len(self._latencies_ms)
        return out
