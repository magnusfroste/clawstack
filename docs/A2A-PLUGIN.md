# OpenClaw A2A Gateway Plugin

ClawStack's A2A support depends on the [openclaw-a2a-gateway](https://github.com/win4r/openclaw-a2a-gateway) plugin. This document describes what the plugin does, how ClawStack uses it, and its current capabilities and limitations.

## What it is

The A2A gateway is an OpenClaw plugin (v1.2.0) that exposes a JSON-RPC endpoint on port 18800. It enables an OpenClaw instance to participate in the A2A (Agent-to-Agent) protocol: it can receive tasks from external peers, route them to the internal OpenClaw agent, and return responses.

When ClawStack creates an instance with A2A enabled, it writes the following into `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "a2a-gateway": {
        "enabled": true,
        "config": {
          "server": { "host": "0.0.0.0" },
          "agentCard": { "url": "https://<instance-domain>/a2a/jsonrpc" },
          "routing": { "defaultAgentId": "main" }
        }
      }
    }
  }
}
```

ClawStack's reverse proxy automatically routes all `/a2a/*` and `/.well-known/agent.json` requests to port 18800, so the gateway is reachable over HTTPS without any additional configuration.

## What it supports

| Feature | Supported |
|---|---|
| JSON-RPC 2.0 transport | Yes |
| REST transport | Yes |
| gRPC transport | Yes |
| Agent Card (`/.well-known/agent.json`) | Yes |
| Inbound message routing to agent | Yes |
| Bearer token authentication | Yes (must be configured manually) |
| Peer configuration | Yes (must be configured manually) |
| Audit logging (`a2a-audit.jsonl`) | Yes |
| Durable task store (disk) | Yes |
| DNS-based peer discovery (LAN) | Yes |
| Async task polling (`tasks/get`) | Yes |

## How it routes messages

All inbound messages — regardless of whether they look like skill calls or free-form chat — are serialized to text and sent to the OpenClaw agent via an internal RPC call. The agent's LLM processes the text and returns a response, which the gateway wraps in A2A format and sends back.

```
Inbound message
    ↓
A2A gateway (auth check)
    ↓
Internal RPC: gateway.sendMessage(text)
    ↓
OpenClaw agent LLM
    ↓
Text response
    ↓
A2A-formatted response to caller
```

This means the plugin operates as a **conversational bridge**, not a skill-execution framework. The practical implications:

- **Chat mode works well.** Natural language requests reach the LLM and get natural language responses.
- **Structured responses are best-effort.** If the caller sends a `responseSchema`, the gateway does not enforce it — the LLM may or may not return valid JSON matching the schema.
- **No deterministic skill dispatch.** Naming a skill in the request body does not trigger a separate code path; it is treated as part of the text sent to the LLM.

## Known limitations

**No responseSchema enforcement**
The gateway has no mechanism to validate or coerce the LLM's response against a caller-provided schema. The LLM may follow the schema if it understands the instruction, but this is not guaranteed.

**Security config not set by ClawStack bootstrap**
The bearer token for inbound auth (`security.inboundAuth`, `security.token`) and the peer list (`peers`) are not written by ClawStack's bootstrap function. These must be configured manually in each instance's `openclaw.json` after creation if you want authenticated peer-to-peer communication. Without this, inbound requests without a token may still be accepted, and peers are not pre-configured.

**Peer discovery is manual**
Claws in a swarm do not automatically know about each other. Each instance must have its peers listed in the `config.peers` array. Automated swarm-level peer discovery is not yet implemented in ClawStack.

**Static Agent Card**
The Agent Card is generated from the `agentCard` config in `openclaw.json`. Skills listed in the card are specified manually — there is no dynamic reflection of what the underlying agent can actually do.

## Manual configuration after creation

To enable authenticated A2A and add peers, edit the instance's `openclaw.json` via the ClawStack file browser (Files button on the instance card), or via the terminal:

```json
"a2a-gateway": {
  "enabled": true,
  "config": {
    "server": { "host": "0.0.0.0" },
    "agentCard": {
      "url": "https://<this-instance-domain>/a2a/jsonrpc",
      "skills": [
        { "id": "healthcheck", "name": "healthcheck", "description": "Check agent status" }
      ]
    },
    "routing": { "defaultAgentId": "main" },
    "security": {
      "inboundAuth": "bearer",
      "token": "<generate-a-secure-random-token>"
    },
    "peers": [
      {
        "name": "other-claw",
        "agentCardUrl": "https://other-claw.yourdomain.com/.well-known/agent.json",
        "auth": {
          "type": "bearer",
          "token": "<that-instance's-bearer-token>"
        }
      }
    ]
  }
}
```

Restart the instance after editing for changes to take effect.

## Plugin repository

Source code and full documentation: [https://github.com/win4r/openclaw-a2a-gateway](https://github.com/win4r/openclaw-a2a-gateway)

Issues with the plugin's behavior (routing, auth, task lifecycle) should be reported to that repository. Issues with how ClawStack configures or proxies the plugin should be reported to the ClawStack repository.
