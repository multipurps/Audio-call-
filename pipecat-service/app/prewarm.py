"""Pay the slow, one-time startup costs at boot instead of during a call.

A live WhatsApp call showed the cost of not doing this: the callee answered
~5 s after the offer, but the assistant needed ~22 s to be ready, because the
first call in a fresh process imported the speech/voice libraries, loaded the
ONNX turn-taking models and downloaded NLTK data while the callee was
already saying "hello?". The callee hung up before Emysa said a word.

Everything here is best-effort: a failure only means the first call pays the
cost, as before. It never blocks the service from starting.
"""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path

from loguru import logger

#: A private, writable NLTK directory. The default (/opt/render/nltk_data) is
#: group-writable, which NLTK refuses to trust, so it re-downloaded per use.
_NLTK_DIR = Path(__file__).resolve().parent.parent / ".nltk_data"


def _prewarm_blocking(mock_mode: bool) -> None:
    started = time.monotonic()
    _NLTK_DIR.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("NLTK_DATA", str(_NLTK_DIR))

    # Importing these triggers their own heavy imports and the NLTK download.
    import pipecat.utils.string  # noqa: F401
    from pipecat.audio.vad.silero import SileroVADAnalyzer

    if not mock_mode:
        import pipecat.services.deepgram.stt  # noqa: F401
        import pipecat.services.fish.tts  # noqa: F401
        import pipecat.services.openai.llm  # noqa: F401
        import pipecat.services.openai.stt  # noqa: F401

    # Loading the models once also warms the OS file cache and ONNX runtime.
    SileroVADAnalyzer()
    try:
        from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3

        LocalSmartTurnAnalyzerV3()
    except Exception as exc:  # noqa: BLE001
        logger.warning("smart turn prewarm skipped: {}", exc)

    logger.info("prewarm done in {:.1f}s", time.monotonic() - started)


async def prewarm(mock_mode: bool = False) -> None:
    try:
        await asyncio.to_thread(_prewarm_blocking, mock_mode)
    except Exception as exc:  # noqa: BLE001
        logger.warning("prewarm failed (first call will be slower): {}", exc)
