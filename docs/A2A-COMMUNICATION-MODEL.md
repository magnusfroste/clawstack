# A2A Communication Model

This document describes the agent-to-agent communication model used in ClawStack and the reasoning behind design decisions. It is intended for developers integrating A2A peers or extending the swarm.

## Core principle: Caller defines the contract

The sender specifies what it wants, in what format, and on what terms. The receiver either delivers — or declines. No prior bilateral contract is needed.

This mirrors how tools like Claude Code, Kilo, Roo, and Cline communicate with LLMs: the caller sends a prompt that includes a strict output schema, and the model either returns valid JSON matching that schema, or it doesn't. The caller owns the contract definition.

Applied to agent-to-agent communication:

```
Claw A → "Can you return the current price for 1000 units of SKU-42?
           Respond as: { price_cents: number, currency: string, lead_days: number }
           If you cannot fulfill this, respond with { available: false }."

Claw B → { price_cents: 4500, currency: "SEK", lead_days: 14 }
       OR { available: false }
```

This is structurally identical to an RFQ (Request for Quote) — a pattern that has existed in commerce for centuries, now applied to agents. The buyer sets the terms; the supplier accepts or declines.

## Why not server-defined schemas?

The alternative — where the server (receiver) publishes a fixed `outputSchema` and all callers must adapt — works well within a controlled system. It is how MCP (Model Context Protocol) operates: the tool manifest defines inputs and outputs, and the caller conforms.

A2A spans organizational boundaries. You cannot require 20 independent vendors to publish a schema in your preferred format. But you can ask them to fulfill a request in your format — and they can say no if they can't.

| Approach | Works between | Guarantees | Flexibility |
|---|---|---|---|
| Server-defined schema (MCP-style) | Systems you control | High | Low |
| Caller-defined contract (A2A RFQ) | Any peer | Best-effort | High |
| Free chat, no schema | Any peer | None | Maximum |

In practice, caller-defined contracts sit in the middle: you get structured, actionable responses from well-behaved peers, and you get graceful declines from peers that can't comply. Free chat remains a valid fallback for exploratory or conversational exchanges.

## Postel's Law

The design follows [Postel's Law](https://en.wikipedia.org/wiki/Robustness_principle) (the Robustness Principle, originally from the TCP specification):

> Be conservative in what you send, be liberal in what you accept.

In A2A terms:
- **Conservative in sending:** Include a clear `responseSchema` or natural-language format instruction. Be precise about what you need.
- **Liberal in accepting:** Handle varied response formats gracefully. Parse what you can; don't break on extra fields or minor deviations.

## The open debate

The A2A community has not yet settled on how structured contracts should be formally established. Two positions exist:

**Position A — Server-driven (MCP-style):** Publish skills with `inputSchema` and `outputSchema` in the Agent Card. Callers discover and call skills like API endpoints. Deterministic, but rigid.

**Position B — Caller-driven (RFQ-style):** The caller embeds its format requirements in the message. The receiver's LLM attempts to comply. Flexible, but best-effort.

Google's A2A specification (as of early 2026) does not mandate either approach. Both are valid depending on the trust relationship between peers.

ClawStack takes no dogmatic position. The infrastructure supports both:
- Agent Cards expose skills with schemas for peers that prefer server-driven discovery
- Inbound messages accept a `responseSchema` field for peers that prefer caller-driven contracts
- Plain chat messages work as a fallback with no schema on either side

## Dual-mode operation

Every A2A-enabled Claw instance handles two message types:

**Skill mode** — structured execution
The caller names a skill and provides arguments matching the skill's `inputSchema`. The response is a structured artifact. Deterministic when the skill is implemented as code; best-effort when routed through the agent's LLM.

```json
{
  "skill": "site_audit",
  "arguments": { "url": "https://example.com", "checks": ["seo", "perf"] },
  "responseSchema": { "type": "object", "properties": { "score": { "type": "number" } } }
}
```

**Chat mode** — conversational exchange
Free-form text, optionally with a `responseSchema`. The receiver's LLM handles the message and attempts to return the requested format.

```json
{
  "message": "Summarize the last 5 customer sessions. Respond as a JSON array of { session_id, summary }.",
  "responseSchema": { "type": "array" }
}
```

The A2A gateway auto-detects which mode applies based on the presence of a `skill` field.

## What this means for the swarm

A ClawSwarm where every instance has A2A enabled is a network of agents that can:

1. **Discover each other** via Agent Cards — no central registry needed
2. **Delegate tasks** — Claw A asks Claw B to do something it can't do itself
3. **Aggregate results** — a coordinator Claw fans out requests to multiple peers and merges responses
4. **Collaborate conversationally** — agents discuss a problem in natural language before acting

The current constraint is that peer configuration (who knows about whom) must be set up manually in each instance's `openclaw.json`. Automated peer discovery across a ClawSwarm is a planned improvement — see the main README for status.

## Reference implementation

[FlowWink / FlowPilot](https://github.com/magnusfroste/flowwink) implements this model fully:
- Dynamic skill routing (40+ skills from database)
- Caller-defined `responseSchema` support
- Per-peer conversation memory
- Auto-detection of peer protocol (JSON-RPC 2.0, native, legacy)
- Six-path Agent Card discovery fallback

FlowPilot serves as the reference A2A peer for ClawStack development and testing.
