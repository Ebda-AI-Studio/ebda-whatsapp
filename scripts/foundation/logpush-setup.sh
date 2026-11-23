#!/usr/bin/env bash
# G7: Workers Logs + Logpush to R2 with 30-day retention, and the PDPL export-bundle expiry (G10).
# Idempotent and VERIFY-THEN-SKIP: each step reads the live state first and only writes when it differs, so a
# token that can read but not administer buckets (the Logpush token) still passes when the state is right.
# Account: personal/Whisky 11 (69188202efc4df480140dd76545aa3ab).
#
# Tokens (the wrangler OAuth login has NONE of these scopes). Never print them.
#   ~/.whisky-services.env  CF_API_TOKEN           reads R2 buckets + lifecycle; CAN create buckets and PUT lifecycle
#                                                  (steps 1-2 writes). Has no Logs / Notifications scope.
#   ~/.claude/.ebda-logpush-env                    CF_API_TOKEN = Account > Logs > Edit. It can NOT even read R2
#                                                  buckets/lifecycle (error 10000), so steps 1-2 report
#                                                  "cannot verify with this token" and move on to step 3.
#                                                  LOGPUSH_R2_ACCESS_KEY_ID / LOGPUSH_R2_SECRET_ACCESS_KEY = R2 token,
#                                                  Object Read & Write, scoped to bucket ebda-logs ONLY (Logpush
#                                                  writes with it; it is also the read key for verifying objects).
# Usage: bash logpush-setup.sh   (vendored as scripts/foundation/logpush-setup.sh; sources the logpush env file when present; override with
#        EBDA_LOGPUSH_ENV; set CF_API_TOKEN beforehand to use another token)
set -euo pipefail
ENVF="${EBDA_LOGPUSH_ENV:-$HOME/.claude/.ebda-logpush-env}"
# shellcheck source=/dev/null
if [ -z "${CF_API_TOKEN:-}" ] && [ -f "$ENVF" ]; then set -a; . "$ENVF"; set +a; fi
ACC="${CF_ACCOUNT_ID:-69188202efc4df480140dd76545aa3ab}"
API="https://api.cloudflare.com/client/v4/accounts/$ACC"
: "${CF_API_TOKEN:?CF_API_TOKEN not set}"
H=(-H "Authorization: Bearer $CF_API_TOKEN" -H "content-type: application/json")
call() { curl -sS "${H[@]}" "$@"; }
ok() { python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get("success") else (print(json.dumps(d.get("errors")), file=sys.stderr) or 1))'; }

# The Workers whose trace events are shipped (keep in sync with apps/*/wrangler.jsonc "logpush": true; a unit test
# pins the config side, tests/unit/ops/worker-logs-config.test.ts). Besides the nine here: ebda-wa (ebda-whatsapp repo) and
# ebda-os-brain (ebda-foundation os/cloud/brain), both with "logpush": true in their own wrangler.jsonc. The asset-only Workers
# (marketing, help, docs) log nothing while assets answer; they stay listed for their Worker paths.
WORKERS='["ebda-api","ebda-web","ebda-admin","ebda-marketing","ebda-orders","ebda-accounts","ebda-help","ebda-docs","ebda-status","ebda-wa","ebda-os-brain"]'
# CPUTimeMs + WallTimeMs (+ Entrypoint, EventType) give the reader (ebda-foundation os/ops/ebda-logs.mjs) p50/p95 per Worker; a job without them is updated.
FIELDS='["Event","EventTimestampMs","Outcome","Exceptions","Logs","ScriptName","ScriptVersion","DispatchNamespace","CPUTimeMs","WallTimeMs","Entrypoint","EventType"]'

# r2_state <bucket> <rule-id> <prefix> <maxAgeSeconds> -> prints one of: match | nomatch | nobucket | noauth
r2_state() {
  call "$API/r2/buckets/$1/lifecycle" | python3 -c '
import sys,json
d=json.load(sys.stdin)
if not d.get("success"):
    codes=[e.get("code") for e in d.get("errors") or []]
    print("noauth" if 10000 in codes else "nobucket"); sys.exit(0)
rules=(d.get("result") or {}).get("rules") or []
want=(sys.argv[1],sys.argv[2],int(sys.argv[3]))
for r in rules:
    t=(r.get("deleteObjectsTransition") or {}).get("condition") or {}
    if r.get("id")==want[0] and r.get("enabled") and (r.get("conditions") or {}).get("prefix","")==want[1] and t.get("maxAge")==want[2]:
        print("match"); sys.exit(0)
print("nomatch")' "$2" "$3" "$4"
}

echo "1/3 bucket ebda-logs + 30-day lifecycle"
case "$(r2_state ebda-logs expire-30d "" 2592000)" in
  match)  echo "  bucket + lifecycle already in place (expire-30d): skipped" ;;
  noauth) echo "  cannot verify with this token (no R2 access): skipped; verified live 2026-10-24 with the R2-admin token" ;;
  nobucket) call -X POST "$API/r2/buckets" -d '{"name":"ebda-logs"}' | ok; echo "  bucket created"
    call -X PUT "$API/r2/buckets/ebda-logs/lifecycle" \
      -d '{"rules":[{"id":"expire-30d","enabled":true,"conditions":{"prefix":""},"deleteObjectsTransition":{"condition":{"type":"Age","maxAge":2592000}}}]}' | ok
    echo "  lifecycle written: delete after 30 days" ;;
  *) call -X PUT "$API/r2/buckets/ebda-logs/lifecycle" \
      -d '{"rules":[{"id":"expire-30d","enabled":true,"conditions":{"prefix":""},"deleteObjectsTransition":{"condition":{"type":"Age","maxAge":2592000}}}]}' | ok
    echo "  lifecycle written: delete after 30 days" ;;
esac

echo "2/3 ebda-private lifecycle (exports/ 7 days)"
case "$(r2_state ebda-private expire-pdpl-exports-7d "exports/" 604800)" in
  match)  echo "  already in place: skipped" ;;
  noauth) echo "  cannot verify with this token (no R2 access): skipped" ;;
  *) call -X PUT "$API/r2/buckets/ebda-private/lifecycle" -d '{"rules":[
 {"id":"Default Multipart Abort Rule","enabled":true,"conditions":{},"abortMultipartUploadsTransition":{"condition":{"type":"Age","maxAge":604800}}},
 {"id":"expire-pdpl-exports-7d","enabled":true,"conditions":{"prefix":"exports/"},"deleteObjectsTransition":{"condition":{"type":"Age","maxAge":604800}}}]}' | ok
     echo "  written" ;;
esac

echo "3/3 Logpush job ebda-workers-trace"
FILTER="$(python3 -c 'import json,sys; print(json.dumps({"where":{"key":"ScriptName","operator":"in","value":json.loads(sys.argv[1])}}))' "$WORKERS")"
JOB="$(call "$API/logpush/jobs" | python3 -c 'import sys,json; d=json.load(sys.stdin); j=[x for x in (d.get("result") or []) if x.get("name")=="ebda-workers-trace"]; print(json.dumps(j[0]) if j else "")')"
if [ -n "$JOB" ]; then
  ID="$(echo "$JOB" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')"
  if echo "$JOB" | python3 -c 'import sys,json; j=json.load(sys.stdin); want=set(json.loads(sys.argv[1])); got=set(((json.loads(j.get("filter") or "{}").get("where") or {}).get("value")) or []); f=set((j.get("output_options") or {}).get("field_names") or []); sys.exit(0 if want==got and set(json.loads(sys.argv[2]))==f and j.get("enabled") else 1)' "$WORKERS" "$FIELDS"; then
    echo "  job $ID already ships exactly these Workers and fields and is enabled: skipped"
  else
    call -X PUT "$API/logpush/jobs/$ID" -d "$(python3 -c 'import json,sys; j=json.loads(sys.argv[3]); oo=dict(j.get("output_options") or {}); oo["field_names"]=json.loads(sys.argv[2]); print(json.dumps({"enabled":True,"filter":sys.argv[1],"output_options":oo}))' "$FILTER" "$FIELDS" "$JOB")" | ok
    echo "  job $ID filter + fields updated"
  fi
  echo "$JOB" | python3 -c 'import sys,json; j=json.load(sys.stdin); print("  last_complete:", j.get("last_complete"), "| last_error:", j.get("last_error"))'
  exit 0
fi
if [ -z "${LOGPUSH_R2_ACCESS_KEY_ID:-}" ] || [ -z "${LOGPUSH_R2_SECRET_ACCESS_KEY:-}" ]; then
  echo "  SKIPPED: set LOGPUSH_R2_ACCESS_KEY_ID / LOGPUSH_R2_SECRET_ACCESS_KEY (R2 token scoped to ebda-logs)"; exit 3; fi
BODY="$(FILTER="$FILTER" FIELDS="$FIELDS" ACC="$ACC" python3 - <<'PY'
import json,os
print(json.dumps({
 "name":"ebda-workers-trace","dataset":"workers_trace_events","enabled":True,
 "destination_conf":"r2://ebda-logs/workers/{DATE}?account-id=%s&access-key-id=%s&secret-access-key=%s" % (os.environ["ACC"], os.environ["LOGPUSH_R2_ACCESS_KEY_ID"], os.environ["LOGPUSH_R2_SECRET_ACCESS_KEY"]),
 "output_options":{"field_names":json.loads(os.environ["FIELDS"])},
 "filter":os.environ["FILTER"]}))
PY
)"
call -X POST "$API/logpush/jobs" -d "$BODY" | ok
echo "  job created"
