from __future__ import annotations

import asyncio
from dataclasses import dataclass

from emysa_tgcall import (CallManager, CallState, KnownAudioAdapter, ManagerConfig, accept_all)
from emysa_tgcall.pcm import PROBE_HZ, tone
from emysa_tgcall.testing import FakeMediaFabric, FakeTelegramHub

FAST = dict(answer_timeout=1.0, key_exchange_timeout=1.0, connect_timeout=3.0)


@dataclass
class Node:
    uid: int
    mgr: CallManager
    adapters: list


async def make_node(hub, uid, media_factory, policy=accept_all, adapter_factory=None, **cfg):
    sig = hub.endpoint(uid)
    adapters: list = []

    def af():
        a = adapter_factory() if adapter_factory else KnownAudioAdapter(reply=b"")
        adapters.append(a)
        return a

    mgr = CallManager(sig, media_factory, af, accept_policy=policy,
                      config=ManagerConfig(**{**FAST, **cfg}))
    await mgr.start()
    return Node(uid, mgr, adapters)


async def fake_world(policy_b=accept_all, adapter_a=None, adapter_b=None, users=(1, 2), **cfg):
    hub, fab = FakeTelegramHub(), FakeMediaFabric()
    nodes = []
    for i, uid in enumerate(users):
        pol = policy_b if uid != users[0] else accept_all
        af = adapter_a if uid == users[0] else adapter_b
        nodes.append(await make_node(hub, uid, fab.factory(uid), pol, af, **cfg))
    return hub, fab, nodes


async def idle(*nodes, timeout=5.0):
    for n in nodes:
        await n.mgr.wait_state(CallState.IDLE, timeout)


async def active(*nodes, timeout=5.0):
    for n in nodes:
        await n.mgr.wait_state(CallState.ACTIVE, timeout)
