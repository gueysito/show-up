#!/bin/sh
set -eu
project_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
contract_root="$project_root/contracts"
task=${1:-test}
shift || true
case "$(uname -m)" in
  arm64|aarch64) contract_arch=arm64; contract_base=rust:1.93.0-trixie@sha256:dd0174522c412ad5be5f2472ac3ea2ebb686768cbfd7c16884fc5200efdf1857 ;;
  x86_64) contract_arch=amd64; contract_base=rust:1.93.0-trixie@sha256:9707deb7307068a13b22023fc0e8a3804717781641cc7ad823e649415a6af4c8 ;;
  *) echo 'Unsupported contract toolchain architecture' >&2; exit 1 ;;
esac
tool_image="showup-contract-tools:$contract_arch-v2"
if [ "$task" = prepare ]; then
  docker build --platform "linux/$contract_arch" --build-arg "CONTRACT_BASE=$contract_base" -f "$contract_root/Dockerfile" -t "$tool_image" "$contract_root"
  exit
fi
mkdir -p "$contract_root/.cache/cargo" "$contract_root/.cache/target" "$contract_root/.cache/bin"
network=none
source_mode=readonly
case "$task" in
  lock) network=bridge; source_mode=consistent; set -- cargo generate-lockfile ;;
  fetch) network=bridge; set -- cargo fetch --locked ;;
  pin)
    [ "$#" -eq 2 ] || exit 1
    case "$1:$2" in *[!a-zA-Z0-9_.:+-]*) exit 1 ;; esac
    network=bridge; source_mode=consistent
    set -- cargo update -p "$1" --precise "$2" ;;
  format) source_mode=consistent; set -- cargo fmt --all ;;
  format-check) set -- cargo fmt --all --check ;;
  runtime-check) set -- /cache/bin/near-sandbox --version ;;
  wasm) set -- env 'RUSTFLAGS=--cfg near' cargo build --frozen --release --target wasm32-unknown-unknown -p showup-escrow -p showup-test-token ;;
  lint) set -- env 'RUSTFLAGS=--cfg near' cargo clippy --frozen --release --target wasm32-unknown-unknown -p showup-escrow -p showup-test-token -- -D warnings ;;
  lint-tests) set -- cargo clippy --frozen -p showup-sandbox-tests --tests -- -D warnings ;;
  test)
    node "$project_root/scripts/prepare-contracts.mjs" --verify
    test_filter=${1:-}
    case "$test_filter" in *[!a-zA-Z0-9_]*) exit 1 ;; esac
    set -- env NEAR_SANDBOX_BIN_PATH=/cache/bin/near-sandbox cargo test --frozen -p showup-sandbox-tests "$test_filter" -- --nocapture --test-threads=1 ;;
  app-bridge)
    bridge_id=${1:-}
    case "$bridge_id" in ''|*[!0-9a-f]*) exit 1 ;; esac
    [ "${#bridge_id}" -eq 32 ] || exit 1
    node "$project_root/scripts/prepare-contracts.mjs" --verify
    set -- env "SHOWUP_APP_BRIDGE=$bridge_id" NEAR_SANDBOX_BIN_PATH=/cache/bin/near-sandbox cargo test --frozen -p showup-sandbox-tests --test app_bridge application_attendance_round_trip -- --ignored --nocapture --test-threads=1 ;;
  *) echo 'Use prepare, lock, fetch, pin, format, format-check, wasm, test or app-bridge' >&2; exit 1 ;;
esac
if [ "$source_mode" = readonly ]; then source_options=readonly; else source_options=consistency=consistent; fi
cpu_limit=$(docker info --format '{{.NCPU}}')
case "$cpu_limit" in ''|0|*[!0-9]*) echo 'Cannot determine Docker CPU capacity' >&2; exit 1 ;; esac
if [ "$cpu_limit" -gt 4 ]; then cpu_limit=4; fi
exec docker run --rm --platform "linux/$contract_arch" --network "$network" --cpus "$cpu_limit" --memory 5g \
  --user "$(id -u):$(id -g)" \
  --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 \
  --mount "type=bind,src=$contract_root,dst=/work,$source_options" \
  --mount "type=bind,src=$contract_root/.cache,dst=/cache" "$tool_image" "$@"
