#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="$(dirname "$0")/docker-compose.yml"
PAPERCLIP_URL="https://boss.froste.eu"

# DB connection (via paperclip-db container)
DB_EXEC="docker exec clawstack-paperclip-db-1 psql -U paperclip -d paperclip"

CONNECT_STATE_DIR="/opt/clawstack/paperclip-connect"

usage() {
  echo "Usage: $0 {start|stop|restart|status|fix|connect|finalize|logs|help}"
  echo ""
  echo "  start             - Start Paperclip + its database"
  echo "  stop              - Stop Paperclip (database keeps its data)"
  echo "  restart           - Restart Paperclip"
  echo "  status            - Show running containers, API health, agent keys and adapter config"
  echo "  fix               - Re-apply known integration fixes (token + channel) — idempotent"
  echo "  connect <name> <invite-token>  - Submit join request for a Claw"
  echo "  finalize <name>   - Complete onboarding after Paperclip board approval"
  echo "  logs              - Tail Paperclip logs"
  echo "  help              - Show this help"
  exit 1
}

cmd_help() {
  usage_no_exit() {
    echo "Usage: $0 {start|stop|restart|status|fix|logs|help}"
    echo ""
    echo "  start    - Start Paperclip + its database"
    echo "  stop     - Stop Paperclip (database keeps its data)"
    echo "  restart  - Restart Paperclip"
    echo "  status   - Show running containers, API health, agent keys and adapter config"
    echo "  fix      - Re-apply known integration fixes (token + channel) — idempotent"
    echo "  logs     - Tail Paperclip logs"
    echo "  help     - Show this help plus notes on adding Claws to Paperclip"
  }
  usage_no_exit
  cat <<'NOTES'

=== Adding a Claw to Paperclip ===

1. Create a Claw instance in the ClawStack portal (pick a role preset).
2. In Paperclip UI (https://boss.froste.eu), go to Company Settings.
3. In the Invites section, click "Generate OpenClaw Invite Prompt".
4. Copy the generated prompt and paste it into the Claw's chat.
   (If it stalls, follow up: "How is onboarding going? Continue setup now.")
5. Back in Paperclip, approve the join request.
6. The Claw now appears as an agent in Paperclip and can receive tasks.
7. Run ./paperclip.sh fix to ensure the channel fix is applied to the new agent.

=== Known integration quirks ===

Bug 1 — "Channel is required" (Paperclip → OpenClaw)
  Paperclip's openclaw_gateway adapter sends the agent WS call without a
  channel parameter. OpenClaw requires one. Fix: payloadTemplate with
  channel: "heartbeat" is added to every openclaw_gateway agent by ./fix.

Bug 2 — 401 Unauthorized (OpenClaw → Paperclip)
  The token OpenClaw saves after the claim step can end up revoked in
  Paperclip's DB if the invite flow is re-run or keys are rotated.
  Fix: ./fix un-revokes the token that matches OpenClaw's local key file.
  If you re-run the invite flow for an existing Claw, run ./fix again.

=== Future plan: click-and-run ===

When ClawStack portal creates a Claw with a role preset it could:
  1. Call POST /api/agents in Paperclip to register the agent automatically
  2. Run the invite/claim flow via API to deliver the API key to the Claw
  3. Apply the payloadTemplate fix in the same step
This would make adding a Claw to Paperclip a zero-click operation.
For now: use the invite flow above and run ./paperclip.sh fix after.

NOTES
}

cmd_start() {
  echo "Starting Paperclip..."
  docker compose -f "$COMPOSE_FILE" up -d paperclip-db paperclip
  echo ""
  echo "Waiting for Paperclip to be ready..."
  for i in $(seq 1 20); do
    if docker exec clawstack-paperclip-1 sh -c 'curl -sf http://localhost:3100/api/health' 2>/dev/null | grep -q '"status":"ok"'; then
      echo "Paperclip is up: $PAPERCLIP_URL"
      cmd_fix
      return
    fi
    sleep 2
  done
  echo "WARNING: Paperclip did not become ready in time. Check: docker logs clawstack-paperclip-1"
}

cmd_stop() {
  echo "Stopping Paperclip..."
  docker compose -f "$COMPOSE_FILE" stop paperclip
  echo "Done. Database is still running (data preserved)."
}

cmd_restart() {
  cmd_stop
  sleep 2
  docker compose -f "$COMPOSE_FILE" start paperclip
  echo "Paperclip restarted."
}

cmd_status() {
  echo "=== Paperclip ==="
  docker ps --filter "name=clawstack-paperclip" --format "  {{.Names}}\t{{.Status}}" 2>/dev/null
  local health
  health=$(docker exec clawstack-paperclip-1 sh -c \
    'curl -sf http://localhost:3100/api/health 2>/dev/null' 2>/dev/null \
    | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const h=JSON.parse(d);process.stdout.write('  API: '+h.status+' ('+h.deploymentMode+')')}catch{process.stdout.write('  API: unreachable')}})" 2>/dev/null \
    || echo "  API: unreachable")
  echo "$health"
  echo ""

  echo "=== Claws ==="
  # Get all clawstack OpenClaw containers
  local claws
  claws=$(docker ps --filter "name=clawstack-claw" --format "{{.Names}}" 2>/dev/null)

  if [ -z "$claws" ]; then
    echo "  No Claw containers running."
  else
    # Get Paperclip agent list for cross-reference
    local pp_agents
    pp_agents=$($DB_EXEC -tAc \
      "SELECT name, adapter_config->>'url', last_heartbeat_at
       FROM agents WHERE adapter_type = 'openclaw_gateway';" 2>/dev/null)

    while IFS= read -r container; do
      local claw_name="${container#clawstack-}"
      local status
      status=$(docker inspect "$container" --format "{{.State.Status}}" 2>/dev/null)

      # Check if API key is saved in container
      local pp_status="not connected"
      if docker exec "$container" test -f /home/node/.openclaw/workspace/paperclip-claimed-api-key.json 2>/dev/null; then
        pp_status="connected"
      fi

      # Check last heartbeat from Paperclip DB
      local heartbeat=""
      local hb_at
      hb_at=$($DB_EXEC -tAc \
        "SELECT to_char(now() - last_heartbeat_at, 'HH24h MIm') || ' ago'
         FROM agents WHERE adapter_type = 'openclaw_gateway'
           AND adapter_config->>'url' LIKE '%clawstack-${claw_name}%'
           AND last_heartbeat_at IS NOT NULL
         ORDER BY last_heartbeat_at DESC LIMIT 1;" 2>/dev/null | xargs)
      [ -n "$hb_at" ] && heartbeat=" | heartbeat: $hb_at"

      printf "  %-30s  %-8s  paperclip: %-15s%s\n" \
        "$container" "$status" "$pp_status" "$heartbeat"
    done <<< "$claws"
  fi

  echo ""
  echo "=== Paperclip agents ==="
  $DB_EXEC -c \
    "SELECT DISTINCT ON (adapter_config->>'url') name,
            role,
            adapter_config->>'url' AS gateway_url,
            CASE WHEN last_heartbeat_at IS NULL THEN 'never'
                 ELSE to_char(now() - last_heartbeat_at, 'HH24h MIm') || ' ago'
            END AS last_heartbeat
     FROM agents WHERE adapter_type = 'openclaw_gateway'
     ORDER BY adapter_config->>'url', last_heartbeat_at DESC NULLS LAST;" 2>/dev/null || echo "  (none)"
}

cmd_fix() {
  echo "=== Applying integration fixes ==="

  # Fix 1: Un-revoke the token that OpenClaw has stored locally
  ROWS=$($DB_EXEC -tAc \
    "UPDATE agent_api_keys SET revoked_at = NULL
     WHERE key_hash = '660c9c30b5d47cb01c32765aaad8382afe7ade4b765514502ca835f4dcb7585b'
       AND revoked_at IS NOT NULL
     RETURNING id;" 2>/dev/null | wc -l)
  if [ "$ROWS" -gt 0 ]; then
    echo "  [fix 1] Token un-revoked."
  else
    echo "  [fix 1] Token already active, no change."
  fi

  # Fix 2: Ensure payloadTemplate channel is set on every openclaw_gateway agent
  ROWS=$($DB_EXEC -tAc \
    "UPDATE agents
     SET adapter_config = adapter_config || '{\"payloadTemplate\": {\"channel\": \"heartbeat\"}}'::jsonb
     WHERE adapter_type = 'openclaw_gateway'
       AND (adapter_config->'payloadTemplate' IS NULL
            OR adapter_config->'payloadTemplate'->>'channel' IS NULL)
     RETURNING id;" 2>/dev/null | wc -l)
  if [ "$ROWS" -gt 0 ]; then
    echo "  [fix 2] payloadTemplate channel set on $ROWS agent(s)."
  else
    echo "  [fix 2] payloadTemplate channel already set, no change."
  fi

  # Fix 3: Install Claude CLI if not present
  if docker exec clawstack-paperclip-1 sh -c 'which claude > /dev/null 2>&1'; then
    echo "  [fix 3] Claude CLI already installed, no change."
  else
    echo "  [fix 3] Installing Claude CLI..."
    docker exec clawstack-paperclip-1 sh -c 'npm install -g @anthropic-ai/claude-code' > /dev/null 2>&1 \
      && echo "  [fix 3] Claude CLI installed." \
      || echo "  [fix 3] WARNING: Claude CLI install failed."
  fi

  # Fix 4: Ensure allow_remote_control is enabled for Claude CLI bash access
  REMOTE_OK=$(docker exec clawstack-paperclip-1 sh -c \
    'node -e "try{const p=require(process.env.HOME+\"/.claude/policy-limits.json\");process.stdout.write(String(p.restrictions?.allow_remote_control?.allowed))}catch{process.stdout.write(\"missing\")}"' 2>/dev/null)
  if [ "$REMOTE_OK" = "true" ]; then
    echo "  [fix 4] allow_remote_control already enabled, no change."
  else
    docker exec clawstack-paperclip-1 sh -c \
      'mkdir -p ~/.claude && printf '"'"'{"restrictions":{"allow_remote_control":{"allowed":true}}}'"'"' > ~/.claude/policy-limits.json' \
      && echo "  [fix 4] allow_remote_control enabled." \
      || echo "  [fix 4] WARNING: Could not write policy-limits.json."
  fi

  # Fix 5: Write private LLM env vars to ~/.bashrc if configured
  CLAUDE_BASE_URL_VAL=$(docker exec clawstack-paperclip-1 sh -c 'printf "%s" "${CLAUDE_BASE_URL:-}"' 2>/dev/null)
  CLAUDE_AUTH_TOKEN_VAL=$(docker exec clawstack-paperclip-1 sh -c 'printf "%s" "${CLAUDE_AUTH_TOKEN:-}"' 2>/dev/null)
  CLAUDE_MODEL_VAL=$(docker exec clawstack-paperclip-1 sh -c 'printf "%s" "${CLAUDE_MODEL:-}"' 2>/dev/null)

  if [ -n "$CLAUDE_BASE_URL_VAL" ] && [ -n "$CLAUDE_AUTH_TOKEN_VAL" ] && [ -n "$CLAUDE_MODEL_VAL" ]; then
    ALREADY=$(docker exec clawstack-paperclip-1 sh -c 'grep -q "ANTHROPIC_BASE_URL" ~/.bashrc 2>/dev/null && echo yes || echo no')
    if [ "$ALREADY" = "yes" ]; then
      echo "  [fix 5] Private LLM env vars already in ~/.bashrc, no change."
    else
      docker exec clawstack-paperclip-1 sh -c "cat >> ~/.bashrc <<'EOF'

# Private LLM for Claude Code CLI
export ANTHROPIC_BASE_URL=\"${CLAUDE_BASE_URL_VAL}\"
export ANTHROPIC_AUTH_TOKEN=\"${CLAUDE_AUTH_TOKEN_VAL}\"
export ANTHROPIC_API_KEY=\"\"
export CLAUDE_DEFAULT_MODEL=\"${CLAUDE_MODEL_VAL}\"
EOF"
      echo "  [fix 5] Private LLM env vars written to ~/.bashrc (model: ${CLAUDE_MODEL_VAL})."
    fi
  else
    echo "  [fix 5] No private LLM configured (CLAUDE_BASE_URL/AUTH_TOKEN/MODEL not set), skipping."
  fi

  echo "=== Fixes done ==="
}

cmd_connect() {
  local claw_name="${1:-}"
  local invite_token="${2:-}"
  [ -z "$claw_name" ] || [ -z "$invite_token" ] && {
    echo "Usage: $0 connect <claw-name> <invite-token>"
    echo "  invite-token: the pcp_invite_... code from Paperclip UI → Company Settings → Invites"
    exit 1
  }

  local container="clawstack-${claw_name}"
  docker inspect "$container" > /dev/null 2>&1 || { echo "ERROR: Container $container not found"; exit 1; }

  echo "Getting gateway token from $claw_name..."
  local gw_token
  gw_token=$(docker exec "$container" node -e \
    "const c=require('/home/node/.openclaw/openclaw.json'); process.stdout.write(c.gateway.auth.token)" 2>/dev/null)
  [ -z "$gw_token" ] && { echo "ERROR: Could not read gateway token from $container"; exit 1; }

  local agent_name
  agent_name="$(echo "${claw_name:0:1}" | tr '[:lower:]' '[:upper:]')${claw_name:1}"

  local body
  body=$(node -e "
    const [,, token, name, agentName] = process.argv;
    process.stdout.write(JSON.stringify({
      requestType: 'agent',
      agentName: agentName,
      adapterType: 'openclaw_gateway',
      capabilities: 'OpenClaw agent - ClawStack instance ' + name,
      agentDefaultsPayload: {
        url: 'ws://clawstack-' + name + ':18789',
        paperclipApiUrl: 'http://paperclip:3100',
        headers: { 'x-openclaw-token': token },
        waitTimeoutMs: 120000,
        sessionKeyStrategy: 'issue',
        role: 'operator',
        scopes: ['operator.admin'],
      }
    }));
  " "$gw_token" "$claw_name" "$agent_name")

  echo "Submitting join request to Paperclip..."
  local response
  response=$(curl -fsS -X POST "$PAPERCLIP_URL/api/invites/${invite_token}/accept" \
    -H "Content-Type: application/json" \
    -d "$body") || { echo "ERROR: Join request failed"; exit 1; }

  local request_id claim_secret
  request_id=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).id)" "$response")
  claim_secret=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).claimSecret)" "$response")

  mkdir -p "$CONNECT_STATE_DIR"
  node -e "
    const [,, f, requestId, claimSecret, clawName, gwToken] = process.argv;
    require('fs').writeFileSync(f, JSON.stringify({requestId, claimSecret, clawName, gwToken}));
  " "${CONNECT_STATE_DIR}/${claw_name}.json" "$request_id" "$claim_secret" "$claw_name" "$gw_token"

  echo ""
  echo "✓ Join request submitted (id: $request_id)"
  echo ""
  echo "  → Go to $PAPERCLIP_URL → Company Settings and approve '${agent_name}'"
  echo ""
  echo "  → Then run: $0 finalize $claw_name"
}

cmd_finalize() {
  local claw_name="${1:-}"
  [ -z "$claw_name" ] && { echo "Usage: $0 finalize <claw-name>"; exit 1; }

  local state_file="${CONNECT_STATE_DIR}/${claw_name}.json"
  [ ! -f "$state_file" ] && { echo "ERROR: No pending connect for '$claw_name'. Run connect first."; exit 1; }

  local request_id claim_secret gw_token
  request_id=$(node -e "process.stdout.write(require('$state_file').requestId)")
  claim_secret=$(node -e "process.stdout.write(require('$state_file').claimSecret)")
  gw_token=$(node -e "process.stdout.write(require('$state_file').gwToken)")
  local container="clawstack-${claw_name}"

  echo "Claiming API key..."
  local claim_resp
  claim_resp=$(curl -fsS -X POST "$PAPERCLIP_URL/api/join-requests/${request_id}/claim-api-key" \
    -H "Content-Type: application/json" \
    -d "{\"claimSecret\":\"${claim_secret}\"}") || { echo "ERROR: Claim failed — board approval pending?"; exit 1; }

  local api_token agent_id
  api_token=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).token)" "$claim_resp")
  agent_id=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).agentId)" "$claim_resp")

  echo "  Saving API key to container..."
  docker exec "$container" sh -c "
    printf '%s' '{\"token\":\"${api_token}\",\"agentId\":\"${agent_id}\"}' \
      > /home/node/.openclaw/workspace/paperclip-claimed-api-key.json
    chmod 600 /home/node/.openclaw/workspace/paperclip-claimed-api-key.json
    chown node:node /home/node/.openclaw/workspace/paperclip-claimed-api-key.json
  "

  echo "  Installing Paperclip skill..."
  docker exec "$container" sh -c "
    mkdir -p /home/node/.openclaw/skills/paperclip
    curl -fsS '${PAPERCLIP_URL}/api/skills/paperclip' > /home/node/.openclaw/skills/paperclip/SKILL.md
    sed -i '1s|^|PAPERCLIP_API_URL: http://paperclip:3100\n\n|' /home/node/.openclaw/skills/paperclip/SKILL.md
    chown -R node:node /home/node/.openclaw/skills
  "

  echo "  Approving device pairing in OpenClaw..."
  docker exec --user node "$container" sh -c '
    openclaw devices list > /dev/null 2>&1
    openclaw devices approve --latest 2>&1
  ' && echo "  Device paired." || echo "  WARNING: Device approval failed — retry task in Paperclip to trigger pairing."

  echo "  Applying Paperclip integration fixes..."
  cmd_fix

  rm -f "$state_file"
  echo ""
  echo "✓ ${claw_name} is connected to Paperclip and ready to receive tasks."
}

cmd_logs() {
  docker logs -f clawstack-paperclip-1
}

[ $# -lt 1 ] && usage

case "$1" in
  start)    cmd_start ;;
  stop)     cmd_stop ;;
  restart)  cmd_restart ;;
  status)   cmd_status ;;
  fix)      cmd_fix ;;
  connect)  cmd_connect "${2:-}" "${3:-}" ;;
  finalize) cmd_finalize "${2:-}" ;;
  logs)     cmd_logs ;;
  help)     cmd_help ;;
  *)        usage ;;
esac
