#!/usr/bin/env bash
# Secret-scan exactly the commits this CI run is answerable for (#175).
#
# The checkout uses fetch-depth: 0, which fetches EVERY branch as
# refs/remotes/origin/*. Without --log-opts, gitleaks runs
# `git log --all`, so one unmerged builder branch's finding would fail
# every open PR. Instead:
#   pull_request -> origin/<base>..HEAD  (the PR's own commits, plus the merge commit)
#   push         -> HEAD                 (full history of the pushed branch only)
#
# Known gap (pre-existing, unchanged): gitleaks' `git log -p` shows no diff for
# merge commits, so text introduced only in a conflict resolution is not scanned.
#
# Exit: 0 clean, 1 leaks found (gitleaks), 2 scan could not be scoped.
# Env: GITHUB_EVENT_NAME (set by Actions), BASE_REF (github.base_ref, PRs only),
#      GITLEAKS_CONFIG (default .gitleaks.toml).
set -euo pipefail

config="${GITLEAKS_CONFIG:-.gitleaks.toml}"

# A shallow clone would silently scan a truncated history.
if [ "$(git rev-parse --is-shallow-repository)" != "false" ]; then
  echo "gitleaks-scan: repository is shallow; checkout needs fetch-depth: 0" >&2
  exit 2
fi

case "${GITHUB_EVENT_NAME:-}" in
  pull_request)
    if [ -z "${BASE_REF:-}" ]; then
      echo "gitleaks-scan: BASE_REF (the PR base branch) is required for pull_request" >&2
      exit 2
    fi
    base="origin/${BASE_REF}"
    git rev-parse --verify --quiet "${base}^{commit}" >/dev/null || {
      echo "gitleaks-scan: base ref ${base} not found" >&2
      exit 2
    }
    range="${base}..HEAD"
    ;;
  push)
    range="HEAD"
    ;;
  *)
    echo "gitleaks-scan: unsupported event '${GITHUB_EVENT_NAME:-}'" >&2
    exit 2
    ;;
esac

# An empty range means the scoping is wrong, not that the PR is clean.
count="$(git rev-list --count "${range}")"
if [ "${count}" -eq 0 ]; then
  echo "gitleaks-scan: range ${range} contains no commits" >&2
  exit 2
fi

echo "gitleaks-scan: ${GITHUB_EVENT_NAME} scan of ${range} (${count} commits)"
exec gitleaks detect --redact -v -c "${config}" --log-opts="${range}"
