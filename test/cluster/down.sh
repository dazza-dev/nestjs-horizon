#!/usr/bin/env bash
#
# Stops the throwaway cluster and removes its data.
set -uo pipefail

DIR="${SENTINEL_CLUSTER_DIR:-${TMPDIR:-/tmp}/nestjs-sentinel-cluster}"
PORTS=(7381 7382 7383)

case "$DIR" in
  ""|"/"|"$HOME"|"$HOME/") echo "refusing to remove $DIR"; exit 1 ;;
  */nestjs-sentinel-cluster*) ;;
  *) echo "SENTINEL_CLUSTER_DIR must end in nestjs-sentinel-cluster, got: $DIR"; exit 1 ;;
esac

# By port rather than by pid file: a run interrupted before the file was written would
# otherwise leave a node holding the port, and the next create fails on a dirty node.
for port in "${PORTS[@]}"; do
  for pid in $(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null); do
    # Only our own nodes. Something else on 7381 is someone else's process.
    case "$(ps -o comm= -p "$pid" 2>/dev/null)" in
      *redis-server*) kill "$pid" 2>/dev/null || true ;;
      *) echo "port $port is held by pid $pid, which is not redis-server; left alone" ;;
    esac
  done
done

# Bounded wait, then SIGKILL. A node ignoring SIGTERM used to hang this script forever,
# and up.sh calls it first, which hung `pnpm cluster:up` along with it.
for port in "${PORTS[@]}"; do
  for _ in $(seq 1 25); do
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1 || break
    sleep 0.2
  done

  for pid in $(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null); do
    case "$(ps -o comm= -p "$pid" 2>/dev/null)" in
      *redis-server*) kill -9 "$pid" 2>/dev/null || true ;;
    esac
  done
done

rm -rf "$DIR"
echo "Redis Cluster stopped"
