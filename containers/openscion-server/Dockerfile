# Multi-stage build for openscion-server
FROM rust:1.83 as builder
WORKDIR /build

# Install nightly toolchain for Rust 2024 edition used by the workspace
RUN rustup toolchain install nightly && rustup default nightly

# Cache dependencies
COPY Cargo.toml Cargo.lock ./
COPY crates/openscion-proto/Cargo.toml crates/openscion-proto/Cargo.toml
COPY crates/openscion-core/Cargo.toml crates/openscion-core/Cargo.toml
COPY crates/openscion-server/Cargo.toml crates/openscion-server/Cargo.toml
COPY crates/openscion/Cargo.toml crates/openscion/Cargo.toml
COPY benchmarks/Cargo.toml benchmarks/Cargo.toml
RUN cargo fetch

# Build only the server
COPY . .
RUN RUSTUP_TOOLCHAIN=nightly cargo build -p openscion-server --release

FROM debian:bookworm-slim
RUN useradd -m -u 10001 appuser
WORKDIR /app
COPY --from=builder /build/target/release/openscion-server /usr/local/bin/openscion-server
USER appuser
EXPOSE 7878
ENV OPENSCION_LISTEN=0.0.0.0:7878
CMD ["/usr/local/bin/openscion-server"]
