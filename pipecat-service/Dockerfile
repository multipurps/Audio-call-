# Optional Docker build for the assistant service.
#
# Render's native Python runtime works fine with requirements.txt alone, and is
# the recommended path (render.yaml uses it). This Dockerfile exists because a
# Web Service on Render can be switched to Docker, and because pinning the base
# image is the only way to guarantee the audio stack behaves identically
# between local runs and production.
#
# What is deliberately NOT installed, and why:
#   * **No FFmpeg, no libopus, no libgmp, no ext-ffi.** Those are Telegram-side
#     (multipurps/mp-relay) dependencies. MadelineProto carries a pure-PHP
#     libtgvoip implementation and OGG Opus muxer, and this service receives
#     already-decoded PCM16 over the ACAF bridge, so it needs no codec at all.
#   * **No build-essential.** Every wheel here is prebuilt and manylinux
#     compatible; if a future dependency needs compiling, that is a signal to
#     reconsider the dependency rather than to add a toolchain to a
#     latency-sensitive service.

FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Requirements first so the dependency layer is cached across code changes.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Run as a non-root user. The service holds provider API keys in its
# environment, so an RCE in a dependency should not also be a root shell.
RUN useradd --create-home --uid 10001 assistant \
    && chown -R assistant:assistant /app
USER assistant

# Render injects PORT; app.main reads it and binds 0.0.0.0.
EXPOSE 8080

# Liveness only -- /readyz performs provider checks and is not appropriate
# for a container healthcheck that Docker runs every few seconds.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import os,urllib.request;urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8080\")}/healthz').read()" || exit 1

# Exec form: PID 1 must be Python, not a shell, or SIGTERM from Render will not
# reach the process and graceful call teardown will never run.
CMD ["python", "-m", "app.main"]
