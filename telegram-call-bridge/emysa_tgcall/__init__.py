"""Emysa Phase 5 prototype: Telegram *private* calls over a real user account.

    Telegram user account -> MTProto call signaling (Pyrogram raw API)
        -> NTgCalls/WebRTC media -> PCM bridge -> AudioAdapter

GPT Live is intentionally NOT connected in this phase.
"""
from .adapter import AudioAdapter, KnownAudioAdapter, PcmSink
from .bridge import PcmBridge
from .errors import (BusyError, CallDiscarded, CallFailed, CallTimeout, EmysaCallError,
                     KeyExchangeError, MediaError, SignalingError)
from .manager import AllowList, CallManager, ManagerConfig, accept_all, deny_all
from .media import MediaEngine
from .signaling import SignalingBase
from .types import CallEnd, CallInfo, CallState, Direction, IncomingRequest, MediaState

__all__ = [
    "AudioAdapter", "KnownAudioAdapter", "PcmSink", "PcmBridge", "CallManager", "ManagerConfig",
    "AllowList", "accept_all", "deny_all", "MediaEngine", "SignalingBase", "CallEnd", "CallInfo",
    "CallState", "Direction", "IncomingRequest", "MediaState", "EmysaCallError", "BusyError",
    "CallDiscarded", "CallFailed", "CallTimeout", "KeyExchangeError", "MediaError", "SignalingError",
]
