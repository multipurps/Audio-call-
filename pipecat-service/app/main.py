"""FastAPI entrypoint: the ACAF WebSocket bridge, health checks, shutdown.

Endpoints:

  * `GET  /healthz` -- liveness. Always cheap, always 200 while the process
    is up. Render's health check points here.
  * `GET  /readyz`  -- readiness. Reports whether the configured providers are
    usable and how many calls are live. Returns 503 when not ready, so a
    rolling deploy does not send traffic to an instance whose configuration
    is broken.
  * `WS   /stream`  -- the ACAF bridge. One call per connection.

**This service must never be exposed to a browser.** It is the process that
holds the provider keys, and the bridge secret is the only thing keeping an
arbitrary internet client from opening sessions and spending credit. It is
reached by the PHP relay only, over Render's private networking (`*.internal`)
where available. `/healthz` and `/readyz` are the only unauthenticated
endpoints and neither exposes a secret.

Audio never passes through Vercel. The path is:

    Telegram <-> MadelineProto (PHP, mp-relay) <-> [ACAF] <-> this service

Vercel only ever issues the control-plane HTTP request that starts a call.
"""

from __future__ import annotations

import asyncio
import contextlib
import signal
import time
from typing import Any, AsyncIterator

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from loguru import logger

from app.config import ConfigError, Settings, load_settings
from app.logging_setup import configure_logging
from app.pipeline import validate_pipeline_configuration
from app.protocol import ProtocolError
from app.session import CapacityError, SessionRegistry
from app.transport import AcafBridge

SERVICE_NAME = "audio-call-assistant"
SERVICE_VERSION = "1.0.0"


class ServiceState:
    """Process-wide state, created once and shared by the endpoints."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.registry = SessionRegistry()
        self.started_at = time.monotonic()
        self.shutting_down = False
        self.active_bridges: set[AcafBridge] = set()
        self._readiness = validate_pipeline_configuration(settings)

    @property
    def readiness(self) -> dict[str, Any]:
        return self._readiness

    def liveness(self) -> dict[str, Any]:
        return {
            "status": "ok",
            "service": SERVICE_NAME,
            "version": SERVICE_VERSION,
            "uptimeSecs": round(time.monotonic() - self.started_at, 1),
            "mockMode": self.settings.mock_mode,
        }

    def readiness_report(self) -> tuple[dict[str, Any], int]:
        """Readiness body and HTTP status."""
        if self.shutting_down:
            return {"status": "draining", "ready": False}, 503
        if not self._readiness["ok"]:
            return {
                "status": "misconfigured",
                "ready": False,
                "problems": self._readiness["problems"],
            }, 503
        body = {
            "status": "ready",
            "ready": True,
            "providers": self._readiness["providers"],
            "sessions": self.registry.snapshot(),
        }
        return body, 200

    async def shutdown(self) -> None:
        """Graceful shutdown: end every call cleanly before the process exits.

        Render sends SIGTERM on deploy. Without this, in-flight calls are cut
        mid-sentence with no message to the carrier, and their upstream
        provider sockets are abandoned rather than closed.
        """
        if self.shutting_down:
            return
        self.shutting_down = True
        logger.info(
            "shutdown requested",
            extra={
                "activeBridges": len(self.active_bridges),
                "liveSessions": len(self.registry),
            },
        )

        bridges = list(self.active_bridges)
        if bridges:
            await asyncio.gather(
                *(bridge.close("shutdown") for bridge in bridges),
                return_exceptions=True,
            )
        await self.registry.stop_all("shutdown")
        logger.info("shutdown complete")


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the FastAPI application.

    Takes settings as an argument so tests can inject a mock-mode config
    without touching the environment.
    """
    settings = settings or load_settings()

    configure_logging(
        level="DEBUG" if settings.mock_mode else "INFO",
        secrets=settings.secret_values(),
    )
    logger.info(
        "starting audio-call assistant", extra={"config": settings.redacted_summary()}
    )

    state = ServiceState(settings)

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        # Supervisor: reaps idle/expired sessions on a timer. This is what
        # stops a dropped mobile connection from leaving a session -- and its
        # provider connections -- alive forever.
        reaper = asyncio.create_task(_reaper_loop(state))
        try:
            yield
        finally:
            reaper.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await reaper
            await state.shutdown()

    app = FastAPI(
        title="Audio Call Assistant",
        version=SERVICE_VERSION,
        lifespan=lifespan,
        # Docs off by default: this service is internal, and the OpenAPI page
        # would advertise the bridge's shape to anyone who could reach it.
        docs_url="/docs" if settings.mock_mode else None,
        redoc_url=None,
    )
    app.state.service = state

    @app.get("/healthz")
    async def healthz() -> JSONResponse:
        return JSONResponse(state.liveness())

    @app.get("/readyz")
    async def readyz() -> JSONResponse:
        body, status = state.readiness_report()
        return JSONResponse(body, status_code=status)

    @app.websocket("/stream")
    async def stream(websocket: WebSocket) -> None:
        await _handle_stream(websocket, state)

    return app


async def _reaper_loop(state: ServiceState) -> None:
    """Periodically stop sessions that are idle or past their limits."""
    while True:
        try:
            await asyncio.sleep(5.0)
            reaped = await state.registry.reap()
            if reaped:
                logger.info(
                    "reaped expired sessions",
                    extra={"count": len(reaped), "sessions": reaped[:10]},
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - supervisor must not die
            # A crash here would silently stop all cleanup, and the symptom
            # (sessions leaking) would appear hours later with no connection
            # to this line. Log and keep the loop alive.
            logger.error(
                "session reaper iteration failed",
                extra={"error": type(exc).__name__, "detail": str(exc)[:200]},
            )


async def _handle_stream(websocket: WebSocket, state: ServiceState) -> None:
    """Serve one ACAF bridge connection for the life of one call."""
    settings = state.settings

    if state.shutting_down:
        await websocket.close(code=1013)  # try again later
        return

    await websocket.accept()
    bridge: AcafBridge | None = None
    try:
        bridge = AcafBridge(websocket=websocket, settings=settings, registry=state.registry)
        state.active_bridges.add(bridge)
        await bridge.run()
    except WebSocketDisconnect:
        # The normal end of a call. Not an error.
        logger.info("bridge websocket disconnected")
    except CapacityError as exc:
        logger.warning("refusing session", extra={"reason": str(exc)})
        with contextlib.suppress(Exception):
            await websocket.close(code=1013)
    except ProtocolError as exc:
        logger.warning("bridge protocol error", extra={"reason": str(exc)[:200]})
        with contextlib.suppress(Exception):
            await websocket.close(code=1002)
    except Exception as exc:  # noqa: BLE001 - one call must not kill the service
        logger.exception(
            "bridge failed",
            extra={"error": type(exc).__name__, "detail": str(exc)[:300]},
        )
        with contextlib.suppress(Exception):
            await websocket.close(code=1011)
    finally:
        if bridge is not None:
            state.active_bridges.discard(bridge)
            await bridge.close("websocket-closed")


def main() -> None:
    """Console entrypoint (`python -m app.main`)."""
    import uvicorn

    try:
        settings = load_settings()
    except ConfigError as exc:
        # Print to stderr directly: logging is not configured yet, and this
        # must be visible in a Render deploy log.
        print(f"FATAL: invalid configuration: {exc}", flush=True)
        raise SystemExit(1) from exc

    app = create_app(settings)
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        # Long-lived WebSocket connections: keep the ping generous so a call
        # is not torn down mid-sentence, and disable the per-request timeout.
        ws_ping_interval=20.0,
        ws_ping_timeout=20.0,
        timeout_keep_alive=75,
        log_config=None,
        access_log=False,  # the bridge logs its own structured lines
    )


if __name__ == "__main__":
    main()
