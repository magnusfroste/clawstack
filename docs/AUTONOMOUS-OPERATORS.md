# Autonomous Operators

An **autonomous operator** is an OpenClaw instance that runs a third-party SaaS on autopilot — without a human clicking, deciding, or monitoring. It connects to the SaaS via MCP, wakes up on a schedule, checks what matters, acts on it, and reports findings. No human in the loop unless something critical surfaces.

ClawThree operating FlowWink is the reference implementation.

---

## How it works

Two mechanisms combine to make a claw autonomous:

### 1. Heartbeat (built-in, config-driven)

Every OpenClaw instance has a built-in heartbeat scheduler. It fires a message to the agent on a configurable interval. The agent reads its `HEARTBEAT.md`, decides what to do for this time window, acts via MCP, and either reports findings or responds `HEARTBEAT_OK` (silent no-op).

Configured in `openclaw.json` under `agents.defaults.heartbeat`:

```json
"agents": {
  "defaults": {
    "heartbeat": {
      "every": "4h",
      "prompt": "HEARTBEAT — read HEARTBEAT.md and execute your scheduled objectives for this time window. Respond with HEARTBEAT_OK if the schedule says to sleep.",
      "target": "none"
    }
  }
}
```

| Field | Purpose |
|-------|---------|
| `every` | Interval — `4h`, `30m`, `24h`, etc. |
| `prompt` | Message sent to the agent on each tick |
| `target` | Delivery channel — `none` = no chat delivery, runs silently |

**Default behaviour (no config):** OpenClaw runs heartbeat every 30 minutes by default. With no `HEARTBEAT.md` content, the agent responds `HEARTBEAT_OK` and nothing happens. The operator only activates when `HEARTBEAT.md` has tasks.

### 2. MCP (tool layer)

The agent calls the SaaS via MCP tools. Each MCP server exposes an API surface (~110 tools for FlowWink) that the agent calls like any other tool — read, write, report. No webhooks, no polling loop to build, no SDK to integrate. The agent is the integration.

Configured in `openclaw.json` under `mcp.servers`:

```json
"mcp": {
  "servers": {
    "flowwink": {
      "url": "https://your-saas.supabase.co/functions/v1/mcp-server",
      "transport": "streamable-http",
      "headers": {
        "x-api-key": "fwk_your_api_key_here"
      }
    }
  }
}
```

**Two critical notes for Supabase Edge Function MCP servers:**

1. **`"transport": "streamable-http"` is required.** OpenClaw defaults to the legacy SSE transport. That protocol establishes a GET/SSE stream first, then POSTs to a server-sent `endpoint` URL. Supabase Edge Functions implement Streamable HTTP (not legacy SSE) — so the `endpoint` event is never emitted, and tool call POSTs either fail or drop custom headers. Setting `transport: streamable-http` forces OpenClaw to POST directly to the configured URL with all headers intact for every request type — resources and tool calls alike.

2. **Use `x-api-key`, not `Authorization: Bearer`.** Supabase intercepts the `Authorization` header at the gateway level and replaces it with the anon JWT before the Edge Function receives the request.

---

## The heartbeat loop

```
[clock tick every 4h]
        ↓
OpenClaw fires heartbeat prompt to main agent
        ↓
Agent reads HEARTBEAT.md → checks time window
        ↓
  Night? → HEARTBEAT_OK (silent, no action)
  Active? → pick 1-2 objectives based on time window
        ↓
Agent calls MCP tools (read data → analyse → act)
        ↓
Agent submits findings via openclaw_report_finding
        ↓
Agent updates memory/heartbeat-state.json
        ↓
[next tick in 4h]
```

`HEARTBEAT_OK` is a special token OpenClaw recognises — a response containing only this token is treated as a silent no-op (no notification, no log entry).

---

## HEARTBEAT.md — the schedule file

The agent reads `HEARTBEAT.md` on every heartbeat tick. This file defines:

- **Time-window rotation** — which objectives to run at which hours
- **Error recovery** — what to do when MCP calls fail
- **Sleep conditions** — when to respond HEARTBEAT_OK
- **Escalation rules** — when to immediately flag critical findings

For FlowWink operators, the built-in rotation is:

| Window | Focus |
|--------|-------|
| Morning (08-12) | Revenue + Pipeline |
| Afternoon (12-18) | Content + Operations |
| Evening (18-22) | Compliance + SEO quality |
| Night (22-08) | Sleep — HEARTBEAT_OK |

The file is writable — the agent updates it, and the admin can edit it directly through the ClawStack file browser.

---

## Channel separation

| Channel | Direction | Purpose |
|---------|-----------|---------|
| **MCP** | Agent → SaaS | Tool calls — reading data, making changes, reporting findings |
| **/v1/responses** | Orchestrator → Agent | Top-down task delegation — Lovable, another agent, or a human pushing a task |
| **A2A** | Peer → Peer | Agent-to-agent collaboration (not typically needed for operator pattern) |

For autonomous operation, only MCP is required. `/v1/responses` remains available as an optional inbox for ad-hoc tasks — it does not conflict with or replace MCP.

---

## Role preset: `flowwink`

ClawStack ships a `flowwink` role preset that bootstraps a fully-configured FlowWink operator in one click. The only step after creation is setting the MCP key.

**What it bootstraps:**
- `SOUL.md` — Business Operations Architect identity
- `AGENTS.md` — Session startup checklist + operating loop
- `TOOLS.md` — Full FlowWink MCP tool reference
- `HEARTBEAT.md` — Time-window rotation schedule
- `openclaw.json` — Heartbeat at 4h, MCP server block with placeholder key

**After creation — two things to do:**

1. Open the instance config editor and replace the MCP placeholders:
   ```json
   "mcp": {
     "servers": {
       "flowwink": {
         "url": "REPLACE_WITH_YOUR_FLOWWINK_MCP_URL",
         "transport": "streamable-http",
         "headers": { "x-api-key": "REPLACE_WITH_YOUR_FLOWWINK_API_KEY" }
       }
     }
   }
   ```

2. Restart the instance gateway (the config editor shows a Restart button when saving `openclaw.json`).

The agent starts its first heartbeat cycle within the configured interval and operates autonomously from then on.

---

## Findings

The operator submits structured findings via `openclaw_report_finding`:

```json
{
  "title": "Order #4821 stuck for 3 days — no invoice generated",
  "type": "sla_violation",
  "severity": "high",
  "description": "Order placed 2026-04-13, payment received, but invoice record is missing. Manual review required."
}
```

Findings are stored in the SaaS's `beta_test_findings` table (or equivalent) and visible in the admin dashboard. `type` is free-form — no restrictions.

---

## Scenario B

ClawStack's autonomous operator capability was validated through **Scenario B**: FlowPilot (embedded agent) is OFF; ClawThree (external OpenClaw operator) is the only autonomous actor. Hypothesis: can an external agent operating via MCP match what an embedded agent does?

**Results (2026-04-15):**
- Lead qualification → order fulfillment → objective triage ✓
- Content pipeline audit (broken funnel detected) ✓
- Quote-to-cash audit (missing invoices, SLA violation flagged) ✓
- Expense compliance (invalid VAT 12.5% flagged) ✓
- MCP callback reliability: 100%
- Avg heartbeat duration: 35-70s (fire-and-forget; exceeds 30s sync timeout)

**Conclusion:** An external MCP operator is a viable alternative to an embedded agent for monitoring, auditing, and operational tasks. Write-back and real-time reactivity remain advantages of an embedded agent.

---

## MCP server design for external agents

Extern agent tool budget är begränsad (~20-30 tools). MCP-servrar bör designas som **focused capabilities**, inte som monolitiska API:er. En plattform kan exponera flera MCP-endpoints — en per domän — så att agenter bara prenumererar på det de behöver.

### The tool budget problem

An LLM's context window is finite. Every tool definition consumes tokens — not just name and description, but the full JSON schema for each parameter. At 109 tools, a significant portion of the context window is occupied before the agent has read a single byte of operational data.

The symptoms:
- Agent loses track of available tools mid-session
- Reasoning quality degrades (too many options, not enough context)
- Heartbeat sessions time out before completing objectives

The threshold in practice: **20-30 tools** is where most frontier models perform well. Beyond 50, reasoning quality measurably drops. Beyond 100, the agent is effectively working blind on context-heavy tasks.

### Step 1: Module-aware filtering (low effort, high impact)

Before splitting into domain endpoints, check whether the platform already has a module concept. Most SaaS platforms expose far more tools than any given customer has enabled.

The correct filter is three conditions, not two:

| Condition | Means |
|-----------|-------|
| `mcp_exposed = true` | The tool is intended for external agents |
| `enabled = true` | The tool is active in this installation |
| **Module active** | The module the tool belongs to is turned on |

Without the third condition, disabling the CRM module in admin still exposes CRM tools via MCP. The agent tries to call them, gets errors, wastes context recovering. The platform's own module state should be the authority on what's available.

In practice, most platforms already tag each skill or tool with a `category` that maps 1:1 to a module. Filtering `loadExposedSkills()` against active modules is typically one added JOIN or WHERE clause. The result is that a customer with only CRM + Content enabled sees ~14 tools. A customer with all modules sees ~30. The agent always sees a coherent, callable surface — never phantom tools from inactive modules.

**This is the right first step.** It solves tool budget, gives correct semantics, and costs almost nothing to implement.

### Step 2: Domain-specific MCP servers (when module filtering isn't enough)

If module filtering reduces the tool count to ~30, stop there. If the platform is large enough that even a single active module exposes too many tools, or if different agents need access to different subsets of the same module, domain endpoints are the next step.

Instead of one monolithic server with 109 tools, expose one server per business domain:

```
platform.com/functions/v1/mcp-crm        → 8 tools  (leads, deals, contacts)
platform.com/functions/v1/mcp-content     → 6 tools  (blog, pages, KB)
platform.com/functions/v1/mcp-commerce    → 7 tools  (products, orders, invoices)
platform.com/functions/v1/mcp-booking     → 4 tools  (bookings, services)
platform.com/functions/v1/mcp-finance     → 5 tools  (expenses, contracts, VAT)
```

Total across all domains: ~30 tools. An agent connecting to all five sees a manageable, well-organized surface.

In `openclaw.json`, multiple servers are registered independently:

```json
"mcp": {
  "servers": {
    "fw-crm":      { "url": "...mcp-crm",      "transport": "streamable-http", "headers": { "x-api-key": "..." } },
    "fw-content":  { "url": "...mcp-content",   "transport": "streamable-http", "headers": { "x-api-key": "..." } },
    "fw-commerce": { "url": "...mcp-commerce",  "transport": "streamable-http", "headers": { "x-api-key": "..." } },
    "fw-booking":  { "url": "...mcp-booking",   "transport": "streamable-http", "headers": { "x-api-key": "..." } },
    "fw-finance":  { "url": "...mcp-finance",   "transport": "streamable-http", "headers": { "x-api-key": "..." } }
  }
}
```

OpenClaw prefixes tool names by server: `fw-crm__manage_lead`, `fw-content__manage_blog_post`. The agent sees domain structure, not a flat list of 109 identical-looking `manage_*` functions.

### Selective subscription

A specialized claw only connects to the domains it needs:

| Agent | Subscribes to |
|-------|--------------|
| Autonomous COO (ClawThree) | All 5 domains — needs holistic visibility |
| SEO agent | `mcp-content` only |
| Finance auditor | `mcp-finance` + `mcp-commerce` |
| Support agent | `mcp-crm` + `mcp-booking` |

This gives different agents different views of the same platform — without the platform having to maintain separate API surfaces per agent type.

### Why this beats reducing a monolith to 25 tools

Reducing `mcp_exposed` to 25 on the server side forces every agent to use the same 25 tools regardless of role. Domain servers let each agent subscribe to the right 20-30 tools for its actual job. The total platform capability stays complete; the per-agent surface stays focused.

### Decision ladder: which approach when

| Situation | Recommended approach |
|-----------|---------------------|
| Platform has module concept, most customers have <5 modules active | **Module-aware filtering** — filter `tools/list` against active modules. Done. |
| All modules active but total tools still >50 | **Domain endpoints** — split into focused MCP servers per domain |
| Different agents need scoped access to the same module | **Scoped API keys** — key determines which tools are visible |
| Agent needs tools from many domains simultaneously | **Mother brain + all domain endpoints** — one agent, multiple server connections, ~30 tools total |
| Tasks are genuinely independent and parallelisable | **Specialized claws** — each subscribes to one domain only |

The `mcp_exposed` flag should stay as-is — it controls intent ("this tool is for external agents"). Module filtering is a separate, additive layer that controls availability ("this tool is available in this installation"). Both are needed; neither replaces the other.

---

## Multi-agent vs mother brain

When operating a SaaS platform, there is a recurring architectural question: one agent with full visibility, or multiple specialized agents each owning a domain?

**Mother brain (single agent, multiple MCP domains)**
```
ClawThree (COO)
    ├── → mcp-crm      (reads lead pipeline)
    ├── → mcp-commerce (sees stuck orders)
    └── → mcp-finance  (cross-references invoices)
```
ClawThree sees that a lead converted to a deal, the deal generated an order, the order has no invoice, and the invoice SLA is breached — in a single reasoning pass. No coordination overhead.

**Specialized claws (hierarchical)**
```
Orchestrator
    ├── CRM-claw    (lead pipeline only)
    ├── Order-claw  (commerce only)
    └── Finance-claw (invoices only)
```
Each claw is good at its domain. But no single claw sees that the lead, the order, and the missing invoice are connected. An orchestrator must stitch findings together — adding latency, coordination logic, and a new failure mode.

**The deciding question:** does the task require *specialized reasoning* or just *specialized data access*?

- Specialized data access → MCP domain server. No separate agent needed.
- Specialized reasoning → A2A agent. Add a claw when you need a different *intelligence*, not when you need a different *API surface*.

For SaaS operations, the answer is almost always data access. One capable generalist agent with domain-specific MCP servers outperforms a swarm of specialized claws until the platform is genuinely complex enough to require independent expert reasoning per domain.

**Practical threshold:** add a specialized sub-agent when a domain requires expertise that a generalist consistently gets wrong — e.g., complex tax law, medical terminology, legal contract analysis. Not before.

---

## Adding an operator for any MCP-capable SaaS

1. Create a new instance with role `generalist` (or create a custom role preset)
2. Add `mcp.servers.<name>` to `openclaw.json` for each domain endpoint
3. Add `agents.defaults.heartbeat` with a suitable interval and prompt
4. Write a `HEARTBEAT.md` defining what to check and when
5. Write a `TOOLS.md` describing the available MCP domains and their tools
6. Restart the gateway

Keep total tool count across all connected servers under 30.

The agent will start operating on the next heartbeat tick.
