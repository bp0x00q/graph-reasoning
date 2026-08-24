#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PACKAGE_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"

exec node "$PACKAGE_ROOT/scripts/install.mjs" --source "$PACKAGE_ROOT" "$@"
