#!/usr/bin/env bash
#
# Starts a throwaway three-node Redis Cluster for the cluster test suite.
#
# Nothing is installed: three extra processes of the existing redis-server, with their
# data in a temp directory. `down.sh` removes them, and so does a reboot. Ports start at
# 7381 because macOS listens on 7000 for AirPlay.
set -euo pipefail

DIR="${SENTINEL_CLUSTER_DIR:-${TMPDIR:-/tmp}/nestjs-sentinel-cluster}"
PORTS=(7381 7382 7383)

command -v redis-server >/dev/null || { echo "redis-server not found"; exit 1; }

case "$DIR" in
  ""|"/"|"$HOME"|"$HOME/") echo "refusing to use $DIR"; exit 1 ;;
  */nestjs-sentinel-cluster*) ;;
  *) echo "SENTINEL_CLUSTER_DIR must end in nestjs-sentinel-cluster, got: $DIR"; exit 1 ;;
esac

# A previous run may still hold the ports; start from nothing.
bash "$(dirname "$0")/down.sh" >/dev/null 2>&1 || true

rm -rf "$DIR"

for port in "${PORTS[@]}"; do
  mkdir -p "$DIR/$port"
  redis-server \
    --port "$port" \
    --bind 127.0.0.1 \
    --cluster-enabled yes \
    --cluster-announce-ip 127.0.0.1 \
    --cluster-config-file nodes.conf \
    --cluster-node-timeout 5000 \
    --dir "$DIR/$port" \
    --appendonly no \
    --save '' \
    --daemonize yes \
    --pidfile "$DIR/$port/redis.pid" \
    --logfile "$DIR/$port/redis.log"
done

for port in "${PORTS[@]}"; do
  deadline=$((SECONDS + 30))
  until redis-cli -p "$port" ping >/dev/null 2>&1; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "node on $port never answered (dir: $DIR/$port)."
      if [ -s "$DIR/$port/redis.log" ]; then
        cat "$DIR/$port/redis.log"
      else
        # No log means it never got far enough to open one. The foreground run prints
        # what it could not say.
        echo "no log written; starting in the foreground to capture the error:"
        redis-server --port "$port" --dir "$DIR/$port" --cluster-enabled yes \
          --logfile '' --daemonize no --save '' 2>&1 | head -20 || true
      fi
      exit 1
    fi
    sleep 0.2
  done
done

# --cluster-yes rather than piping `yes`, which dies of SIGPIPE and trips pipefail.
# The output is kept: a create that fails silently turns the wait below into a hang.
if ! redis-cli --cluster create \
  "127.0.0.1:${PORTS[0]}" "127.0.0.1:${PORTS[1]}" "127.0.0.1:${PORTS[2]}" \
  --cluster-replicas 0 --cluster-yes; then
  echo "cluster create failed"
  exit 1
fi

# Creation returns before the nodes agree; the suite needs a cluster that answers.
deadline=$((SECONDS + 60))
until [ "$(redis-cli -p "${PORTS[0]}" cluster info 2>/dev/null | grep -c 'cluster_state:ok')" = "1" ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "the nodes never agreed on a slot map:"
    redis-cli -p "${PORTS[0]}" cluster info || true
    exit 1
  fi
  sleep 0.5
done

echo "Redis Cluster ready on ${PORTS[*]} (data in $DIR)"
