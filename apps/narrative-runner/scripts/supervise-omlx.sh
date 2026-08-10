#!/bin/sh

set -eu

if [ "$#" -lt 5 ] || [ "$4" != "--" ]; then
  echo "usage: supervise-omlx.sh <node> <activation verifier> <activation record> -- <omlx command> [arguments ...]" >&2
  exit 64
fi

verification_node="$1"
verification_script="$2"
activation_record="$3"
shift 4

omlx_child_pid=""
omlx_restart_delay="${SURF_OMLX_RESTART_DELAY_SECONDS:-15}"

stop_child() {
  if [ -n "$omlx_child_pid" ]; then
    kill "$omlx_child_pid" 2>/dev/null || true
    wait "$omlx_child_pid" 2>/dev/null || true
  fi
  exit 0
}

trap stop_child HUP INT TERM

while true; do
  if ! "$verification_node" "$verification_script" --verifyRecord "$activation_record" >/dev/null; then
    echo "oMLX activation verification failed" >&2
    exit 78
  fi
  "$@" &
  omlx_child_pid=$!
  wait "$omlx_child_pid" || true
  omlx_child_pid=""
  sleep "$omlx_restart_delay"
done
