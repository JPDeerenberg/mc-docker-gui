# MCPanel

A self-hosted web UI for managing Minecraft Docker containers.

## Features
- Login with JWT auth
- Live log streaming via WebSocket
- Send commands via RCON
- Edit `server.properties` (visual + raw editor)
- Manage whitelist, operators, and ban lists
- Start / stop / restart containers

## Setup

### 1. Build & run

```bash
docker compose up -d --build
```

### 2. Set a real password

Generate a bcrypt hash:

```bash
# After starting the container:
docker exec mcpanel node -e "console.log(require('bcryptjs').hashSync('yourpassword', 12))"

# Or locally if you have Node:
npm run hash yourpassword
```

Paste the output into `PANEL_PASSWORD_HASH` in `docker-compose.yml`, then restart.

### 3. Behind Nginx Proxy Manager

- Remove the `ports` mapping from docker-compose.yml
- Make sure MCPanel and NPM are on the same Docker network
- Add a proxy host in NPM pointing to `mcpanel:3000`
- **Enable WebSockets** in NPM (Advanced → Custom config or the WS toggle)

### 4. Minecraft container detection

MCPanel finds containers where:
- The image name contains `minecraft`
- A container name contains `minecraft` or `mc`
- The container has the label `mcpanel=true`

For the RCON console to work, your Minecraft container needs:
```yaml
environment:
  ENABLE_RCON: "true"
  RCON_PORT: "25575"
  RCON_PASSWORD: "yourpassword"
```
This is the standard for `itzg/minecraft-server`. If RCON isn't configured, logs still stream fine — you just can't send commands.

### 5. File paths

MCPanel assumes Minecraft data lives at `/data/` inside the container (standard for `itzg/minecraft-server`). If your setup is different, you'll need to tweak the `/data/` paths in `server.js`.

## Default credentials

- Username: `admin`
- Password: `admin`

**Change the password immediately** via the `PANEL_PASSWORD_HASH` env var.
