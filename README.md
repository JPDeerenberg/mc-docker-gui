# MCPanel

A self-hosted web UI for managing Minecraft Docker containers — supports both **Java Edition** (`itzg/minecraft-server`) and **Bedrock Edition** (`itzg/minecraft-bedrock-server`).

## Features

- 🔐 Login with JWT auth
- 📡 Live log streaming via WebSocket
- ☕ / 🪨 Java & Bedrock server support with automatic detection
- 🎮 Send commands via RCON (Java only)
- ⚙️ Edit `server.properties` (visual + raw editor)
- 👥 Manage whitelist, operators, and ban lists (Java) or allowlist & permissions (Bedrock)
- ▶️ Start / stop / restart containers
- 🔍 Filter dashboard by server type (All / Java / Bedrock)
- ⬇️ Auto-scroll toggle + copy logs button
- ⌨️ Command history (↑/↓ arrow keys)

## Setup

### 1. Configure your environment

```bash
cp .env.example .env
```

Edit `.env` and fill in your values:

```env
# Generate with: openssl rand -hex 32
JWT_SECRET=your-long-random-secret

PANEL_USERNAME=admin

# Generate with: npm run hash yourpassword
# or: docker exec mcpanel node -e "console.log(require('bcryptjs').hashSync('yourpassword', 12))"
PANEL_PASSWORD_HASH=   # leave empty to use default "admin" password
```

> **Note:** `.env` is gitignored — never commit it. Use `.env.example` as the template.

### 2. Build & run

```bash
docker compose up -d --build
```

MCPanel will be available at **http://localhost:3001**.

### 3. Set a real password

Generate a bcrypt hash and paste it into `PANEL_PASSWORD_HASH` in your `.env`:

```bash
# Locally (if you have Node):
npm run hash yourpassword

# Or after the container is running:
docker exec mcpanel node -e "console.log(require('bcryptjs').hashSync('yourpassword', 12))"
```

Then restart: `docker compose restart mcpanel`

### 4. Behind Nginx Proxy Manager

- Change the port mapping in `docker-compose.yml` back to what you need (or remove it entirely)
- Make sure MCPanel and NPM share the same Docker network
- Uncomment the NPM network block at the bottom of `docker-compose.yml`
- Add a proxy host in NPM pointing to `mcpanel:3000`
- **Enable WebSockets** in NPM (required for live log streaming)

### 5. Container detection

MCPanel automatically finds containers where:

- The image name contains `minecraft` or `bedrock-server`
- A container name contains `minecraft`, `bedrock`, or `mc`
- The container has the label `mcpanel=true`

You can also force a server type with a label:
```yaml
labels:
  mcpanel: "true"
  mcpanel.type: "bedrock"   # or "java"
```

### 6. RCON (Java only)

For the command console to work on Java servers, your Minecraft container needs:

```yaml
environment:
  ENABLE_RCON: "true"
  RCON_PORT: "25575"
  RCON_PASSWORD: "yourpassword"
```

Bedrock servers do not support RCON — the command input is disabled for them automatically.

### 7. File paths

MCPanel assumes server data lives at `/data/` inside the container (standard for both `itzg/minecraft-server` and `itzg/minecraft-bedrock-server`). If your setup differs, adjust the `/data/` paths in `server.js`.

## Default credentials

- **Username:** `admin`
- **Password:** `admin`

**Change the password immediately** — set `PANEL_PASSWORD_HASH` in your `.env`.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `R` | Refresh dashboard |
| `Escape` | Back to dashboard |
| `↑` / `↓` | Navigate command history (in console) |
