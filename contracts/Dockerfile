ARG CONTRACT_BASE=rust:1.93.0-trixie@sha256:9707deb7307068a13b22023fc0e8a3804717781641cc7ad823e649415a6af4c8
FROM ${CONTRACT_BASE}
RUN rustup target add wasm32-unknown-unknown \
    && rustup component add rustfmt clippy
ENV CARGO_HOME=/cache/cargo CARGO_TARGET_DIR=/cache/target
WORKDIR /work
