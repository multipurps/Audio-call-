# ---- 1. signal-cli, pinned to a master commit, with PR #2117 (linked-device call fix) applied ----
FROM eclipse-temurin:25-jdk AS signalcli
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone https://github.com/AsamK/signal-cli.git . && git checkout 13d603d3
COPY patches/0001-linked-device-id.patch /tmp/
RUN git apply --check /tmp/0001-linked-device-id.patch && git apply /tmp/0001-linked-device-id.patch
RUN ./gradlew --no-daemon installDist

# ---- 2. signal-call-tunnel (Rust + RingRTC), pinned. Edition 2024 needs a current Rust. ----
FROM rust:1-bookworm AS tunnel
RUN apt-get update && apt-get install -y --no-install-recommends git cmake clang pkg-config \
    libpulse-dev protobuf-compiler libssl-dev python3 && rm -rf /var/lib/apt/lists/*
RUN git clone --recurse-submodules https://github.com/visigoth/signal-call-tunnel.git /t \
    && cd /t && git checkout 02c84e9b && git submodule update --init --recursive
WORKDIR /t/signal-call-tunnel
RUN cargo build --release
RUN mkdir /out && cp "$(find /t/signal-call-tunnel/target/release -maxdepth 1 -type f -name signal-call-tunnel | head -1)" /out/signal-call-tunnel

# ---- 3. node dependencies ----
FROM node:22-bookworm-slim AS nodeapp
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

# ---- 4. runtime ----
FROM eclipse-temurin:25-jre
RUN apt-get update && apt-get install -y --no-install-recommends \
    pulseaudio pulseaudio-utils libpulse0 libssl3 ca-certificates && rm -rf /var/lib/apt/lists/*
RUN useradd -m app
COPY --from=nodeapp /usr/local/bin/node /usr/local/bin/node
COPY --from=signalcli /src/build/install/signal-cli /opt/signal-cli
COPY --from=tunnel /out/signal-call-tunnel /opt/signal-cli/bin/signal-call-tunnel
ENV PATH="/opt/signal-cli/bin:${PATH}" SIGNAL_CALL_TUNNEL_BIN=/opt/signal-cli/bin/signal-call-tunnel
WORKDIR /app
COPY --from=nodeapp /app/node_modules ./node_modules
COPY package.json server.mjs audio-bridge.mjs call-status.mjs start.sh ./
CMD ["/app/start.sh"]
