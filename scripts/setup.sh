#!/usr/bin/env bash
# Stand up Hatchery on the currently-logged-in Cloudflare account.
#
#   ./scripts/setup.sh             full run: resources -> migrate -> deploy -> secrets
#   ./scripts/setup.sh resources   create D1 + KV, write their ids into wrangler.jsonc
#   ./scripts/setup.sh migrate     apply D1 migrations (remote)
#   ./scripts/setup.sh deploy      build + deploy hatchery (crons included; ticker worker retired)
#   ./scripts/setup.sh secrets     push secrets from .env.deploy to the worker
#   ./scripts/setup.sh manifest [url]   print the Slack app manifest with the worker URL filled
#                                  in, ready to paste at api.slack.com/apps -> App Manifest
#                                  (url defaults to HATCHERY_PUBLIC_URL from .env.deploy)
#
# Idempotent: re-running reuses existing D1/KV and never clobbers a secret you didn't change.
# Phaseable on purpose — the Slack app needs the worker URL (from `deploy`), but `secrets`
# needs the bot token the Slack app gives you. So: full run, make the Slack app, fill the
# token in .env.deploy, then `./scripts/setup.sh secrets` again.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_FILE=".env.deploy"
DB_NAME="hatchery-skills"
KV_BINDING="SLACK_EVENTS"
WORKER="hatchery"
BULK_FILE=".secrets.bulk.json"

# `manifest` works without .env.deploy (the URL can be passed as an argument); every other
# phase needs the file.
if [ -f "$ENV_FILE" ]; then
  set -a; . "./$ENV_FILE"; set +a
elif [ "${1:-full}" != "manifest" ]; then
  echo "❌ Missing $ENV_FILE — copy .env.deploy.example to .env.deploy and fill it."; exit 1
fi

require_login() {
  wrangler whoami >/dev/null 2>&1 || { echo "❌ Not logged in. Run 'wrangler login' for the TARGET account first."; exit 1; }
}

resources() {
  require_login
  echo "→ D1 '$DB_NAME'"
  wrangler d1 info "$DB_NAME" >/dev/null 2>&1 || wrangler d1 create "$DB_NAME" >/dev/null
  DB_ID="$(wrangler d1 info "$DB_NAME" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.uuid||j.database_id||"")})')"
  [ -n "$DB_ID" ] || { echo "❌ Could not resolve D1 id for $DB_NAME"; exit 1; }

  echo "→ KV '$KV_BINDING'"
  find_kv() { wrangler kv namespace list | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);const m=a.find(n=>n.title&&n.title.endsWith(process.env.KV_BINDING));process.stdout.write(m?m.id:"")})' KV_BINDING="$KV_BINDING"; }
  KV_ID="$(find_kv)"
  [ -n "$KV_ID" ] || { wrangler kv namespace create "$KV_BINDING" >/dev/null; KV_ID="$(find_kv)"; }
  [ -n "$KV_ID" ] || { echo "❌ Could not resolve KV id for $KV_BINDING"; exit 1; }

  # Write the ids into wrangler.jsonc (Flue merges this at build). Field-targeted replace so the
  # JSONC comments survive — we don't reparse/reserialize.
  DB_ID="$DB_ID" KV_ID="$KV_ID" KV_BINDING="$KV_BINDING" node -e '
    const fs=require("fs"), p="wrangler.jsonc"; let t=fs.readFileSync(p,"utf8");
    t=t.replace(/("database_id"\s*:\s*")[^"]*(")/, `$1${process.env.DB_ID}$2`);
    const kv=new RegExp(`("binding"\\s*:\\s*"${process.env.KV_BINDING}"\\s*,\\s*"id"\\s*:\\s*")[^"]*(")`);
    if(!kv.test(t)) throw new Error("KV binding block not found in wrangler.jsonc");
    t=t.replace(kv, `$1${process.env.KV_ID}$2`);
    fs.writeFileSync(p,t);
  '
  echo "✓ wrangler.jsonc → D1=$DB_ID KV=$KV_ID"
}

migrate() {
  require_login
  echo "→ applying D1 migrations (remote)"
  wrangler d1 migrations apply "$DB_NAME" --remote
}

deploy() {
  require_login
  echo "→ build + deploy $WORKER"
  npx flue build --target cloudflare
  wrangler deploy --config "dist/$WORKER/wrangler.json"
  echo "✓ deployed. Use the worker URL printed above for the Slack/Nango/Linear webhooks."
}

secrets() {
  require_login
  if [ -z "${HEARTBEAT_TOKEN:-}" ]; then
    HEARTBEAT_TOKEN="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))')"
    echo "ℹ generated HEARTBEAT_TOKEN — add it to $ENV_FILE to keep it stable across runs."
  fi
  # Bulk file holds only the keys that are actually set (blanks skipped → feature stays inert).
  HEARTBEAT_TOKEN="$HEARTBEAT_TOKEN" node -e '
    const keys=["ZAI_API_KEY","HEARTBEAT_TOKEN","SLACK_SIGNING_SECRET","SLACK_BOT_TOKEN_DEFAULT","KNOWN_TEAM_IDS","SLACK_BOT_ID","SLACK_DEFAULT_TOKEN_REF","ADMIN_CONNECTIONS_TOKEN","NANGO_SECRET_KEY","NANGO_WEBHOOK_SECRET","LINEAR_WEBHOOK_SECRET","TRIGGER_SECRET_KEY","TRIGGER_API_URL","AGENT_RUNNER_TOKEN","HATCHERY_PUBLIC_URL","RUNNER_GITHUB_PAT_TEMP","LINEAR_AGENT_PROJECTS","WORKBENCH_RUNNER_TOKEN","CODING_RUNNER_URL"];
    const out={}; for(const k of keys){const v=process.env[k]; if(v&&String(v).trim()) out[k]=String(v);}
    require("fs").writeFileSync(process.env.BULK_FILE, JSON.stringify(out));
  ' BULK_FILE="$BULK_FILE"
  chmod 600 "$BULK_FILE"
  trap 'rm -f "$BULK_FILE"' EXIT
  local n; n="$(node -e 'process.stdout.write(String(Object.keys(require("./"+process.env.BULK_FILE)).length))' BULK_FILE="$BULK_FILE")"
  echo "→ pushing $n secrets to $WORKER"
  wrangler secret bulk "$BULK_FILE"
  rm -f "$BULK_FILE"; trap - EXIT
  echo "✓ secrets set."
}

manifest() {
  local url="${1:-${HATCHERY_PUBLIC_URL:-}}"
  [ -n "$url" ] || { echo "❌ No worker URL. Set HATCHERY_PUBLIC_URL in $ENV_FILE or pass one: ./scripts/setup.sh manifest https://hatchery.<account>.workers.dev"; exit 1; }
  # Parse → substitute → reprint: validates the JSON and drops the repo-reader _comment so the
  # output is exactly what api.slack.com/apps -> App Manifest expects.
  URL="${url%/}" node -e '
    const fs = require("fs");
    const m = JSON.parse(fs.readFileSync("slack-app.manifest.json", "utf8"));
    delete m._comment;
    process.stdout.write(JSON.stringify(m, null, 2).replaceAll("https://REPLACE-WITH-YOUR-WORKER-URL", process.env.URL) + "\n");
  '
}

checklist() {
  cat <<'EOF'

──────────────────────────────────────────────────────────────────────────
✅ Cloudflare side is live. Wire the SaaS side (can't be automated), using the
   worker URL printed by the deploy step above as <URL>:

  [ ] Slack   ./scripts/setup.sh manifest <URL>  prints paste-ready JSON for
              api.slack.com/apps → From a manifest (new app) or App Manifest (existing app —
              re-applying a scope change also needs Install App → Reinstall to Workspace)
              put the Bot User OAuth Token (xoxb-…) in .env.deploy as SLACK_BOT_TOKEN_DEFAULT
              put the bot user id in SLACK_BOT_ID, your team id in KNOWN_TEAM_IDS
              then: ./scripts/setup.sh secrets
  [ ] Nango   create integrations named EXACTLY  github  linear  notion
              webhook URL → <URL>/nango/webhook
	  [ ] Linear  webhook URL → <URL>/linear/webhook ; enable Issue + Comment events
	  [ ] Runner  create/deploy the Trigger.dev run-coding-task ; set TRIGGER_SECRET_KEY,
	              AGENT_RUNNER_TOKEN, HATCHERY_PUBLIC_URL, RUNNER_GITHUB_PAT_TEMP ; re-run secrets
──────────────────────────────────────────────────────────────────────────
EOF
}

case "${1:-full}" in
  resources) resources ;;
  migrate)   migrate ;;
  deploy)    deploy ;;
  secrets)   secrets ;;
  manifest)  manifest "${2:-}" ;;
  full)      resources; migrate; deploy; secrets; checklist ;;
  *) echo "usage: $0 [full|resources|migrate|deploy|secrets|manifest [url]]"; exit 1 ;;
esac
