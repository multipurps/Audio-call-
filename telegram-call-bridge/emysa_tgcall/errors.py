"""Exception hierarchy for the Telegram private-call layer."""
from __future__ import annotations


class EmysaCallError(Exception):
    """Base class for every error raised by this package."""


class BusyError(EmysaCallError):
    """Another call is already active/being set up (one call at a time)."""


class SignalingError(EmysaCallError):
    """An MTProto call-signaling request failed (e.g. an RPC error).

    ``code`` carries the Telegram RPC error id when known, e.g.
    ``CALL_PROTOCOL_COMPAT_LAYER_INVALID`` or ``USER_PRIVACY_RESTRICTED``.
    """

    def __init__(self, message: str, code: str | None = None):
        super().__init__(message)
        self.code = code


class CallDiscarded(EmysaCallError):
    """The peer (or Telegram) discarded the call during setup."""

    def __init__(self, reason: str):
        super().__init__(f"call discarded: {reason}")
        self.reason = reason


class CallTimeout(EmysaCallError):
    """A setup step did not complete in time."""


class MediaError(EmysaCallError):
    """The media engine (NTgCalls) rejected an operation or failed to connect."""


class KeyExchangeError(MediaError):
    """DH key exchange rejected (hash/fingerprint mismatch, bad parameters)."""


class CallFailed(EmysaCallError):
    """Public failure of ``place_call``. ``reason`` is a stable short string:
    declined, busy, missed, hangup, timeout, signaling_error,
    key_exchange_failed, media_failed, local_hangup, cancelled, internal_error.
    """

    def __init__(self, reason: str, detail: str | None = None):
        super().__init__(f"call failed: {reason}" + (f" ({detail})" if detail else ""))
        self.reason = reason
        self.detail = detail
