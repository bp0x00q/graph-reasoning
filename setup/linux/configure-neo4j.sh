#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PACKAGE_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
CONFIG_PATH=""

while (($#)); do
  case "$1" in
    --config)
      [[ $# -ge 2 ]] || { echo '--config requires a path' >&2; exit 2; }
      CONFIG_PATH="$2"
      shift 2
      ;;
    --help|-h)
      cat <<'USAGE'
Usage: ./setup/linux/configure-neo4j.sh [--config PATH]

When --config is omitted, the script checks $NEO4J_HOME/conf/neo4j.conf
and then /etc/neo4j/neo4j.conf.
USAGE
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$CONFIG_PATH" && -n "${NEO4J_HOME:-}" ]]; then
  CONFIG_PATH="$NEO4J_HOME/conf/neo4j.conf"
fi
if [[ -z "$CONFIG_PATH" && -f /etc/neo4j/neo4j.conf ]]; then
  CONFIG_PATH=/etc/neo4j/neo4j.conf
fi
if [[ -z "$CONFIG_PATH" ]]; then
  echo 'Supply --config PATH or set NEO4J_HOME before running this script.' >&2
  exit 2
fi
if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "Neo4j configuration file not found: $CONFIG_PATH" >&2
  exit 2
fi

node "$PACKAGE_ROOT/scripts/configure-neo4j.mjs" --config "$CONFIG_PATH"
printf '\nRestart Neo4j before testing Graph Reasoning.\n'
if command -v systemctl >/dev/null 2>&1; then
  printf 'Typical package-service command: sudo systemctl restart neo4j\n'
fi
