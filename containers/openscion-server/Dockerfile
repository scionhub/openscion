# Multi-stage build for openscion-server
FROM rust:1.88 as builder
WORKDIR /build

# Build the server
COPY . .
RUN cargo build -p openscion-server --release

FROM debian:bookworm-slim
RUN useradd -m -u 10001 appuser
WORKDIR /app
COPY --from=builder /build/target/release/openscion-server /usr/local/bin/openscion-server
USER appuser
EXPOSE 7878
ENV OPENSCION_LISTEN=0.0.0.0:7878
CMD ["/usr/local/bin/openscion-server"]
