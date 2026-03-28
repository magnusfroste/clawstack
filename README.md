# ClawStack

The internet was the first acceleration. Generative AI was the second. Agentic autonomy is the third.

[OpenClaw](https://openclaw.dev) puts a persistent, tool-using AI agent in the hands of anyone — browsing the web, writing code, managing files, and acting on your behalf around the clock. ClawStack is the missing infrastructure layer: spin up and host a swarm of OpenClaw instances (**ClawSwarm**) on your own hardware, each with its own domain, HTTPS, and full isolation. One server. Unlimited agents.

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
git clone https://github.com/yourusername/clawstack.git
cd clawstack
cp .env.example .env
# Edit .env with your domain, email and admin password
docker compose up -d
```

Open `https://clawstack.yourdomain.com` and log in.

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

## Tech stack

- **Caddy** — reverse proxy, automatic HTTPS via Let's Encrypt
- **ClawStack portal** — Node.js, SQLite, Dockerode
- **OpenClaw** — official image from ghcr.io/openclaw/openclaw

## License

MIT
