# Shared need: Rust engine + Node so test images can FROM scn-need/build.
FROM rust:1.88-bookworm
WORKDIR /build
COPY . .
RUN cargo build -p openscion-server --release \
    && cp target/release/openscion-server /usr/local/bin/openscion-server \
    && rm -rf /build/target /usr/local/cargo/registry /usr/local/cargo/git
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates xz-utils \
    && curl -fsSL https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz \
      | tar -xJ -C /usr/local --strip-components=1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/api-ci
COPY tools/api-ci/package.json tools/api-ci/package-lock.json ./
RUN npm ci --omit=dev
WORKDIR /opt/worker
COPY apps/worker/package.json apps/worker/package-lock.json ./
RUN npm install --omit=dev
ENV NODE_PATH=/opt/worker/node_modules:/opt/api-ci/node_modules
WORKDIR /workspace
