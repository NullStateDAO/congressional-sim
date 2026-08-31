#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

export POSTGRES_USER=${POSTGRES_USER:-sim}
export POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-sim-local-only}
export POSTGRES_DB=${POSTGRES_DB:-sim_cluster}
export DATABASE_URL=${DATABASE_URL:-postgres://sim:sim-local-only@127.0.0.1:45432/sim_cluster}
export REDIS_PASSWORD=${REDIS_PASSWORD:-redis-local-only}
export REDIS_URL=${REDIS_URL:-redis://:redis-local-only@127.0.0.1:46379}
export QUEUE_NAME=${QUEUE_NAME:-simulation-jobs}
export MINIO_ROOT_USER=${MINIO_ROOT_USER:-sim-minio}
export MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD:-sim-minio-local-only}
export S3_ENDPOINT=${S3_ENDPOINT:-http://127.0.0.1:49000}
export S3_REGION=${S3_REGION:-us-east-1}
export S3_BUCKET=${S3_BUCKET:-simulation-artifacts}
export S3_ACCESS_KEY_ID=${S3_ACCESS_KEY_ID:-sim-minio}
export S3_SECRET_ACCESS_KEY=${S3_SECRET_ACCESS_KEY:-sim-minio-local-only}
export S3_FORCE_PATH_STYLE=${S3_FORCE_PATH_STYLE:-true}
export SIMULATION_TRANSPORT=${SIMULATION_TRANSPORT:-mock}
export OPENROUTER_MODEL=${OPENROUTER_MODEL:-deepseek/deepseek-v4-flash}
export WORKER_CONCURRENCY=${WORKER_CONCURRENCY:-4}
export OPENROUTER_CONCURRENCY=${OPENROUTER_CONCURRENCY:-32}
export EXPERIMENT_ID=${EXPERIMENT_ID:-hello-world-$(date +%s)}

mkdir -p .cluster

pnpm infra:up
for _ in $(seq 1 60); do
  if docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1 \
    && docker compose exec -T redis redis-cli -a "$REDIS_PASSWORD" ping >/dev/null 2>&1 \
    && curl -fsS "$S3_ENDPOINT/minio/health/live" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

pnpm db:migrate
pnpm experiment:enqueue -- --experiment "$EXPERIMENT_ID" --seeds "${SEEDS:-2}"
pnpm worker >.cluster/hello-worker.log 2>&1 &
worker_pid=$!
trap 'kill "$worker_pid" >/dev/null 2>&1 || true' EXIT

while true; do
  remaining=$(docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc \
    "select count(*) from simulation_jobs where experiment_id='$EXPERIMENT_ID' and status <> 'complete'")
  echo "Hello simulation: $remaining job(s) remaining"
  if [[ "$remaining" == "0" ]]; then
    break
  fi
  sleep 1
done

pnpm finalize -- --experiment "$EXPERIMENT_ID" --output ".cluster/$EXPERIMENT_ID-manifest.json"
echo "Manifest: .cluster/$EXPERIMENT_ID-manifest.json"
