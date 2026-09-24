"""Structured logging that cannot leak audio or credentials.

The brief's requirement is *"structured logging without logging audio or
secrets"*. Redaction is implemented as a logging **filter** rather than as a
convention that callers are trusted to follow, because a convention is exactly
the thing that gets violated under pressure at 2am when someone adds a debug
line to chase a bug in production.

Two independent guarantees:

  1. `RedactionFilter` rewrites every formatted message, replacing any known
     secret value with a fixed marker. That is the *secrets* half.
  2. `log_audio()` is the only sanctioned way to log anything about audio, and
     it accepts a payload solely to compute its length and level -- the bytes
     never enter the record. That is the *audio* half.

There is no switch that turns either off. If you genuinely need to see audio
content you are debugging a codec bug, and the right tool for that is a local
run against a saved file, not a production log stream.
"""

from __future__ import annotations

import json
import logging
import sys
from typing import Any, Iterable, Mapping

REDACTED = "<redacted>"

#: Field names whose values are dropped outright regardless of content. These
#: are the names upstream libraries use for bearer tokens and payloads.
SENSITIVE_FIELD_NAMES = frozenset(
    {
        "api_key",
        "apikey",
        "authorization",
        "auth",
        "token",
        "access_token",
        "refresh_token",
        "secret",
        "password",
        "session_encrypted",
        "auth_state_encrypted",
        "payload",
        "audio",
        "audio_bytes",
        "pcm",
    }
)


def redact(text: str, secrets: Iterable[str]) -> str:
    """Replace every occurrence of every known secret in `text`."""
    if not text:
        return text
    for secret in secrets:
        if secret and secret in text:
            text = text.replace(secret, REDACTED)
    return text


def scrub_mapping(data: Mapping[str, Any], secrets: Iterable[str]) -> dict[str, Any]:
    """Recursively drop sensitive keys and redact secret values in a mapping."""
    secrets = tuple(secrets)
    out: dict[str, Any] = {}
    for key, value in data.items():
        if key.lower() in SENSITIVE_FIELD_NAMES:
            out[key] = REDACTED
            continue
        if isinstance(value, Mapping):
            out[key] = scrub_mapping(value, secrets)
        elif isinstance(value, str):
            out[key] = redact(value, secrets)
        elif isinstance(value, (list, tuple)):
            out[key] = [
                scrub_mapping(v, secrets)
                if isinstance(v, Mapping)
                else redact(v, secrets)
                if isinstance(v, str)
                else v
                for v in value
            ]
        else:
            out[key] = value
    return out


class RedactionFilter(logging.Filter):
    """Scrubs secrets from every log record before it is emitted."""

    def __init__(self, secrets: Iterable[str] = ()) -> None:
        super().__init__()
        self._secrets = tuple(s for s in secrets if s)

    def set_secrets(self, secrets: Iterable[str]) -> None:
        self._secrets = tuple(s for s in secrets if s)

    def filter(self, record: logging.LogRecord) -> bool:
        # Formatting here (rather than only in the formatter) is deliberate:
        # it means the scrubbed text is what any handler sees, including ones
        # added later by a dependency.
        try:
            rendered = record.getMessage()
        except Exception:  # pragma: no cover - defensive
            return True
        if self._secrets:
            scrubbed = redact(rendered, self._secrets)
            if scrubbed != rendered:
                record.msg = scrubbed
                record.args = ()

        # Exception text can carry a URL with a query-string token in it
        # (`https://api.fish.audio/v1/tts?key=...`), so it needs the same
        # treatment as the message.
        #
        # Setting `record.exc_text` alone is not enough: `exc_text` is a cache
        # that `Formatter.format` fills in, but a caller that formats
        # `record.exc_info` itself (a log drain, a test, another handler) reads
        # the live exception instead and would see the raw secret. The
        # exception object's own `args` are therefore rewritten too, which is
        # what `str(exc)` -- and so any formatter -- ultimately reads.
        if record.exc_info and record.exc_info[0] is not None and self._secrets:
            exc_value = record.exc_info[1]
            if exc_value is not None:
                original = str(exc_value)
                scrubbed = redact(original, self._secrets)
                if scrubbed != original:
                    try:
                        # Keep the original type so `except` clauses and trace
                        # rendering still behave; only the payload changes.
                        exc_value.args = (scrubbed,)
                    except Exception:  # pragma: no cover - exotic exception types
                        pass
                    # Invalidate the cache so the formatter recomputes from
                    # the now-scrubbed exception rather than replaying the
                    # original text.
                    record.exc_text = None
        return True


class JsonFormatter(logging.Formatter):
    """One JSON object per line.

    Render (and any log drain) indexes JSON far better than it does a
    printf-formatted line, and structured fields are what make it possible to
    answer "how many calls lost frames today" without a regex.
    """

    def format(self, record: logging.LogRecord) -> str:
        body: dict[str, Any] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        # Anything passed via `extra=` lands on the record; carry the
        # non-standard ones through as structured fields.
        for key, value in record.__dict__.items():
            if key in _STANDARD_RECORD_KEYS or key.startswith("_"):
                continue
            try:
                json.dumps(value)
                body[key] = value
            except (TypeError, ValueError):
                body[key] = repr(value)

        if record.exc_info:
            body["exc"] = self.formatException(record.exc_info)
        return json.dumps(body, ensure_ascii=False)


_STANDARD_RECORD_KEYS = frozenset(
    {
        "name", "msg", "args", "levelname", "levelno", "pathname", "filename",
        "module", "exc_info", "exc_text", "stack_info", "lineno", "funcName",
        "created", "msecs", "relativeCreated", "thread", "threadName",
        "processName", "process", "taskName", "message", "asctime",
    }
)


def configure_logging(
    *,
    level: str = "INFO",
    secrets: Iterable[str] = (),
    json_output: bool = True,
) -> RedactionFilter:
    """Install the root logging configuration and return the redaction filter.

    The filter instance is returned so it can be updated if secrets are
    loaded after logging is configured; keeping the same instance means the
    handler chain does not have to be rebuilt.
    """
    redaction = RedactionFilter(secrets)

    handler = logging.StreamHandler(sys.stdout)
    handler.addFilter(redaction)
    if json_output:
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s")
        )

    root = logging.getLogger()
    for existing in list(root.handlers):
        root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(getattr(logging, level.upper(), logging.INFO))

    # These libraries are chatty at INFO and their output is not useful for
    # call diagnostics; left at WARNING so a call's logs stay readable.
    for noisy in ("websockets", "urllib3", "httpx", "httpcore", "uvicorn.access"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    return redaction


# --------------------------------------------------------------------------
# The sanctioned way to log audio
# --------------------------------------------------------------------------


def log_audio(
    logger: logging.Logger,
    message: str,
    *,
    payload: bytes | None = None,
    sample_rate: int | None = None,
    channels: int | None = None,
    encoding: str | None = None,
    sequence: int | None = None,
    session_id: str | None = None,
    level: int = logging.DEBUG,
    **extra: Any,
) -> None:
    """Log *facts about* audio, never audio.

    `payload` is accepted so the caller has no reason to reach for
    `len(frame.payload)` inline and then be tempted to log the contents, but
    only its length and level survive into the record.

    The level (RMS) is the part that actually answers the questions you have
    during a live call: "is the caller's audio arriving but silent?", "is the
    assistant generating audio at all?", "is the frame the right size?".
    """
    fields: dict[str, Any] = {}
    if payload is not None:
        fields["bytes"] = len(payload)
    if sample_rate is not None:
        fields["sampleRate"] = sample_rate
    if channels is not None:
        fields["channels"] = channels
    if encoding is not None:
        fields["encoding"] = encoding
    if sequence is not None:
        fields["seq"] = sequence
    if session_id is not None:
        fields["sessionId"] = session_id
    if payload:
        # Imported lazily: this module is used by tests that must not pull in
        # the audio module's dependencies.
        from app.audio import pcm16_rms

        try:
            fields["level"] = round(pcm16_rms(payload), 5)
        except Exception:  # pragma: no cover - payload may not be PCM16
            fields["level"] = None
    fields.update(extra)
    logger.log(level, message, extra=fields)
