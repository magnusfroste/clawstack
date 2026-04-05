# ClawStack

The internet was the first acceleration. Generative AI was the second. Agentic autonomy is the third.

[OpenClaw](https://openclaw.dev) puts a persistent, tool-using AI agent in the hands of anyone — browsing the web, writing code, managing files, and acting on your behalf around the clock. ClawStack is the missing infrastructure layer: spin up and host a swarm of OpenClaw instances (**ClawSwarm**) on your own hardware, each with its own domain, HTTPS, and full isolation. One server. Unlimited agents.

## The problem

Getting an OpenClaw agent running is the easy part. Getting one that actually does something useful is hard.

OpenClaw ships as a blank slate. After the container starts, you face a collection of markdown files — `SOUL.md`, `IDENTITY.md`, `TOOLS.md`, `BOOTSTRAP.md` — with no clear starting point and no explanation of how they relate to each other. The technical setup (API keys, providers, gateway tokens) is undocumented. The persona setup (who the agent is, what it does) is buried in a conversational onboarding flow that assumes the technical setup is already done. Most people give up before the agent does anything meaningful.

Beyond the single-agent problem: running multiple agents that collaborate requires manually configuring A2A tokens, peer lists, and Agent Cards for each instance. There is no tooling for it.

## What ClawStack does

ClawStack removes both barriers.

**The infrastructure barrier** — domains, HTTPS, container lifecycle, API key management — is handled automatically. Fill in a form, click Create, done. Each agent gets its own domain with automatic TLS, isolated from every other instance on the same server.

**The configuration barrier** — coming soon via role presets. Pick a role (QA agent, SEO agent, dev agent, support agent, research agent) and the instance boots with the right system prompt, tools, and A2A skills already in place. No markdown archaeology required.

**The swarm barrier** — A2A is built into the proxy layer. Every A2A-enabled instance is immediately reachable and discoverable over HTTPS. Swarm templates will wire multiple agents together with pre-configured peering, so a team of collaborating agents is as easy to spin up as a single one.

Under the hood, ClawStack runs a smart reverse proxy (Caddy) that makes custom domains trivially easy. Each agent gets its own domain or subdomain — `ai.yourclient.com`, `jarvis.yourcompany.com`, whatever you like. Just point a CNAME at your ClawStack server and the proxy handles the rest: TLS certificates are issued automatically on first request, no configuration needed. No wildcard certs, no manual cert management, no nginx reloads.

And because ClawStack pulls directly from the official OpenClaw image, you're always running the latest release — not a snapshot baked into a platform template two months ago. EasyPanel, Fly.io, Railway and friends are great, but their OpenClaw integrations lag behind. ClawStack is effectively a local installation with multi-container tenancy: full control, zero platform lag.

## Prerequisites

On a fresh VPS:

**1. Install Docker**
```bash
curl -fsSL https://get.docker.com | sh
```

**2. Point DNS to your VPS**
```
clawstack.yourdomain.com   A  →  your-vps-ip
*.yourdomain.com           A  →  your-vps-ip   (optional, for subdomains)
```
Customers point their own domains via CNAME:
```
ai.customer.com  CNAME  clawstack.yourdomain.com
```

**3. Open ports 80 and 443**

## Setup

```bash
git clone https://github.com/magnusfroste/clawstack.git
cd clawstack
cp .env.example .env
# Edit .env — set BASE_DOMAIN, CADDY_EMAIL, ADMIN_PASS, PAPERCLIP_DOMAIN
docker compose up -d
```

Open `https://clawstack.yourdomain.com` and log in.

> **Note:** Instance data is stored in `./instances/` relative to the project directory. No extra directories to create.

## Adding an OpenClaw instance

1. Enter a name and the customer's domain
2. Click **Create**
3. Customer adds DNS: `ai.customer.com CNAME clawstack.yourdomain.com`
4. ClawStack starts the container, HTTPS provisions automatically on first visit

## How it works

```
Customer visits https://ai.customer.com
        ↓
Caddy (on-demand TLS — cert issued on first request)
        ↓
ClawStack portal (routes by hostname → container)
        ↓
OpenClaw container (internal Docker network)
```

## Agent roles (coming soon)

OpenClaw is a powerful but horizontal tool — it does not arrive with a purpose. ClawStack will ship opinionated **role presets** that configure each instance for a specific job from the start: QA agent, SEO agent, dev agent, support agent, research agent. Pick a role at creation time and the instance boots ready to work, with the right system prompt, tools, and A2A skills pre-configured.

See [docs/PRD.md](docs/PRD.md) for the full product spec.

## A2A — Agent-to-Agent communication (ClawSwarm)

Each instance can optionally run the [OpenClaw A2A gateway plugin](https://github.com/win4r/openclaw-a2a-gateway). Enable it via the **Enable A2A** checkbox when creating an instance.

When A2A is enabled, ClawStack automatically:
- Starts the A2A gateway on internal port **18800**
- Routes `/a2a/*` and `/.well-known/agent.json` to that port (other traffic stays on 18789)
- Publishes an **Agent Card** at `https://your-instance-domain/.well-known/agent.json` so peers can discover the agent's capabilities

This means every A2A-enabled Claw in your swarm is immediately reachable and discoverable over HTTPS — no extra proxy config needed.

### Communication model

ClawStack follows a **caller-defines-the-contract** model, inspired by how tools like Claude Code, Kilo, Roo, and Cline request strict structured output from LLMs:

> The sender specifies what it wants and in what format. The receiver either delivers — or declines.

In practice this looks like an RFQ (Request for Quote):
- *"Can you deliver 1000 branded flashlights in 2 weeks? If yes, respond with `{ price, currency, lead_days }`."*
- The peer replies in the requested format, or responds that it cannot fulfill the request.

This maps directly to A2A's design: the caller's message carries the intent and an optional `responseSchema`. The receiving agent tries to comply within its capabilities. No prior contract negotiation required — just discovery via Agent Card and a well-formed request.

For a full discussion of the communication model, the Postel's Law principle, and the open debate around structured contracts in multi-agent systems, see [docs/A2A-COMMUNICATION-MODEL.md](docs/A2A-COMMUNICATION-MODEL.md).

In practice, two channels are available — OpenResponses (`POST /v1/responses`) for top-down task delegation and A2A for peer-to-peer collaboration. See [docs/DUAL-CHANNEL.md](docs/DUAL-CHANNEL.md) for the decision guide.

For details on the OpenClaw A2A gateway plugin — what it supports, how it routes, and its current limitations — see [docs/A2A-PLUGIN.md](docs/A2A-PLUGIN.md).

### Reference implementation

[FlowWink / FlowPilot](https://github.com/magnusfroste/flowwink) is the reference A2A peer used during development of ClawStack's A2A infrastructure. It implements the full dual-mode model (structured skill execution + conversational chat) and serves as a benchmark for what a well-behaved A2A peer looks like.

## Tech stack

- **Caddy** — reverse proxy, automatic HTTPS via Let's Encrypt
- **ClawStack portal** — Node.js, SQLite, Dockerode
- **OpenClaw** — official image from ghcr.io/openclaw/openclaw
- **OpenClaw A2A gateway** — optional plugin for agent-to-agent communication

## License

MIT
