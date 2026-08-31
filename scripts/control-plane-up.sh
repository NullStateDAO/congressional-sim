#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

service=${1:-all}
case "$service" in
  all) docker compose up -d postgres redis minio ;;
  postgres) docker compose up -d postgres ;;
  redis) docker compose up -d redis ;;
  s3|minio) docker compose up -d minio ;;
  *)
    echo "Usage: $0 [all|postgres|redis|s3]" >&2
    exit 2
    ;;
esac
