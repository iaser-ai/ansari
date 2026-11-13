#!/usr/bin/env bash
# One first-load trial in a real host (#335). The person at the host follows the prompts; the script records the
# deployment's identity, the first attempt and the Retry as separate time windows, and what was seen in each, as one
# JSON line that scripts/first-load-timeline.mjs joins with the server logs.
#
# Usage: bash scripts/first-load-trial.sh <origin> <host: claude|chatgpt> <deploy: fresh|aged> <card: diagnostic|closed> [label]
#   origin: the deployment's public origin, for example https://ansari-mcp-development.up.railway.app
# Output: test-results/first-load/trials.jsonl (git-ignored)
set -euo pipefail

origin="${1:?origin: the public origin of the deployment}"
host="${2:?host: claude or chatgpt}"
deploy="${3:?deploy: fresh (just redeployed) or aged (live for hours)}"
card="${4:?card: diagnostic (MCP_VIEW_DIAGNOSTICS_ORIGIN set) or closed (unset)}"
label="${5:-english-greeting}"
out="$(dirname "$0")/../test-results/first-load"
mkdir -p "$out"

now() { node -e 'console.log(new Date().toISOString())'; }
step() {
  printf '\n>>> %s\n' "$1"
  read -r -p "    [Enter when done] " _
}
capture() {
  local var="$1" question="$2" answer
  printf '\n>>> %s\n' "$question"
  read -r -p "    > " answer
  printf -v "$var" '%s' "$answer"
}

release="$(curl -fsS --max-time 10 "$origin/health" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).release))' || echo unknown)"
printf 'Deployment release: %s\n' "$release"
printf 'Isolate the deployment for this trial: no other conversation or client should use it until the trial ends.\n'

step "In $host, open a NEW conversation with the Ansari connector for $origin enabled. Do not send anything yet. Optional: open devtools on the page."
start="$(now)"
step "Send: Use Ansari Faithful Answers Dev to answer: What does \"assalamu alaikum\" mean? Please keep the answer brief. Press Enter as soon as it is sent."
sent="$(now)"
capture first "What did the embed show first? (card / error / blank / none)"
firstSeen="$(now)"
retry="n-a"; retryAt=""; retrySeen=""
if [ "$first" != "card" ]; then
  step "Press the host's Retry / Try again once, then press Enter immediately."
  retryAt="$(now)"
  capture retry "What does it show now? (card / error / blank / none)"
  retrySeen="$(now)"
fi
capture console "Optional: paste the [ansari-view] console lines from the card frame, or press Enter"
end="$(now)"

node -e 'const [origin, release, host, deploy, card, label, start, sent, first, firstSeen, retryAt, retry, retrySeen, end, consoleLines] = process.argv.slice(1);
  const trial = {origin, release, host, deploy, card, label, start, sent, first, firstSeen, retry, end};
  if (retryAt) Object.assign(trial, {retryAt, retrySeen});
  if (consoleLines) trial.console = consoleLines;
  process.stdout.write(JSON.stringify(trial) + "\n");' \
  "$origin" "$release" "$host" "$deploy" "$card" "$label" "$start" "$sent" "$first" "$firstSeen" "$retryAt" "$retry" "$retrySeen" "$end" "$console" >> "$out/trials.jsonl"

printf '\n--- Recorded in %s ---\n' "$out/trials.jsonl"
tail -n 1 "$out/trials.jsonl"
