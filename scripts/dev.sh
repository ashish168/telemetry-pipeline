#!/usr/bin/env bash
# Run all four services, and stop them together on Ctrl-C.
set -euo pipefail
cd "$(dirname "$0")/.."

pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

npm run ingest   & pids+=($!)
sleep 1
npm run detect   & pids+=($!)
npm run dispatch & pids+=($!)
sleep 1
npm run simulate & pids+=($!)

wait
