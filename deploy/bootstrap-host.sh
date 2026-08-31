#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl docker.io docker-compose-v2
systemctl enable --now docker
install -d -m 0700 /opt/openrouter-sim
touch /opt/openrouter-sim/BOOTSTRAP_COMPLETE
