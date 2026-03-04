#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

print_only=0
if [[ "${1:-}" == "--print-only" ]]; then
  print_only=1
fi

year="$(date -u +%Y)"
month="$((10#$(date -u +%m)))"
day="$((10#$(date -u +%d)))"
base_version="${year}.${month}.${day}"

has_base_tag=0
if git rev-parse --verify --quiet "refs/tags/v${base_version}" >/dev/null; then
  has_base_tag=1
fi

max_revision=-1
while IFS= read -r tag; do
  revision="${tag#v${base_version}-r}"
  if [[ "$revision" =~ ^[0-9]+$ ]] && (( revision > max_revision )); then
    max_revision="$revision"
  fi
done < <(git tag -l "v${base_version}-r*")

if (( has_base_tag == 0 && max_revision < 0 )); then
  version="$base_version"
elif (( max_revision < 0 )); then
  version="${base_version}-r1"
else
  version="${base_version}-r$((max_revision + 1))"
fi

if (( print_only == 1 )); then
  printf '%s\n' "$version"
  exit 0
fi

for package_dir in backend frontend; do
  (
    cd "$package_dir"
    bun pm pkg set "version=${version}"
  )
done

(
  cd usps-scraper
  npm version "$version" --no-git-tag-version
)

printf '%s\n' "$version"
