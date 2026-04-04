# Deployment Topologies

Engram's HTTP access server supports several deployment topologies depending on your environment and use case.

## 1. Localhost (Default)

The server binds to `127.0.0.1` on the same machine as OpenClaw. This is the default for development and single-machine setups.

```bash
openclaw engram access http-serve --port 4318 --token "$TOKEN"
```

All endpoints are available at `http://127.0.0.1:4318/engram/v1/`.

## 2. LAN (Network-Accessible)

Run Engram on a dedicated machine accessible from your local network (e.g., a Mac Mini or home server).

```bash
openclaw engram access http-serve --host 0.0.0.0 --port 4318 --token "$TOKEN"
```

Other machines on the LAN can reach Engram at `http://<machine-ip>:4318/engram/v1/`.

**Security note:** Binding to `0.0.0.0` exposes the server to all network interfaces. Use a firewall or VPN to restrict access. The bearer token is required for all requests.

## 3. Remote (Self-Hosted)

Run Engram on a remote server or VPS. Use a reverse proxy (nginx, Caddy) with TLS termination.

```nginx
server {
    listen 443 ssl;
    server_name engram.example.com;

    ssl_certificate /etc/ssl/certs/engram.pem;
    ssl_certificate_key /etc/ssl/private/engram.key;

    location / {
        proxy_pass http://127.0.0.1:4318;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Start Engram binding to localhost behind the proxy:

```bash
openclaw engram access http-serve --host 127.0.0.1 --port 4318 --token "$TOKEN"
```

## 4. Containerized (Docker)

Run Engram in Docker, either standalone or as a sidecar alongside other services.

```yaml
# docker-compose.yml
version: "3.8"
services:
  engram:
    image: node:22-slim
    working_dir: /app
    command: ["node", "dist/access-cli.js", "http-serve", "--host", "0.0.0.0", "--port", "4318"]
    ports:
      - "4318:4318"
    environment:
      OPENCLAW_ENGRAM_ACCESS_TOKEN: ${ENGRAM_TOKEN}
      NODE_ENV: production
    volumes:
      - ./engram-data:/root/.openclaw/workspace/memory
```

## 5. Standalone (No OpenClaw)

Run Engram entirely without OpenClaw, using the standalone CLI and server packages. This is useful for CI/CD pipelines, custom integrations, or environments where OpenClaw is not available.

```
engram CLI → engram daemon → Memory Store (~/.engram/memory/)
```

Setup:

```bash
# Install
npm install -g @joshuaswarren/openclaw-engram

# Configure
engram init
# Edit engram.config.json with your API key and settings

# Start background server
engram daemon start
engram status   # verify running

# Use
engram query "what did I work on yesterday?"
engram onboard ~/src/my-project
engram space create my-project project
engram benchmark run --explain
```

The standalone server uses the same HTTP API as the OpenClaw plugin mode (see [API Reference](../api.md)). The Hermes provider (`@engram/hermes-provider`) can connect to it from any TypeScript/JavaScript application.

Configuration is read from (in order of precedence):

1. `--config <path>` CLI flag
2. `ENGRAM_CONFIG_PATH` environment variable
3. `./engram.config.json` in the current directory
4. `~/.config/engram/config.json` (default)

This topology does not include OpenClaw gateway features (agent hooks, tool registration, session lifecycle). Use the [Platform Migration Guide](../guides/platform-migration.md) for full details on standalone capabilities.

## Port Selection

| Port | Use Case |
|------|----------|
| 4318 | Default Engram HTTP port (configurable via `--port`) |
| 18789 | OpenClaw gateway (Engram plugin mode) |

## Authentication

All topologies require a bearer token. Set it via:

1. `--token` CLI flag
2. `OPENCLAW_ENGRAM_ACCESS_TOKEN` environment variable
3. `agentAccessHttp.authToken` in `openclaw.json`

Clients must send `Authorization: Bearer <token>` with every request.

## Health Check

Regardless of topology, verify the server is running:

```bash
curl -H "Authorization: Bearer $TOKEN" http://<host>:4318/engram/v1/health
```

Returns:

```json
{
  "ok": true,
  "memoryDir": "/path/to/memory",
  "namespacesEnabled": false,
  "defaultNamespace": "default",
  "searchBackend": "qmd",
  "qmdEnabled": true,
  "nativeKnowledgeEnabled": false,
  "projectionAvailable": true
}
```
