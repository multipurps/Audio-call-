# emysa-tgcall — Phase 5 prototype

Telegram **private** calls on a real **user account** ⇄ PCM bridge. GPT Live is **not** connected (by design).

```
Telegram user account → MTProto call signaling (Pyrogram raw API)
  → NTgCalls/WebRTC media (ntgcalls, used directly — not py-tgcalls)
  → PcmBridge (48 kHz mono s16le, 10 ms / 960-byte frames, paced 100 fps)
  → AudioAdapter  → (later) GPT Live
```

* `emysa_tgcall/manager.py` – `CallManager`: incoming + outgoing, one call at a time, allow-list, teardown.
* `signaling.py` / `pyrogram_signaling.py` – transport-agnostic call state + the real Pyrogram wire layer.
* `media.py` – `NTgCallsMedia` (real engine). `bridge.py`/`pcm.py`/`adapter.py` – the PCM seam for GPT Live.
* `testing.py` – fake Telegram hub + fake media for tests.

```
pip install -r requirements-dev.txt
pytest --deselect tests/test_real_ntgcalls.py     # fast, deterministic (56 tests)
pytest tests/test_real_ntgcalls.py                # real ntgcalls engine, loopback (7 tests, ~1-in-10 flaky)
python scripts/live_smoke.py --help               # LIVE Telegram check (needs 2 accounts) — never run by the author
```

**Read `docs/PHASE5_REPORT.md` first**: it states exactly what is verified and what is still experimental.
Reason codes: `CallFailed.reason` ∈ declined, busy, missed, timeout, signaling_error, key_exchange_failed,
media_failed, media_timeout, connect_timeout, remote_hangup, local_hangup, cancelled, internal_error.
