#!/bin/bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/local-env.sh"

[[ $# -ge 2 ]] || local_fail 'Usage: ./scripts/local.sh {root|backend|frontend} command [arguments...]'
case "$1" in
  root) cd "${ROOT_DIR}" ;;
  backend|frontend) cd "${ROOT_DIR}/$1" ;;
  *) local_fail 'Working directory must be root, backend or frontend.' ;;
esac
shift
require_local_runtimes
if [[ "${1:-}" == "npm" && "${2:-}" == "run" && "${3:-}" == "dev" ]]; then
  if [[ -z "${SWC_NATIVE_BINDING_CACHE:-}" ]]; then
    export SWC_NATIVE_BINDING_CACHE="/tmp/freelingo-swc"
  fi
  mkdir -p "${SWC_NATIVE_BINDING_CACHE}"
fi
exec "$@"
