#!/usr/bin/env python3
"""LIVE Telegram smoke test. NOT RUN by the author (no account in the build sandbox).

Uses a REAL Telegram USER account (not a bot). Credentials come from the
environment; nothing is hard-coded or written to disk except the Pyrogram
session file you choose.

  export TG_API_ID=...  TG_API_HASH=...            # https://my.telegram.org/apps
  python scripts/live_smoke.py listen --allow 123456789          # answer calls from that user id
  python scripts/live_smoke.py call @someone                      # place a call

Requirements: a SECOND Telegram account to talk to (you cannot call yourself),
and that account's Settings > Privacy > Calls must allow the gateway account.
Each run writes the audio it received from the other side to ./live_rx.wav and
plays a known 500/700/900 Hz tone sequence to them: if they hear three rising
beeps, the full path works.
"""
import argparse
import asyncio
import logging
import os
import sys

from pyrogram import Client

from emysa_tgcall import AllowList, CallManager, CallState, KnownAudioAdapter, ManagerConfig
from emysa_tgcall.media import NTgCallsMedia
from emysa_tgcall.pyrogram_signaling import PyrogramSignaling


async def main(a) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    client = Client(a.session, api_id=int(os.environ["TG_API_ID"]), api_hash=os.environ["TG_API_HASH"])
    sig = PyrogramSignaling(client, manage_client=True)
    adapters: list[KnownAudioAdapter] = []

    def adapter():
        ad = KnownAudioAdapter(trigger="start")
        adapters.append(ad)
        return ad

    mgr = CallManager(sig, NTgCallsMedia, adapter,
                      accept_policy=AllowList(a.allow or []), config=ManagerConfig())
    await sig.start()
    await mgr.start()
    try:
        if a.mode == "call":
            info = await mgr.place_call(a.target)
            print("ACTIVE:", info)
            await asyncio.sleep(a.seconds)
            await mgr.hangup()
        else:
            print(f"listening for calls from {a.allow} (Ctrl-C to stop)")
            while True:
                await asyncio.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        await mgr.hangup()
        await mgr.wait_state(CallState.IDLE, 10)
        await sig.stop()
        for ad in adapters:
            if ad.rx_frames:
                ad.save_wav("live_rx.wav")
                print(f"received {ad.rx_frames} frames from the other side -> live_rx.wav")
        print("history:", mgr.history)
    return 0


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("mode", choices=["call", "listen"])
    p.add_argument("target", nargs="?", help="@username, +E164 number or numeric id (call mode)")
    p.add_argument("--allow", nargs="*", type=int, help="caller user ids allowed to ring us")
    p.add_argument("--session", default="emysa_phase5")
    p.add_argument("--seconds", type=float, default=15)
    args = p.parse_args()
    if args.mode == "call" and not args.target:
        p.error("call mode needs a target")
    sys.exit(asyncio.run(main(args)))
