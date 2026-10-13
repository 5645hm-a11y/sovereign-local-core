#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist/wasm
em++ native/core_engine.cpp -std=c++20 -O3 -flto -fwasm-exceptions --no-entry \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node \
  -sFILESYSTEM=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=8388608 \
  -sMAXIMUM_MEMORY=536870912 -sSTACK_SIZE=262144 -sABORTING_MALLOC=0 \
  '-sEXPORTED_FUNCTIONS=["_malloc","_free","_core_abi_version","_core_merge","_core_output_ptr","_core_output_size","_core_clear_output","_core_session_create","_core_session_destroy","_core_session_apply","_core_session_apply_authorized","_core_session_configure","_core_session_snapshot","_core_session_checkpoint","_core_session_restore","_core_session_reset","_core_session_business_work","_core_session_query"]' \
  '-sEXPORTED_RUNTIME_METHODS=["HEAPU8"]' -o dist/wasm/core_engine.mjs
