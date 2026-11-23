#!/usr/bin/env bash
# The ONE way to merge a PR into an Ebda repo: ops/merge-gate.sh <pr> <expected-head-sha> [options]
#
# WHY. #223 was merged 6 s after creation with ZERO checks; `gh pr merge` happily merges when nothing has reported
# yet. This gate refuses unless, on THREE consecutive polls:
#   - the PR head is exactly <expected-head-sha> (a prefix of 7+ chars is fine): you merge what you reviewed, and
#     the final `gh pr merge` is pinned to that commit (--match-head-commit)
#   - mergeable == MERGEABLE (not UNKNOWN, not CONFLICTING)
#   - at least one check exists (zero checks is "CI has not started", never "green")
#   - every check is COMPLETED with SUCCESS / SKIPPED / NEUTRAL (queued, in progress, failed, cancelled, timed out: no)
#   - every REQUIRED check is an explicit SUCCESS. The required list is DERIVED from .github/workflows by
#     ops/merge-gate-required.mjs (jobs that always run on every PR), so it cannot drift from the workflows.
# "Every check" means the LATEST run of each check name. The rollup keeps superseded runs of the same name on the same
# head (cancelled by a concurrency group, then re-run green); an old run never decides the verdict, in either direction.
# A failed/cancelled check or a moved head ends the run at once (exit 1). Pending checks are waited on, up to
# --max-wait-min (default 180); running out of time exits 2 and merges nothing.
#
# options: --repo OWNER/NAME (default: this checkout's repo, via gh)  --workflows DIR (default <toplevel>/.github/workflows)
#          --polls N (3)  --interval S (30)  --max-wait-min M (180)
#          --dry-run (evaluate, never merge)
# CROSS-REPO: the required list comes from the TARGET repo's workflows. When --repo is not the repo that owns this script's
# checkout, pass --workflows <target checkout>/.github/workflows (or run from the target checkout via the installed gate);
# without it the gate refuses (exit 2) rather than demand this repo's checks from another repo's PR (2026-11-12: ebda-whatsapp
# #72 waited 90 min for ebda-foundation's "OS brain Worker" / "PR sanity").
# test seams: MERGE_GATE_VIEW_CMD (prints the `gh pr view --json state,headRefOid,mergeable,statusCheckRollup` JSON),
#             MERGE_GATE_MERGE_CMD (replaces the final gh pr merge), MERGE_GATE_REQUIRED_JSON, MERGE_GATE_MAX_WAIT_S, MERGE_GATE_MAX_TICKS.
set -uo pipefail
pr="${1:?usage: merge-gate.sh <pr> <expected-head-sha> [--repo R] [--polls N] [--interval S] [--max-wait-min M] [--dry-run]}"
want="${2:?expected head sha required}"; shift 2
repo=""; wfdir=""; polls=3; interval=30; maxmin=180; dry=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) repo="$2"; shift 2 ;; --workflows) wfdir="$2"; shift 2 ;; --polls) polls="$2"; shift 2 ;; --interval) interval="$2"; shift 2 ;;
    --max-wait-min) maxmin="$2"; shift 2 ;; --dry-run) dry=1; shift ;;
    *) echo "merge-gate: unknown option $1" >&2; exit 64 ;;
  esac
done
[ "${#want}" -ge 7 ] || { echo "merge-gate: expected sha must be at least 7 chars" >&2; exit 64; }
here="$(cd "$(dirname "$0")" && pwd)"
root="$(env -u GIT_DIR -u GIT_WORK_TREE git -C "$here" rev-parse --show-toplevel)"   # works in this repo (ops/) and in a vendored copy (scripts/foundation/)
[ -n "$repo" ] || repo="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)" || true
[ -n "$repo" ] || { echo "merge-gate: could not tell which repo (pass --repo OWNER/NAME)" >&2; exit 64; }
if [ -n "${MERGE_GATE_REQUIRED_JSON:-}" ]; then required="$MERGE_GATE_REQUIRED_JSON"
else
  if [ -z "$wfdir" ]; then
    # no explicit dir: $root's workflows are only right when --repo IS the repo that owns $root; fail closed otherwise
    origin="$(env -u GIT_DIR -u GIT_WORK_TREE git -C "$root" remote get-url origin 2>/dev/null | sed -E 's#/+$##; s#^.*[:/]([^/:]+/[^/]+)$#\1#; s#\.git$##')"
    if [ -z "$origin" ] || [ "$(printf %s "$origin" | tr '[:upper:]' '[:lower:]')" != "$(printf %s "$repo" | tr '[:upper:]' '[:lower:]')" ]; then
      echo "merge-gate: --repo $repo is not the checkout at $root (origin: ${origin:-unknown}); its workflows would give the wrong required checks. Pass --workflows <$repo checkout>/.github/workflows; refusing" >&2; exit 2
    fi
    wfdir="$root/.github/workflows"
  fi
  [ -d "$wfdir" ] || { echo "merge-gate: no workflows dir at $wfdir (pass --workflows <checkout>/.github/workflows); refusing" >&2; exit 2; }
  required="$(node "$here/merge-gate-required.mjs" "$wfdir")"
fi
[ -n "$required" ] && [ "$(echo "$required" | jq 'length')" -gt 0 ] || { echo "merge-gate: could not derive the required checks; refusing" >&2; exit 2; }

view() {
  if [ -n "${MERGE_GATE_VIEW_CMD:-}" ]; then eval "$MERGE_GATE_VIEW_CMD"
  else gh pr view "$pr" --repo "$repo" --json state,headRefOid,mergeable,statusCheckRollup; fi
}

# one verdict word per poll: ok | wait:<why> | refuse:<why>
evaluate() {
  jq -r --arg want "$want" --argjson req "$required" '
    def nm: (.name // .context);
    def st: if .__typename == "StatusContext" then (if .state == "PENDING" or .state == "EXPECTED" then "IN_PROGRESS" else "COMPLETED" end) else .status end;
    def cc: if .__typename == "StatusContext" then (if .state == "SUCCESS" then "SUCCESS" else .state end) else (.conclusion // "") end;
    # latest run per check name: startedAt // createdAt // completedAt, a tie keeps rollup order (the later entry wins).
    # gh prints a null timestamp as the year-1 zero time (= missing); an unfinished run with no start time is the newest.
    def ts: ([.startedAt, .createdAt, .completedAt] | map(select(. != null and . != "" and (startswith("0001-") | not))) | first)
            // (if st == "COMPLETED" then "" else "~" end);
    . as $p
    | ([($p.statusCheckRollup // [])[]] | to_entries | map(.value + {__i: .key}) | group_by(nm) | map(sort_by([ts, .__i]) | last) | sort_by(.__i)) as $c
    | if ($p.headRefOid | startswith($want) | not) then "refuse:head moved to \($p.headRefOid[0:9]) (expected \($want))"
      elif [$c[] | select(st == "COMPLETED" and (cc | IN("SUCCESS","SKIPPED","NEUTRAL") | not)) | nm] | length > 0
        then "refuse:failing check(s): \([$c[] | select(st == "COMPLETED" and (cc | IN("SUCCESS","SKIPPED","NEUTRAL") | not)) | nm] | join(", "))"
      elif ($c | length) == 0 then "wait:no checks have reported yet"
      elif [$c[] | select(st != "COMPLETED") | nm] | length > 0 then "wait:not finished: \([$c[] | select(st != "COMPLETED") | nm] | join(", "))"
      elif ($p.mergeable != "MERGEABLE") then "wait:mergeable=\($p.mergeable)"
      elif ($req - [$c[] | select(cc == "SUCCESS") | nm]) | length > 0 then "wait:required check(s) without an explicit SUCCESS: \(($req - [$c[] | select(cc == "SUCCESS") | nm]) | join(", "))"
      else "ok" end'
}

deadline=$((SECONDS + ${MERGE_GATE_MAX_WAIT_S:-$((maxmin * 60))})); streak=0; sha=""; ticks=0
while :; do
  json="$(view 2>/dev/null)" || json=""
  # PR state first, on EVERY poll: a PR merged/closed by someone else must end the gate, not poll to the deadline.
  pstate="$(echo "$json" | jq -r '.state // empty' 2>/dev/null || true)"
  case "$pstate" in
    MERGED) echo "merge-gate: PR $pr already merged; nothing to do"; exit 0 ;;
    CLOSED) echo "merge-gate: REFUSED PR $pr: closed without merging" >&2; exit 1 ;;
  esac
  if [ -z "$json" ]; then v="wait:could not read the PR"; else v="$(echo "$json" | evaluate)"; sha="$(echo "$json" | jq -r .headRefOid)"; fi
  case "$v" in
    ok) streak=$((streak + 1)); echo "merge-gate: PR $pr green poll $streak/$polls"
        if [ "$streak" -ge "$polls" ]; then
          if [ "$dry" = 1 ]; then echo "merge-gate: DRY RUN, would merge $pr at $sha"; exit 0; fi
          if [ -n "${MERGE_GATE_MERGE_CMD:-}" ]; then eval "$MERGE_GATE_MERGE_CMD"; exit $?; fi
          gh pr merge "$pr" --repo "$repo" --squash --delete-branch --match-head-commit "$sha"; exit $?
        fi ;;
    refuse:*) echo "merge-gate: REFUSED PR $pr: ${v#refuse:}" >&2; exit 1 ;;
    *) streak=0; echo "merge-gate: waiting (${v#wait:})" ;;
  esac
  # MERGE_GATE_MAX_TICKS bounds the loop by poll COUNT (test seam). $SECONDS is whole seconds, so a 1-2 s wall-clock budget is
  # exceeded whenever a poll straddles a second boundary (CI flake, #23); a poll count does not depend on host load or the clock.
  ticks=$((ticks + 1))
  if [ "$SECONDS" -ge "$deadline" ] || [ "$ticks" -ge "${MERGE_GATE_MAX_TICKS:-2147483647}" ]; then echo "merge-gate: gave up after ${maxmin} min; nothing merged (last: ${v#*:})" >&2; exit 2; fi
  sleep "$interval"
done
