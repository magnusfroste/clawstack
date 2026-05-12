# Fix for ClawStack Docker Caddy Configuration Issue

## Problem
The Caddy container in the ClawStack setup was continuously restarting due to a configuration error in the Caddyfile. The error message was:
```
Error: adapting config using caddyfile: server block without any key is global configuration, and if used, it must be first
```

This occurred because the Caddyfile contained:
```
https:// {
    tls {
        on_demand
    }
    reverse_proxy portal:3000
}
```

Caddy interpreted this `https://` block as global configuration rather than a site block, which is invalid when not placed first in the file.

## Root Cause
The issue was using protocol-specific syntax (`https://`) without proper address specifiers. In Caddyfile, site addresses should use explicit port notation or domain names.

## Solution
Modified `/root/clawstack/Caddyfile` to use explicit port specifiers:

### Before (broken)
```caddyfile
{
    email {$CADDY_EMAIL}
    on_demand_tls {
        ask http://portal:3000/api/verify-domain
    }
}

# ClawStack admin portal
{$BASE_DOMAIN} {
   reverse_proxy portal:3000
}

# Paperclip orchestrator
{$PAPERCLIP_DOMAIN} {
   reverse_proxy paperclip:3100
}

# Customer OpenClaw instances — on-demand TLS, portal routes traffic
https:// {
   tls {
     on_demand
   }
   reverse_proxy portal:3000
}

http:// {
   reverse_proxy portal:3000
}
```

### After (fixed)
```caddyfile
{
    email {$CADDY_EMAIL}
    on_demand_tls {
        ask http://portal:3000/api/verify-domain
    }
}

# HTTP - serve all HTTP traffic via portal
:80 {
    reverse_proxy portal:3000
}

# HTTPS with on-demand TLS for automatic certificate management
:443 {
    tls {
        on_demand
    }
    reverse_proxy portal:3000
}

# ClawStack admin portal - explicit domain
{$BASE_DOMAIN} {
    reverse_proxy portal:3000
}

# Paperclip orchestrator - explicit domain
{$PAPERCLIP_DOMAIN} {
    reverse_proxy paperclip:3100
}
```

## Environment Variables
The following environment variables are used in the Caddyfile:
- `CADDY_EMAIL`: Email for ACME/Let's Encrypt notifications
- `BASE_DOMAIN`: Primary domain for ClawStack admin portal (e.g., clawstack.froste.eu)
- `PAPERCLIP_DOMAIN`: Domain for Paperclip orchestrator (e.g., boss.froste.eu)

These are loaded from `/root/clawstack/.env` and passed to the container via docker-compose.yml.

## Verification Steps
1. **Container Status**: After fix, `docker ps` shows caddy container as "Up" instead of "Restarting"
2. **HTTP Access**: `curl -I http://clawstack.froste.eu` returns 308 Permanent Redirect to HTTPS
3. **HTTPS Access**: `curl -I https://clawstack.froste.eu` returns 401 Unauthorized (expected, as authentication is required)
4. **Logs**: Container logs show successful startup with TLS certificate management:
   ```
   msg":"serving initial configuration"
   msg":"got renewal info"
   ```

## Persistence
The fix survives reboots because:
- Docker service is enabled: `systemctl is-enabled docker` returns enabled
- Container restart policy: `unless-stopped` (defined in docker-compose.yml)
- Configuration is stored in version control and mounted as volume

## Files Modified
- `/root/clawstack/Caddyfile` - Fixed Caddy configuration syntax
- `/root/clawstack/docker-compose.yml` - Added `PAPERCLIP_DOMAIN` to caddy service environment

## Testing Commands
```bash
# Check container status
docker ps | grep caddy

# Test HTTP redirect
curl -I http://clawstack.froste.eu

# Test HTTPS endpoint (expect 401 due to auth)
curl -I https://clawstack.froste.eu

# View container logs
docker logs clawstack-caddy-1 --tail 20
```