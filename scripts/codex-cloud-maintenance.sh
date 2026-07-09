#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

install_if_needed() {
  local package_dir="$1"
  shift

  if [ ! -d "$package_dir/node_modules" ] || [ "$package_dir/package-lock.json" -nt "$package_dir/node_modules/.package-lock.json" ]; then
    echo "==> Refreshing $package_dir dependencies"
    npm ci --prefix "$package_dir" "$@"
  else
    echo "==> $package_dir dependencies are current"
  fi
}

install_if_needed backend
install_if_needed frontend --legacy-peer-deps

echo "==> Codex Cloud maintenance complete"
