# Paperclip ↔ OpenClaw Integration — Identified Bugs

## Context

Both Paperclip (`reeoss/paperclipai-paperclip:latest`) and OpenClaw (`ghcr.io/openclaw/openclaw:2026.3.24`) are published images with a built-in integration. The `openclaw_gateway` adapter ships inside Paperclip. An onboarding flow exists (invite prompt → paste into OpenClaw → approve join → claim API key). **This should work out of the box. It does not.**

The setup in ClawStack uses both images on the same Docker network (`clawstack`). What follows are the bugs encountered when trying to get task delegation working: Paperclip assigns a task to OpenClaw, OpenClaw executes it, OpenClaw reports back.

---

## Bug 1: "Channel is required (no configured channels detected)"

**Direction:** Paperclip → OpenClaw
**Transport:** WebSocket (`ws://clawstack-clawone:18789`)
**Symptom:** Every `agent` WS call from Paperclip's adapter returns:
```
errorCode=INVALID_REQUEST
errorMessage=Error: Channel is required (no configured channels detected)
```

**Root cause:** Paperclip's `openclaw_gateway` adapter sends the `agent` call without a `channel` parameter. OpenClaw requires one. The OpenClaw web UI sends `channel: "webchat"` — those calls succeed. Paperclip's background calls send nothing — they fail.

**Evidence:**
- Successful calls from UI: `[ws] ⇄ res ✓ agent 76ms runId=...`
- Failed calls from Paperclip: `[ws] ⇄ res ✗ agent 50ms errorCode=INVALID_REQUEST`

**Why this is an integration bug in the published images:** The adapter (`@paperclipai/adapter-openclaw-gateway`) does not include a `channel` value in `agentParams` by default, and there is no `channel` field in `buildOpenClawGatewayConfig()`. Either:
- The adapter should send a default channel (e.g. `heartbeat`), or
- The onboarding flow should configure `payloadTemplate: {"channel": "heartbeat"}`, or
- OpenClaw should not require `channel` for operator-role WS connections

**Proposed fix:** Add `payloadTemplate: {"channel": "heartbeat"}` to the `adapter_config` in Paperclip's DB for the openclaw agent.

---

## Bug 2: Revoked API token — OpenClaw cannot authenticate to Paperclip

**Direction:** OpenClaw → Paperclip
**Transport:** HTTP (`http://paperclip:3100`)
**Symptom:** Every `GET /api/agents/me` call from OpenClaw returns `401 Unauthorized`.

**Root cause:** The token stored in OpenClaw at `~/.openclaw/workspace/paperclip-claimed-api-key.json` is:
```json
{"token": "pcp_a8494d88f6bee89cbeabd0ccade3dba31167edd22f418f62"}
```
SHA-256 of this token = `660c9c30b5d47cb01c32765aaad8382afe7ade4b765514502ca835f4dcb7585b`

In Paperclip's `agent_api_keys` table, this hash exists but has `revoked_at` set. The active key (hash `6368438e...`, `revoked_at = NULL`) has `last_used_at = NULL` — it was never actually used, meaning it was created separately from the claim flow and the token was never delivered to OpenClaw.

**Why this is an integration bug:** The onboarding flow is supposed to be:
1. Paperclip generates invite prompt
2. User pastes into OpenClaw
3. OpenClaw submits join request
4. User approves in Paperclip
5. OpenClaw automatically claims API key → token written to `paperclip-claimed-api-key.json`

This flow is not documented anywhere visible to a ClawStack operator. The only documentation is inside the Paperclip container at `/app/doc/OPENCLAW_ONBOARDING.md` and `/app/server/node_modules/@paperclipai/adapter-openclaw-gateway/doc/ONBOARDING_AND_TEST_PLAN.md`. There is no external documentation explaining that manual DB setup will not work — the claim step must happen through the invite flow.

**The naming confusion the user encountered:** The JSON uses `"token"` as the key. OpenClaw's wake text instructs the agent to load `PAPERCLIP_API_KEY` from this file. At some point the key was renamed between `"apiKey"` and `"token"` in one of the images, and the other side didn't follow — making the claim/read cycle silently fail.

**Proposed fix (quick):** Un-revoke the existing token in Paperclip's DB:
```sql
UPDATE agent_api_keys
SET revoked_at = NULL
WHERE key_hash = '660c9c30b5d47cb01c32765aaad8382afe7ade4b765514502ca835f4dcb7585b';
```

**Proposed fix (proper):** Re-run the full onboarding flow — generate a fresh invite prompt in Paperclip UI, paste into OpenClaw, approve join, let OpenClaw claim a new token.

---

## Summary

| # | Direction | Error | Root cause | Fix |
|---|---|---|---|---|
| 1 | Paperclip → OpenClaw | `Channel is required` | Adapter sends no `channel` in `agent` WS call | Add `payloadTemplate: {"channel": "heartbeat"}` to adapter config |
| 2 | OpenClaw → Paperclip | `401 Unauthorized` | Token in OpenClaw workspace is revoked in Paperclip DB | Un-revoke token in DB or re-run invite/claim flow |

## Notes on out-of-the-box expectation

This integration ships as part of both images. A reasonable operator expectation is that connecting two Docker containers on the same network, pointing one at the other, should result in a working integration. Instead:

- The only working setup path is an invite prompt flow that is documented only inside the container filesystem
- Manual configuration (setting URLs, tokens, adapter config in DB) does not work because the claim step is not replaceable — the token must be delivered through the claim endpoint
- The `channel` requirement in OpenClaw is not documented in the adapter README or in any OpenClaw-side config guide
- Both bugs manifest as silent failures (401 / INVALID_REQUEST) with no actionable error message for the operator

These are integration contract failures between two products that claim to support each other.
