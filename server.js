'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Docker = require('dockerode');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const tar = require('tar-stream');
const { PassThrough } = require('stream');
const nbt = require('prismarine-nbt');
const mcpeDb = require('leveldb-mcpe');
const fs = require('fs');

const os = require('os');
// ─── Config ──────────────────────────────────────────────────────────────────

const PORT        = process.env.PORT || 3000;
const JWT_SECRET  = process.env.JWT_SECRET || 'change-me-in-production-please';
const USERNAME    = process.env.PANEL_USERNAME || 'admin';
// Default password is "admin" — override via PANEL_PASSWORD_HASH (bcrypt hash)
// Docker Compose interpolates $ in .env files, so users must write $$ for literal $.
// We normalise here so both escaped ($$2a$$12$$…) and raw ($2a$12$…) forms work.
const rawHash     = process.env.PANEL_PASSWORD_HASH || '';
const PASS_HASH   = rawHash ? rawHash.replace(/\$\$/g, '$') : '$2a$12$KIXLz6H7j5/m.Cz.7Ij3OubqO3pDyL4W2Q8Q6P6zYfKk5hFcgGa2';

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

async function readContainerFileBuffer(id, filePath) {
  const container = docker.getContainer(id);
  const stream = await container.getArchive({ path: filePath });
  return new Promise((resolve, reject) => {
    const extract = tar.extract();
    const chunks = [];
    extract.on('entry', (header, s, next) => {
      s.on('data', chunk => chunks.push(chunk));
      s.on('end', next);
      s.resume();
    });
    extract.on('finish', () => resolve(Buffer.concat(chunks)));
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

async function listContainerDir(id, dirPath) {
  const container = docker.getContainer(id);
  const stream = await container.getArchive({ path: dirPath });
  return new Promise((resolve, reject) => {
    const extract = tar.extract();
    const files = [];
    extract.on('entry', (header, s, next) => {
      if (header.type === 'file') files.push(header.name);
      s.on('end', next);
      s.resume();
    });
    extract.on('finish', () => resolve(files));
    extract.on('error', reject);
    stream.pipe(extract);
  });
}

async function getWorldFolder(id) {
  try {
    const props = await readContainerFile(id, '/data/server.properties');
    const match = props.match(/^level-name\s*=\s*(.+)$/m);
    return match ? match[1].trim() : 'world';
  } catch {
    return 'world';
  }
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

// ─── All-players discovery & player data inspection ──────────────────────────

app.get('/api/containers/:id/all-players', auth, async (req, res) => {
  const { type = 'java' } = req.query;
  const id = req.params.id;

  try {
    if (type === 'bedrock') {
      // Bedrock: merge allowlist + permissions
      let allowlist = [], permissions = [];
      try { allowlist = JSON.parse(await readContainerFile(id, '/data/allowlist.json')); } catch {}
      try { permissions = JSON.parse(await readContainerFile(id, '/data/permissions.json')); } catch {}

      const playerMap = {};
      for (const p of allowlist) {
        const key = p.name || p.xuid || 'unknown';
        playerMap[key] = {
          name: p.name || 'Unknown',
          xuid: p.xuid || '',
          allowlisted: true,
          permission: 'member',
          hasData: true,
        };
      }
      for (const p of permissions) {
        const key = p.xuid || p.name || 'unknown';
        if (playerMap[key]) {
          playerMap[key].permission = p.permission || 'member';
          playerMap[key].hasData = true;
        } else {
          playerMap[key] = {
            name: p.name || p.xuid || 'Unknown',
            xuid: p.xuid || '',
            allowlisted: false,
            permission: p.permission || 'member',
            hasData: true,
          };
        }
      }

      res.json({
        players: Object.values(playerMap),
        hasPlayerData: true,
        worldFolder: 'Bedrock level',
      });
    } else {
      // Java: merge usercache + whitelist + ops + bans + playerdata folder
      const playerMap = {};
      const world = await getWorldFolder(id);

      // 1. usercache.json — all players who ever joined
      try {
        const ucRaw = await readContainerFile(id, '/data/usercache.json');
        const ucList = JSON.parse(ucRaw);
        for (const p of ucList) {
          if (!p.uuid) continue;
          playerMap[p.uuid] = {
            name: p.name,
            uuid: p.uuid,
            expiresOn: p.expiresOn || null,
            whitelisted: false,
            op: false,
            opLevel: 0,
            banned: false,
            banReason: '',
            hasData: false,
          };
        }
      } catch {}

      // 2. Scan playerdata folder for UUIDs with .dat files
      try {
        const datFiles = await listContainerDir(id, `/data/${world}/playerdata/`);
        for (const f of datFiles) {
          const base = path.basename(f);
          if (!base.endsWith('.dat')) continue;
          const uuid = base.replace('.dat', '');
          if (!playerMap[uuid]) {
            playerMap[uuid] = {
              name: uuid.slice(0, 8) + '…',
              uuid,
              whitelisted: false,
              op: false,
              opLevel: 0,
              banned: false,
              banReason: '',
              hasData: true,
            };
          } else {
            playerMap[uuid].hasData = true;
          }
        }
      } catch {}

      // 3. Whitelist
      try {
        const wl = JSON.parse(await readContainerFile(id, '/data/whitelist.json'));
        for (const p of wl) {
          if (p.uuid && playerMap[p.uuid]) {
            playerMap[p.uuid].whitelisted = true;
            if (p.name) playerMap[p.uuid].name = p.name;
          } else if (p.uuid) {
            playerMap[p.uuid] = {
              name: p.name || p.uuid.slice(0, 8) + '…',
              uuid: p.uuid,
              whitelisted: true, op: false, opLevel: 0,
              banned: false, banReason: '', hasData: false,
            };
          }
        }
      } catch {}

      // 4. Ops
      try {
        const ops = JSON.parse(await readContainerFile(id, '/data/ops.json'));
        for (const p of ops) {
          if (p.uuid && playerMap[p.uuid]) {
            playerMap[p.uuid].op = true;
            playerMap[p.uuid].opLevel = p.level || 4;
            if (p.name) playerMap[p.uuid].name = p.name;
          } else if (p.uuid) {
            playerMap[p.uuid] = {
              name: p.name || p.uuid.slice(0, 8) + '…',
              uuid: p.uuid,
              whitelisted: false, op: true, opLevel: p.level || 4,
              banned: false, banReason: '', hasData: false,
            };
          }
        }
      } catch {}

      // 5. Bans
      try {
        const bans = JSON.parse(await readContainerFile(id, '/data/banned-players.json'));
        for (const p of bans) {
          if (p.uuid && playerMap[p.uuid]) {
            playerMap[p.uuid].banned = true;
            playerMap[p.uuid].banReason = p.reason || '';
            if (p.name) playerMap[p.uuid].name = p.name;
          } else if (p.uuid) {
            playerMap[p.uuid] = {
              name: p.name || p.uuid.slice(0, 8) + '…',
              uuid: p.uuid,
              whitelisted: false, op: false, opLevel: 0,
              banned: true, banReason: p.reason || '', hasData: false,
            };
          }
        }
      } catch {}

      res.json({
        players: Object.values(playerMap),
        hasPlayerData: true,
        worldFolder: world,
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── System & Container Stats ─────────────────────────────────────────────────

app.get('/api/stats', auth, async (req, res) => {
  try {
    // 1. Host Stats
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const loadAvg = os.loadavg();
    const cpus = os.cpus();
    
    let temp = null;
    try {
      const tempStr = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8');
      temp = parseFloat(tempStr) / 1000;
    } catch(e) {}
    
    const hostStats = {
      ram: { total: totalMem, used: usedMem, free: freeMem },
      cpu: { loadAvg, cores: cpus.length },
      temp
    };

    // 2. Container Stats
    const all = await docker.listContainers({ all: true });
    // Filter for Minecraft containers exactly as in /api/containers
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

    const containerStats = await Promise.all(mc.map(async c => {
      let stats = null;
      let isRunning = c.State === 'running';
      if (isRunning) {
        try {
          const container = docker.getContainer(c.Id);
          stats = await container.stats({ stream: false });
        } catch(e) {}
      }

      let cpuPercent = 0;
      let memUsage = 0;
      let memLimit = 0;

      if (stats) {
        // Calculate CPU
        const cpuDelta = stats.cpu_stats?.cpu_usage?.total_usage - stats.precpu_stats?.cpu_usage?.total_usage;
        const systemDelta = stats.cpu_stats?.system_cpu_usage - stats.precpu_stats?.system_cpu_usage;
        if (systemDelta > 0 && cpuDelta > 0) {
          const cores = stats.cpu_stats?.online_cpus || cpus.length;
          cpuPercent = (cpuDelta / systemDelta) * cores * 100.0;
        }
        
        // Calculate Memory
        memUsage = stats.memory_stats?.usage || 0;
        // In cgroups v2, cache might be included. Real memory usage could be: usage - stats.memory_stats.stats.cache
        const cache = stats.memory_stats?.stats?.cache || stats.memory_stats?.stats?.file || 0;
        if (memUsage > cache) memUsage -= cache;
        memLimit = stats.memory_stats?.limit || 0;
      }

      return {
        id: c.Id,
        name: c.Names[0]?.replace(/^\//, '') || 'Unknown',
        type: detectServerType(c),
        state: c.State,
        cpuPercent,
        memUsage,
        memLimit
      };
    }));

    res.json({
      host: hostStats,
      containers: containerStats
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Bedrock LevelDB Extractor ───────────────────────────────────────────────

/**
 * Extract the LevelDB directory from a Bedrock container using dockerode's
 * getArchive API (no docker CLI needed) and save it to a local temp path.
 */
async function extractBedrockDb(containerId, worldName) {
  const tmpPath = `/tmp/mcpanel_db_${containerId}_${Date.now()}`;
  fs.mkdirSync(tmpPath, { recursive: true });

  const container = docker.getContainer(containerId);
  const dbPath = `/data/worlds/${worldName}/db`;
  const stream = await container.getArchive({ path: dbPath });

  const extractedFiles = [];
  await new Promise((resolve, reject) => {
    const extract = tar.extract();
    extract.on('entry', (header, entryStream, next) => {
      const dest = path.join(tmpPath, header.name);
      if (header.type === 'directory') {
        fs.mkdirSync(dest, { recursive: true });
        entryStream.on('end', next);
        entryStream.resume();
      } else if (header.type === 'file') {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const ws = fs.createWriteStream(dest);
        ws.on('error', reject);
        // Wait for write stream to CLOSE (fully flushed) before processing next entry
        ws.on('close', () => {
          extractedFiles.push(header.name);
          next();
        });
        entryStream.pipe(ws);
      } else {
        // Skip symlinks, etc.
        entryStream.on('end', next);
        entryStream.resume();
      }
    });
    extract.on('finish', resolve);
    extract.on('error', reject);
    stream.pipe(extract);
  });

  console.log(`[bedrock] Extracted ${extractedFiles.length} files: ${extractedFiles.join(', ')}`);

  // The tar archive extracts to tmpPath/db/ — return the db subfolder
  const dbDir = path.join(tmpPath, 'db');
  if (fs.existsSync(dbDir)) return { dbDir, tmpPath };
  // If there's no "db" subdirectory, the archive root IS the db contents
  return { dbDir: tmpPath, tmpPath };
}

/**
 * Parse Bedrock NBT player data into a normalised result object.
 */
function parseBedrockPlayerNbt(data) {
  const GAMEMODES = ['Survival', 'Creative', 'Adventure', 'Survival Spectator', 'Creative Spectator', 'Fallback', 'Spectator'];
  const DIMENSIONS = { 0: 'Overworld', 1: 'Nether', 2: 'The End' };

  const attributes = data.Attributes || [];
  const getAttr = (name, def) => {
    const attr = attributes.find(a => a.Name === name);
    return attr ? attr.Current : def;
  };

  return {
    health: getAttr('minecraft:health', 20),
    maxHealth: getAttr('minecraft:health', 20),
    foodLevel: getAttr('minecraft:player.hunger', 20),
    foodSaturation: getAttr('minecraft:player.saturation', 5),
    xpLevel: getAttr('minecraft:player.level', 0),
    xpTotal: data.PlayerLevel ?? 0,
    score: 0,
    gamemode: GAMEMODES[data.PlayerGameMode] || `Unknown (${data.PlayerGameMode})`,
    dimension: DIMENSIONS[data.DimensionId] || `Unknown (${data.DimensionId})`,
    position: data.Pos ? data.Pos.map(v => Math.round(v)) : [0, 0, 0],
    inventory: (data.Inventory || []).map(item => ({
      slot: item.Slot,
      id: (item.Name || '').replace('minecraft:', ''),
      count: item.Count || item.count || 1,
      damage: item.Damage || 0
    })),
    enderChest: (data.EnderChestInventory || []).map(item => ({
      slot: item.Slot,
      id: (item.Name || '').replace('minecraft:', ''),
      count: item.Count || item.count || 1,
      damage: item.Damage || 0
    })),
    armor: (data.Armor || []).map((item, i) => ({
      slot: 100 + i,
      id: (item.Name || '').replace('minecraft:', ''),
      count: item.Count || 1,
      damage: item.Damage || 0
    })),
    selectedSlot: 0
  };
}

async function getBedrockPlayerData(containerId, worldName, playerIdentifier) {
  let tmpPath = null;

  try {
    console.log(`[bedrock] Extracting DB for container=${containerId}, world="${worldName}", player="${playerIdentifier}"`);
    const extracted = await extractBedrockDb(containerId, worldName);
    tmpPath = extracted.tmpPath;
    console.log(`[bedrock] DB extracted to ${extracted.dbDir}`);
    // List all files in the db directory (including any subdirs)
    const allFiles = fs.readdirSync(extracted.dbDir);
    console.log(`[bedrock] DB dir contents (${allFiles.length} items): ${allFiles.join(', ')}`);
    // Also list the parent tmpPath to see full structure
    const tmpContents = fs.readdirSync(extracted.tmpPath);
    console.log(`[bedrock] Tmp root contents: ${tmpContents.join(', ')}`);

    // leveldb-mcpe has a simple sync API: open(path), get(key), close()
    // It uses a single global DB handle. get() returns raw bytes as a JS string.
    // There is NO iterator — we can only get by known key.
    mcpeDb.open(extracted.dbDir);
    console.log(`[bedrock] LevelDB opened successfully`);

    // Bedrock LevelDB stores player data under:
    //   "~local_player"         – the server host / realm owner
    //   "player_server_<UUID>"  – remote players (UUID format, NOT XUID)
    //   "player_<UUID>"         – older format
    //
    // We receive an XUID or player name from the frontend.
    // Since we can't iterate keys, we try direct key lookups first,
    // then fall back to ~local_player.

    let rawStr = null;
    let matchedKey = null;

    const keysToTry = [
      `player_server_${playerIdentifier}`,
      `player_${playerIdentifier}`,
      `~local_player`,
    ];

    for (const key of keysToTry) {
      try {
        const result = mcpeDb.get(key);
        if (result && result.length > 0) {
          rawStr = result;
          matchedKey = key;
          console.log(`[bedrock] Found data with key "${key}" (${result.length} bytes)`);
          break;
        }
      } catch (e) {
        // key not found or read error
      }
    }

    if (!rawStr) {
      throw new Error(`Player data not found for "${playerIdentifier}". Tried keys: ${keysToTry.join(', ')}`);
    }

    mcpeDb.close();

    // mcpeDb.get() returns binary data as a JS string — convert to Buffer for NBT parsing
    const rawBuffer = Buffer.from(rawStr, 'binary');
    console.log(`[bedrock] Parsing NBT from key "${matchedKey}" (${rawBuffer.length} bytes)`);

    const { parsed } = await nbt.parse(rawBuffer, 'little');
    const data = nbt.simplify(parsed);
    console.log(`[bedrock] NBT parsed successfully. GameMode=${data.PlayerGameMode}, Pos=${data.Pos}`);
    return parseBedrockPlayerNbt(data);

  } catch (err) {
    console.error(`[bedrock] FAILED:`, err.message);
    try { mcpeDb.close(); } catch (e) {}
    throw new Error(`Data extraction failed: ${err.message}`);
  } finally {
    if (tmpPath) {
      fs.rmSync(tmpPath, { recursive: true, force: true });
    }
  }
}

// Player NBT data (Java + Bedrock)
app.get('/api/containers/:id/player-data/:uuid', auth, async (req, res) => {
  try {
    const id = req.params.id;
    const uuid = req.params.uuid;
    const { type = 'java' } = req.query;
    const world = await getWorldFolder(id);

    console.log(`[player-data] type=${type}, world="${world}", uuid="${uuid}"`);

    if (type === 'bedrock') {
      console.log(`[player-data] Bedrock path: /data/worlds/${world}/db`);
      const data = await getBedrockPlayerData(id, world, uuid);
      return res.json(data);
    }

    const datPath = `/data/${world}/playerdata/${uuid}.dat`;

    const buf = await readContainerFileBuffer(id, datPath);
    const { parsed } = await nbt.parse(buf);
    const data = nbt.simplify(parsed);

    // Extract key fields
    const GAMEMODES = ['Survival', 'Creative', 'Adventure', 'Spectator'];
    const DIMENSIONS = {
      'minecraft:overworld': 'Overworld',
      'minecraft:the_nether': 'Nether',
      'minecraft:the_end': 'The End',
      0: 'Overworld', '-1': 'Nether', 1: 'The End',
    };

    const result = {
      health: data.Health ?? 20,
      maxHealth: 20,
      foodLevel: data.foodLevel ?? 20,
      foodSaturation: data.foodSaturationLevel ?? 5,
      xpLevel: data.XpLevel ?? 0,
      xpTotal: data.XpTotal ?? 0,
      score: data.Score ?? 0,
      gamemode: GAMEMODES[data.playerGameType] || `Unknown (${data.playerGameType})`,
      dimension: DIMENSIONS[data.Dimension] || data.Dimension || 'Unknown',
      position: data.Pos ? data.Pos.map(v => Math.round(v)) : [0, 0, 0],
      inventory: (data.Inventory || []).map(item => ({
        slot: item.Slot,
        id: (item.id || '').replace('minecraft:', ''),
        count: item.Count || item.count || 1,
        damage: item.Damage || 0,
      })),
      enderChest: (data.EnderItems || []).map(item => ({
        slot: item.Slot,
        id: (item.id || '').replace('minecraft:', ''),
        count: item.Count || item.count || 1,
        damage: item.Damage || 0,
      })),
      armor: [],
      selectedSlot: data.SelectedItemSlot ?? 0,
    };

    // Separate armor from inventory (slots 100-103)
    result.armor = result.inventory.filter(i => i.slot >= 100 && i.slot <= 103);
    result.inventory = result.inventory.filter(i => i.slot >= 0 && i.slot < 100);

    res.json(result);
  } catch (err) {
    console.error(`[player-data] Error:`, err);
    res.status(500).json({ error: err.message });
  }
});

// Delete player data files (Java only)
app.delete('/api/containers/:id/player-data/:uuid', auth, async (req, res) => {
  try {
    const id = req.params.id;
    const uuid = req.params.uuid;
    const world = await getWorldFolder(id);
    const container = docker.getContainer(id);

    // Delete files via docker exec rm -f
    const files = [
      `/data/${world}/playerdata/${uuid}.dat`,
      `/data/${world}/playerdata/${uuid}.dat_old`,
      `/data/${world}/stats/${uuid}.json`,
      `/data/${world}/advancements/${uuid}.json`
    ];

    for (const f of files) {
      try {
        const exec = await container.exec({ Cmd: ['rm', '-f', f] });
        await exec.start();
      } catch (e) {
        console.error(`Failed to delete ${f}:`, e.message);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Player stats (Java only — already JSON)
app.get('/api/containers/:id/player-stats/:uuid', auth, async (req, res) => {
  try {
    const id = req.params.id;
    const uuid = req.params.uuid;
    const world = await getWorldFolder(id);
    const statsPath = `/data/${world}/stats/${uuid}.json`;

    const raw = await readContainerFile(id, statsPath);
    const data = JSON.parse(raw);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Docker exec command ──────────────────────────────────────────────────────

/**
 * Send a command to a running Minecraft server container via docker exec.
 *
 * For Java servers (itzg/minecraft-server): uses `rcon-cli` which connects
 * via the RCON protocol and returns output directly.
 *
 * For Bedrock servers (itzg/minecraft-bedrock-server): uses `send-command`
 * which is a helper script included in the itzg bedrock image that pipes
 * commands into the server's stdin.
 *
 * Falls back to a generic stdin pipe approach for non-itzg images.
 */
app.post('/api/containers/:id/command', auth, async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });
  try {
    const container = docker.getContainer(req.params.id);
    const info = await container.inspect();

    // Make sure the container is running
    if (!info.State.Running) {
      return res.status(400).json({ error: 'Container is not running' });
    }

    // Detect server type from container metadata
    const typeFake = { Image: info.Config.Image, Names: [info.Name], Labels: info.Config.Labels || {} };
    const serverType = detectServerType(typeFake);

    // Build the exec command based on server type
    let execCmd;
    if (serverType === 'bedrock') {
      // Bedrock: use the itzg send-command helper script
      // send-command expects each word as a separate argument:
      //   send-command gamerule dofiretick false
      execCmd = ['send-command', ...command.split(/\s+/)];
    } else {
      // Java: use rcon-cli which connects via RCON protocol
      // rcon-cli accepts the full command as a single string argument:
      //   rcon-cli "gamerule doDaylightCycle false"
      execCmd = ['rcon-cli', command];
    }

    const exec = await container.exec({
      Cmd: execCmd,
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({ Detach: false });
    let output = '';

    await new Promise((resolve, reject) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      docker.modem.demuxStream(stream, stdout, stderr);

      stdout.on('data', chunk => { output += chunk.toString('utf8'); });
      stderr.on('data', chunk => { output += chunk.toString('utf8'); });
      stream.on('end', resolve);
      stream.on('error', reject);

      // Timeout after 10 seconds (rcon-cli may take a moment to connect)
      setTimeout(resolve, 10000);
    });

    res.json({ response: output.trim() || '' });
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
