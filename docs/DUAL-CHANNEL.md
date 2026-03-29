# Dual-Channel Communication

Every A2A-enabled OpenClaw instance in ClawStack exposes two communication channels. They serve different coordination patterns and should not be treated as interchangeable.

## The two channels

### Channel 1 — OpenResponses (`POST /v1/responses`)

**Port:** 18789 (same as the UI)
**Auth:** `x-openclaw-token` header (the gateway token shown on the instance card in ClawStack portal)
**Format:** OpenAI Responses API-compatible
**Pattern:** Top-down. The caller is the orchestrator, Claw is the worker.

The message goes directly to the agent's LLM with full context — workspace files, identity, tools, permissions. No intermediate serialization. The caller defines the expected output format in the prompt and gets a structured response back.

```
FlowWink/Paperclip
    ↓ POST https://claw-qa.yourdomain.com/v1/responses
    {
      "input": "Audit the booking flow on demo.flowwink.com.
                Return { findings: [{ severity, location, description }] }",
      "model": "main"
    }
    ↓
Claw's LLM (with full agent context)
    ↓
{ findings: [...] }
```

**Use this channel when:**
- You are delegating a task to Claw (QA audit, code review, research brief)
- You want a structured, deterministic response
- You are the initiator and Claw is the executor
- You need the caller's responseSchema to be respected

### Channel 2 — A2A (`/a2a/jsonrpc`, `/.well-known/agent.json`)

**Port:** 18800
**Auth:** Bearer token (configured in `openclaw.json` security section)
**Format:** JSON-RPC 2.0 / A2A protocol
**Pattern:** Peer-to-peer. Either side can initiate.

Messages are routed through the A2A gateway plugin, which serializes them to text before reaching the LLM. Structured response contracts are best-effort — the LLM may or may not follow a responseSchema.

```
Claw A ←→ Claw B
"I've finished the QA audit, here's a summary for your report."
"Acknowledged. I'll update the client brief."
```

**Use this channel when:**
- Two agents are collaborating as peers (neither is the boss)
- Communication is conversational or exploratory
- Either side may initiate
- You want the swarm discovery model (Agent Card, peer registry)

## Shared infrastructure

Both channels use the same per-instance credentials managed by ClawStack:

| Credential | Where it lives | Used by |
|---|---|---|
| Gateway token | SQLite `instances.token`, shown in portal | OpenResponses (`x-openclaw-token`) |
| A2A bearer token | `openclaw.json` security section | A2A inbound auth |
| Instance domain | SQLite `instances.domain` | Both channels |

ClawStack's reverse proxy routes traffic automatically:
- `/a2a/*` and `/.well-known/agent.json` → port 18800 (A2A)
- Everything else → port 18789 (UI + OpenResponses)

No additional proxy configuration is needed when adding a new channel consumer.

## Decision guide

| Scenario | Channel |
|---|---|
| FlowWink asks Claw to run a QA test | OpenResponses |
| FlowWink asks Claw to audit a page and return structured findings | OpenResponses |
| Paperclip delegates a task to Claw | OpenResponses |
| Claw A and Claw B coordinate on a shared objective | A2A |
| FlowWink and Claw exchange context conversationally | A2A |
| Claw notifies a peer that work is done | A2A |

## Why not always use OpenResponses?

OpenResponses is a synchronous call — the caller blocks until Claw responds. For long-running tasks (a full site audit can take minutes) this may time out depending on the calling infrastructure. A2A's async task lifecycle (submitted → working → completed with polling) is better suited for tasks where duration is unpredictable.

For short, scoped tasks with a clear contract, OpenResponses is simpler and more reliable.

## Confirmed working

Tested 2026-03-28 against clawone (froste.eu) ↔ FlowWink/FlowPilot:

| Channel | Tests | Avg response |
|---|---|---|
| `/v1/responses` | 6/6 ✅ (ping, web fetch, code review, JSON extraction, OWASP, creative writing) | 9.4s |
| A2A | 3/3 ✅ (workspace context, web search, system check) | 12.3s |

Key findings:
- `/v1/responses` uses `Authorization: Bearer <gateway-token>` — not the A2A bearer token
- `model` field must be `"openclaw"` (not `"default"`, `"main"`, or `"openclaw/main"`)
- A2A tasks show up in metrics; `/v1/responses` calls do not — this is by design (synchronous, no task lifecycle)
- `gateway.http.endpoints.responses.enabled: true` must be set in `openclaw.json` — it is **not** on by default

## Reference

- FlowWink dual-channel implementation: [github.com/magnusfroste/flowwink](https://github.com/magnusfroste/flowwink)
- OpenClaw A2A gateway plugin: [github.com/win4r/openclaw-a2a-gateway](https://github.com/win4r/openclaw-a2a-gateway)
- OpenClaw OpenResponses API: `POST /v1/responses` on port 18789
