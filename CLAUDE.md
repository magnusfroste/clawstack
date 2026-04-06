# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start the full stack
docker compose up -d

# Rebuild and restart just the portal after code changes
docker compose up -d --build portal

# View portal logs
docker compose logs -f portal

# View all service logs
docker compose logs -f

# Stop everything
docker compose down
```

There are no tests and no lint scripts.

## Architecture

ClawStack is a multi-tenant OpenClaw hosting platform. The entry point for all traffic is **Caddy**, which uses on-demand TLS to issue certificates automatically for any domain that the portal confirms is registered (`GET /api/verify-domain`).

**Request flow:**
```
HTTPS request → Caddy → portal:3000
  if host == BASE_DOMAIN  →  admin portal UI
  if host == known domain →  proxy to OpenClaw container
    /a2a/* or /.well-known/agent.json  → container:18800 (A2A gateway)
    everything else                    → container:18789 (OpenClaw UI + /v1/responses)
```

**The proxy middleware is registered first in `server.js`**, before auth and body parsing. Any request for a known customer domain is forwarded immediately without hitting auth.

### Portal (`portal/server.js`)

Single-file Node.js app with no build step. Dependencies: Express, Dockerode, better-sqlite3, http-proxy-middleware.

- **DB:** SQLite at `/data/clawstack.db` (inside the portal container, persisted via named volume `portal_data`). Single `instances` table.
- **Auth:** HTTP Basic auth on all `/api/*` routes except `/api/verify-domain`.
- **Bootstrap:** When an instance is created, `bootstrapInstance()` writes OpenClaw config files to `/instances/<name>/config/` and workspace files to `/instances/<name>/workspace/`. These are bind-mounted into the OpenClaw container at `/home/node/.openclaw` and `/home/node/.openclaw/workspace`. The host path is `/opt/clawstack/instances/<name>/`.
- **Container lifecycle:** Dockerode manages OpenClaw containers directly via the Docker socket. Each container is named `clawstack-<name>`, runs on the `clawstack` network, and is memory-limited to 900 MB.

### Role presets (`AGENT_ROLES` in `server.js`)

Defined inline as a constant near the bottom of server.js. Roles: `generalist`, `qa`, `seo`, `dev`, `support`, `research`. Each role provides `identity`, `soul`, `tools` (markdown file content) and `a2aSkills` (written into `openclaw.json`'s plugin config). The `generalist` role writes no workspace files — OpenClaw handles its own onboarding for that case.

### OpenClaw config files

`bootstrapInstance()` writes one JSON config file and optionally several markdown workspace files:
- `config/openclaw.json` — provider, API key (injected as env var), model, gateway token, A2A plugin config
- `workspace/IDENTITY.md`, `SOUL.md`, `TOOLS.md`, `USER.md`, `MEMORY.md`, `HEARTBEAT.md`, `AGENTS.md` — only written for non-generalist roles

OpenClaw containers run as uid 1000; all written files are chowned accordingly.

### Environment variables (`.env`)

| Variable | Purpose |
|---|---|
| `BASE_DOMAIN` | Domain for the admin portal itself |
| `CADDY_EMAIL` | Let's Encrypt registration email |
| `ADMIN_USER` / `ADMIN_PASS` | Portal basic auth credentials |
| `OPENCLAW_IMAGE` | OpenClaw Docker image tag |
| `TZ` | Timezone for containers |
| `PAPERCLIP_DOMAIN` | Domain for the Paperclip orchestrator |
| `PAPERCLIP_SECRETS_KEY` | `BETTER_AUTH_SECRET` for Paperclip (generate with `openssl rand -hex 32`) |
| `ANTHROPIC_API_KEY` | Optional: Paperclip's built-in Claude access |
| `CLAUDE_BASE_URL` / `CLAUDE_AUTH_TOKEN` / `CLAUDE_MODEL` | Optional: point Paperclip at a private LLM |

`INSTANCES_HOST_DIR` is set automatically in `docker-compose.yml` to `$PWD/instances` (the host-side path). The portal uses it when bind-mounting instance dirs into OpenClaw containers.

### Two communication channels

- **OpenResponses** (`POST /v1/responses` on port 18789) — top-down task delegation from an orchestrator to an OpenClaw instance
- **A2A** (port 18800 via openclaw-a2a-gateway plugin) — peer-to-peer agent collaboration; requires "Enable A2A" at instance creation

See `docs/DUAL-CHANNEL.md` for when to use which.

### Paperclip

`docker-compose.yml` also runs `paperclip` (a separate orchestration product) and its Postgres DB. These are independent of ClawStack's core instance management. The Paperclip domain is set via `PAPERCLIP_DOMAIN` in `.env` and picked up by the Caddyfile.

`server.js` hardcodes the Paperclip container names as `clawstack-paperclip-1` and `clawstack-paperclip-db-1`. The Docker Compose project name must remain `clawstack` (the default when run from this directory) for those references to resolve correctly.

### Gotchas

- **Proxy cache:** `getProxy()` in `server.js` caches proxy instances by `containerName:port`. If a container is recreated (new IP), the cached proxy will keep hitting the old address until the portal is restarted.
- **DB migrations:** New columns are added with bare `ALTER TABLE … ADD COLUMN` wrapped in try/catch at startup — there is no migration tool. Check these blocks when changing the schema.
- **`disableDeviceAuth`:** The generated `openclaw.json` must include `disableDeviceAuth: true` to prevent Paperclip pairing from deadlocking on first boot.
