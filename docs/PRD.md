# ClawStack — Product Requirements Document

## Problem

### The OpenClaw onboarding gap

OpenClaw ships with two separate onboarding layers that are never explained together:

**Layer 1 — Technical setup** (the user's job)
Configure `openclaw.json`: API keys, provider, model, gateway token. No guide exists. The user is expected to figure it out.

**Layer 2 — Persona setup** (done conversationally with the agent)
`BOOTSTRAP.md` in the workspace is the actual UX — open the chat, say *"Hey, I just came online. Who am I?"* and the agent walks you through naming itself, defining its personality, and setting up `IDENTITY.md`, `SOUL.md`, `USER.md`. Then delete `BOOTSTRAP.md`.

The problem: Layer 2 assumes Layer 1 is already solved. Layer 1 has no documentation. New users stall before the conversation ever starts.

Beyond that, the workspace contains `SOUL.md`, `IDENTITY.md`, `TOOLS.md`, `USER.md`, `MEMORY.md`, `HEARTBEAT.md`, `AGENTS.md` — seven files with no master index, no reading order, no explanation of which ones matter for which use case. For a user who just wants a QA agent or an SEO assistant, none of this is relevant. They just want the agent to work.

### The swarm gap

Running multiple OpenClaw instances that collaborate requires manually:
- Generating and exchanging A2A bearer tokens for each pair of instances
- Writing peer configuration into each instance's `openclaw.json`
- Publishing and discovering Agent Cards
- Keeping everything in sync when instances change

There is no tooling for any of this. The result is that A2A remains a theoretical capability for most ClawStack users.

## Value proposition

ClawStack removes three barriers that stand between a user and a working agent.

| Barrier | Before ClawStack | With ClawStack |
|---|---|---|
| Infrastructure | Manual Docker, nginx, certbot, DNS | One form, automatic HTTPS, done |
| Configuration | Seven undocumented markdown files, blank slate agent | Role presets: pick a job, agent starts ready |
| Swarm | Manual token exchange, peer config per instance | Swarm templates: agents pre-wired and peering |

The target user is someone who wants to deploy a useful agent — not someone who wants to learn OpenClaw's internals. ClawStack is the opinionated layer that makes OpenClaw accessible without removing any of its power for users who want to go deeper.

## Background

OpenClaw is a capable but horizontal agent platform. Out of the box it does nothing specific — the user must configure system prompts, tools, and behaviors from scratch. This is a high barrier for anyone who wants to deploy an agent for a concrete purpose.

ClawStack is already the infrastructure layer that removes the DevOps barrier (domains, HTTPS, container management). The next layer is removing the **configuration barrier**: giving users a working agent, not just a running container.

---

## Feature: Agent role presets

### Problem

A freshly created OpenClaw instance has no purpose. It responds to messages but has no domain knowledge, no behavioral guidelines, and no pre-configured tools. Users who are not familiar with prompt engineering or OpenClaw's internals are stuck at a blank slate.

This limits ClawStack's audience to technical users who already know what they want to build. It also makes the value of A2A and ClawSwarm abstract — it is hard to explain why you would want a swarm of agents when each agent does nothing in particular.

### Solution

At instance creation, the user selects a **role**. ClawStack bootstraps the instance with a role-specific configuration: system prompt, `TOOLS.md`, suggested skills for the Agent Card, and default A2A behavior. The instance starts ready to work.

### Roles

**Generalist** (default)
Blank slate. Current behavior. For users who want full control.

**QA agent**
Browses and tests web properties. Reports findings structured as severity-graded issues. Skills: page audit, accessibility check, broken link scan, form testing, regression run. A2A: accepts audit requests, returns structured finding reports.

**SEO agent**
Crawls and analyses web content for search engine performance. Skills: keyword analysis, meta audit, content gap analysis, competitor comparison, sitemap validation. A2A: accepts URL, returns scored recommendations.

**Dev agent**
Code review, documentation, PR summaries, dependency audits. Skills: review pull request, generate docs, summarise diff, check for security issues. A2A: accepts repo or file references, returns structured feedback.

**Support agent**
Customer-facing conversational agent. Handles FAQ, escalation routing, ticket summarisation. Skills: answer question, escalate, summarise conversation, look up order. A2A: accepts inbound queries from other agents or orchestrators.

**Research agent**
Web search, source aggregation, summarisation. Skills: search web, summarise sources, extract facts, compare positions. A2A: accepts research briefs, returns structured reports with citations.

### What each preset writes

At bootstrap, in addition to the current `openclaw.json`, ClawStack writes:

- **`agents/main/agent/TOOLS.md`** — role-specific system prompt and behavioral guidelines
- **A2A Agent Card skills** — pre-populated skill list in `openclaw.json` matching the role's capabilities
- **`agents/main/agent/PERSONA.md`** (optional) — name, tone, communication style for the role

### UI change

Add a role selector to the create-instance form, above the provider fields:

```
Role:  [ Generalist ▾ ]
       [ QA agent       ]
       [ SEO agent      ]
       [ Dev agent      ]
       [ Support agent  ]
       [ Research agent ]
```

Role selection is visible and clearly labeled. Generalist remains the default so existing behavior is unchanged.

---

## Feature: ClawSwarm role composition

### Problem

A2A communication between instances is technically available but has no obvious starting point. Users do not know which agents to create, how to connect them, or what a useful swarm looks like in practice.

### Solution

Define a small set of **swarm templates** — pre-composed sets of roles that work together for a common use case. When a user creates a swarm from a template, ClawStack creates the instances, configures A2A peering between them, and provides a brief description of how they collaborate.

### Example swarm templates

**Web quality swarm**
- 1× QA agent (tests and audits)
- 1× SEO agent (content and search analysis)
- 1× Research agent (competitor and market context)
- Pre-peered via A2A. QA agent can delegate research tasks to the Research agent.

**Product team swarm**
- 1× Dev agent (code review, documentation)
- 1× QA agent (testing, regression)
- 1× Research agent (technology research, RFC summaries)
- Pre-peered via A2A. Dev agent initiates QA runs via A2A after code changes.

**Customer operations swarm**
- 1× Support agent (customer-facing)
- 1× Research agent (knowledge lookup)
- Pre-peered via A2A. Support agent delegates research queries to Research agent.

### What ClawStack does

1. Creates each instance with the correct role preset
2. Generates A2A bearer tokens for each instance
3. Writes peer configuration for each instance pointing to the others in the swarm
4. Displays the swarm as a group in the portal UI with a topology diagram

---

## Open questions

**Peer discovery in swarms**
The A2A community has not settled on automated peer discovery across organisational boundaries. Within a single ClawStack deployment, discovery is straightforward (all instances are known to the portal). Across deployments, it remains an open problem. ClawStack will solve intra-swarm peering first.

**Role extensibility**
Should users be able to define custom roles? A role is essentially a set of files (TOOLS.md, PERSONA.md, Agent Card skills). A future version could allow uploading or selecting community-contributed role packs.

**Multi-provider per role**
Some roles benefit from specific models (e.g. a coding agent on a code-optimised model). Role presets could suggest a default model without locking the user in.
