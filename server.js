'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Docker = require('dockerode');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const net = require('net');
const path = require('path');
const tar = require('tar-stream');
const { PassThrough } = require('stream');

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT        = process.env.PORT || 3000;
const JWT_SECRET  = process.env.JWT_SECRET || 'change-me-in-production-please';
const USERNAME    = process.env.PANEL_USERNAME || 'admin';
// Default password is "admin" — override via PANEL_PASSWORD_HASH (bcrypt hash)
const PASS_HASH   = process.env.PANEL_PASSWORD_HASH || '$2a$12$KIXLz6H7j5/m.Cz.7Ij3OubqO3pDyL4W2Q8Q6P6zYfKk5hFcgGa2';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// ─── App ─────────────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: '/ws/logs' });

app.use(express.json({ limit: '1mb' }));

// Serve index.html for root
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ─── Auth middleware ──────────────────────────────────────────────────────────

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── Server-type helpers ──────────────────────────────────────────────────────

/**
 * Returns 'bedrock' | 'java' based on container metadata.
 */
function detectServerType(container) {
  const img   = (container.Image || '').toLowerCase();
  const names = (container.Names || []).map(n => n.toLowerCase()).join(' ');
  const label = container.Labels?.['mcpanel.type'] || '';

  if (label === 'bedrock') return 'bedrock';
  if (label === 'java')    return 'java';
  if (img.includes('bedrock') || names.includes('bedrock')) return 'bedrock';
  return 'java';
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
  if (username !== USERNAME) return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, PASS_HASH);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, username });
});

// List Minecraft containers (Java + Bedrock)
app.get('/api/containers', auth, async (req, res) => {
  try {
    const all = await docker.listContainers({ all: true });
    const mc = all.filter(c => {
      const img   = c.Image.toLowerCase();
      const names = c.Names.map(n => n.toLowerCase()).join(' ');
      return img.includes('minecraft') ||
             img.includes('bedrock-server') ||
             c.Labels?.['mcpanel'] === 'true' ||
             names.includes('minecraft') ||
             names.includes('bedrock') ||
             names.includes('-mc-') ||
             names.match(/\bmc\b/);
    });

    // Annotate each container with detected serverType
    const annotated = mc.map(c => ({
      ...c,
      serverType: detectServerType(c),
    }));

    res.json(annotated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Container inspect (also annotate serverType)
app.get('/api/containers/:id', auth, async (req, res) => {
  try {
    const info = await docker.getContainer(req.params.id).inspect();
    // Reconstruct a minimal summary for type detection
    const typeFake = { Image: info.Config.Image, Names: [info.Name], Labels: info.Config.Labels || {} };
    info._serverType = detectServerType(typeFake);
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start / stop / restart
app.post('/api/containers/:id/action', auth, async (req, res) => {
  const { action } = req.body;
  const c = docker.getContainer(req.params.id);
  try {
    if      (action === 'start')   await c.start();
    else if (action === 'stop')    await c.stop({ t: 10 });
    else if (action === 'restart') await c.restart({ t: 10 });
    else return res.status(400).json({ error: 'Unknown action' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── File helpers (docker cp via tar-stream) ──────────────────────────────────

async function readContainerFile(id, filePath) {
  const container = docker.getContainer(id);
  const stream = await container.getArchive({ path: filePath });
  return new Promise((resolve, reject) => {
    const extract = tar.extract();
    let content = '';
    extract.on('entry', (header, s, next) => {
      s.on('data', chunk => { content += chunk.toString(); });
      s.on('end', next);
      s.resume();
    });
    extract.on('finish', () => resolve(content));
    extract.on('error', reject);
    stream.pipe(extract);
  });
}

async function writeContainerFile(id, filePath, content) {
  const container = docker.getContainer(id);
  const dir      = path.dirname(filePath);
  const filename = path.basename(filePath);
  const pack     = tar.pack();
  pack.entry({ name: filename, size: Buffer.byteLength(content) }, content);
  pack.finalize();
  await container.putArchive(pack, { path: dir });
}

// Read file
app.get('/api/containers/:id/file', auth, async (req, res) => {
  const { path: fp } = req.query;
  if (!fp) return res.status(400).json({ error: 'path required' });
  try {
    const content = await readContainerFile(req.params.id, fp);
    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Write file
app.put('/api/containers/:id/file', auth, async (req, res) => {
  const { path: fp, content } = req.body;
  if (!fp || content === undefined) return res.status(400).json({ error: 'path and content required' });
  try {
    await writeContainerFile(req.params.id, fp, content);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Player data ──────────────────────────────────────────────────────────────

const JAVA_PLAYER_FILES = [
  'whitelist.json',
  'ops.json',
  'banned-players.json',
  'banned-ips.json',
];

const BEDROCK_PLAYER_FILES = [
  'allowlist.json',
  'permissions.json',
];

app.get('/api/containers/:id/players', auth, async (req, res) => {
  const { type = 'java' } = req.query;
  const result = {};

  if (type === 'bedrock') {
    for (const file of BEDROCK_PLAYER_FILES) {
      const key = file.replace('.json', '').replace(/-/g, '_');
      try {
        const raw = await readContainerFile(req.params.id, `/data/${file}`);
        result[key] = JSON.parse(raw);
      } catch {
        result[key] = [];
      }
    }
  } else {
    for (const file of JAVA_PLAYER_FILES) {
      const key = file.replace('.json', '').replace(/-/g, '_');
      try {
        const raw = await readContainerFile(req.params.id, `/data/${file}`);
        result[key] = JSON.parse(raw);
      } catch {
        result[key] = [];
      }
    }
  }

  res.json(result);
});

app.put('/api/containers/:id/players', auth, async (req, res) => {
  const { file, data } = req.body;
  const allFiles = [...JAVA_PLAYER_FILES, ...BEDROCK_PLAYER_FILES];
  if (!allFiles.includes(file)) return res.status(400).json({ error: 'Invalid file' });
  try {
    await writeContainerFile(req.params.id, `/data/${file}`, JSON.stringify(data, null, 2));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── RCON ────────────────────────────────────────────────────────────────────

function rconPacket(id, type, payload) {
  const body = Buffer.from(payload, 'utf8');
  const buf  = Buffer.alloc(4 + 4 + 4 + body.length + 2);
  buf.writeInt32LE(4 + 4 + body.length + 2, 0); // length (excl. length field)
  buf.writeInt32LE(id,   4);
  buf.writeInt32LE(type, 8);
  body.copy(buf, 12);
  buf.writeUInt8(0, 12 + body.length);
  buf.writeUInt8(0, 13 + body.length);
  return buf;
}

function sendRcon(host, port, password, command) {
  return new Promise((resolve, reject) => {
    const sock    = new net.Socket();
    let   rxBuf   = Buffer.alloc(0);
    let   authed  = false;
    const CMD_ID  = 2;

    const timer = setTimeout(() => { sock.destroy(); reject(new Error('RCON timeout')); }, 6000);

    sock.connect(port, host, () => sock.write(rconPacket(1, 3, password)));

    sock.on('data', chunk => {
      rxBuf = Buffer.concat([rxBuf, chunk]);
      while (rxBuf.length >= 12) {
        const len   = rxBuf.readInt32LE(0);
        const total = len + 4;
        if (rxBuf.length < total) break;
        const id      = rxBuf.readInt32LE(4);
        const payload = rxBuf.slice(12, total - 2).toString('utf8');
        rxBuf = rxBuf.slice(total);

        if (!authed) {
          if (id === -1) { clearTimeout(timer); sock.destroy(); reject(new Error('RCON auth failed — check password')); return; }
          authed = true;
          sock.write(rconPacket(CMD_ID, 2, command));
        } else {
          clearTimeout(timer);
          sock.destroy();
          resolve(payload);
        }
      }
    });

    sock.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

app.post('/api/containers/:id/rcon', auth, async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });
  try {
    const info  = await docker.getContainer(req.params.id).inspect();
    const typeFake = { Image: info.Config.Image, Names: [info.Name], Labels: info.Config.Labels || {} };
    if (detectServerType(typeFake) === 'bedrock') {
      return res.status(400).json({ error: 'Bedrock servers do not support RCON' });
    }

    const envMap = Object.fromEntries((info.Config.Env || []).map(e => {
      const i = e.indexOf('=');
      return [e.slice(0, i), e.slice(i + 1)];
    }));
    const rconPort  = parseInt(envMap.RCON_PORT  || '25575');
    const rconPass  = envMap.RCON_PASSWORD || '';
    const networks  = info.NetworkSettings.Networks;
    const ip        = Object.values(networks)[0]?.IPAddress || '127.0.0.1';

    const response = await sendRcon(ip, rconPort, rconPass, command);
    res.json({ response });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── WebSocket log streaming ──────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  const url  = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  const cid   = url.searchParams.get('container');

  try { jwt.verify(token, JWT_SECRET); }
  catch { ws.close(1008, 'Unauthorized'); return; }

  if (!cid) { ws.close(1008, 'No container ID'); return; }

  const container = docker.getContainer(cid);
  let logStream = null;

  container.logs({ follow: true, stdout: true, stderr: true, tail: 200 }, (err, stream) => {
    if (err) { ws.close(1011, err.message); return; }
    logStream = stream;

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    docker.modem.demuxStream(stream, stdout, stderr);

    const send = (data, type) => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type, data: data.toString('utf8') }));
    };

    stdout.on('data', d => send(d, 'stdout'));
    stderr.on('data', d => send(d, 'stderr'));
    stream.on('end', () => { if (ws.readyState === WebSocket.OPEN) ws.close(); });
  });

  ws.on('close', () => { if (logStream) logStream.destroy(); });
});

// ─── Start ───────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`MCPanel running on http://0.0.0.0:${PORT}`);
  console.log(`Default login: admin / admin`);
  console.log(`Set PANEL_PASSWORD_HASH env to change password (run: npm run hash <yourpassword>)`);
});
