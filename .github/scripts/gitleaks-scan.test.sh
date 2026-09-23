#!/usr/bin/env bash
# Regression test for gitleaks-scan.sh (#175). Builds throwaway repos that
# mirror the CI checkout (every branch fetched as refs/remotes/origin/*) and
# asserts the scan is scoped to the commits a run is answerable for.
#
# Requires the gitleaks binary on PATH. The planted credentials are generated
# at runtime, so this file itself contains nothing a scanner would flag.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
scan="${here}/gitleaks-scan.sh"
export GITLEAKS_CONFIG="${here}/../../.gitleaks.toml"

# Hermetic git: no user/system config (signing, hooks, default branch).
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid

tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

fake_aws_key() {
  # Bounded read (no `tr </dev/urandom | head`, which SIGPIPEs tr).
  printf 'AKIA%s' "$(head -c 4096 /dev/urandom | LC_ALL=C tr -dc 'A-Z2-7' | cut -c1-16)"
}

commit_file() { # <file> <content> <message>
  printf '%s\n' "$2" >"$1"
  git add "$1"
  git commit -q -m "$3"
}

failures=0
# Exit codes are exact so a case can't pass by failing for an unrelated reason.
expect() { # <expected: clean|leak|error> <description> <command...>
  local want="$1" desc="$2" code=0 got
  shift 2
  "$@" >"${tmp}/last.log" 2>&1 || code=$?
  case "${code}" in 0) got=clean ;; 1) got=leak ;; 2) got=error ;; *) got="exit ${code}" ;; esac
  if [ "${got}" = "${want}" ]; then
    echo "ok   - ${desc}"
  else
    echo "FAIL - ${desc} (wanted ${want}, got ${got})"
    sed 's/^/       /' "${tmp}/last.log"
    failures=$((failures + 1))
  fi
}

# --- fixture: origin with develop, an unmerged dirty branch, a clean PR, a dirty PR
git init -q --bare "${tmp}/origin.git"
git clone -q "${tmp}/origin.git" "${tmp}/work" 2>/dev/null
cd "${tmp}/work"
git checkout -q -b develop
commit_file README.md "hello" "initial"
git push -q origin develop

git checkout -q -b builder/other develop
commit_file leak.ts "const key = '$(fake_aws_key)'" "other builder leaks"
git push -q origin builder/other

git checkout -q -b builder/clean-pr develop
commit_file feature.ts "export const x = 1" "clean PR"
git push -q origin builder/clean-pr

git checkout -q -b builder/dirty-pr develop
commit_file feature.ts "const key = '$(fake_aws_key)'" "PR plants a key"
commit_file feature.ts "export const x = 1" "PR removes it again"
git push -q origin builder/dirty-pr

# --- CI-shaped checkout: all branches as remotes, HEAD = PR merged into base
ci_checkout() { # <dir> <pr-branch>
  git clone -q "${tmp}/origin.git" "$1" 2>/dev/null
  git -C "$1" checkout -q --detach origin/develop
  git -C "$1" merge -q --no-ff --no-edit "origin/$2"
}
ci_checkout "${tmp}/ci-clean" builder/clean-pr
ci_checkout "${tmp}/ci-dirty" builder/dirty-pr

pr_scan() { (cd "$1" && GITHUB_EVENT_NAME=pull_request BASE_REF=develop "${scan}"); }
push_scan() { (cd "$1" && GITHUB_EVENT_NAME=push "${scan}"); }
unscoped_scan() { (cd "$1" && gitleaks detect --redact -c "${GITLEAKS_CONFIG}"); }

# Guard: the fixture must actually reproduce #175, or the next case proves nothing.
expect leak "fixture: unscoped scan flags the other branch's leak" unscoped_scan "${tmp}/ci-clean"
expect clean "clean PR passes despite a leak on an unmerged branch" pr_scan "${tmp}/ci-clean"
expect leak "PR that introduces a secret (even if later removed) fails" pr_scan "${tmp}/ci-dirty"
expect error "PR scan without BASE_REF fails loudly" \
  env -u BASE_REF sh -c "cd '${tmp}/ci-clean' && GITHUB_EVENT_NAME=pull_request '${scan}'"
expect error "PR scan against a missing base fails loudly" \
  sh -c "cd '${tmp}/ci-clean' && GITHUB_EVENT_NAME=pull_request BASE_REF=nope '${scan}'"
expect error "PR scan over an empty range fails loudly" \
  sh -c "cd '${tmp}/ci-clean' && git checkout -q --detach origin/develop && GITHUB_EVENT_NAME=pull_request BASE_REF=develop '${scan}'"

# Push: full history of the pushed branch, but not other branches.
git clone -q "${tmp}/origin.git" "${tmp}/push-clean" 2>/dev/null
git -C "${tmp}/push-clean" checkout -q develop
expect clean "develop push passes despite a leak on an unmerged branch" push_scan "${tmp}/push-clean"

cd "${tmp}/work"
git checkout -q develop
git merge -q --no-ff --no-edit builder/dirty-pr
git push -q origin develop
git clone -q "${tmp}/origin.git" "${tmp}/push-dirty" 2>/dev/null
git -C "${tmp}/push-dirty" checkout -q develop
expect leak "develop push fails on a secret anywhere in its history" push_scan "${tmp}/push-dirty"

git clone -q --depth=1 -b develop "file://${tmp}/origin.git" "${tmp}/shallow" 2>/dev/null
expect error "shallow checkout fails loudly" push_scan "${tmp}/shallow"

if [ "${failures}" -ne 0 ]; then
  echo "${failures} case(s) failed" >&2
  exit 1
fi
echo "all cases passed"
