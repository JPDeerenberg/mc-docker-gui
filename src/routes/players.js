'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const nbt = require('prismarine-nbt');
const auth = require('../middleware/auth');
const {
  docker,
  readContainerFile,
  readContainerFileBuffer,
  writeContainerFile,
  listContainerDir,
  getWorldFolder
} = require('../services/docker');
const { getBedrockPlayerData, getBedrockPlayers } = require('../services/bedrock');

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

// Get players configurations
router.get('/:id/players', auth, async (req, res) => {
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

// Update players configurations
router.put('/:id/players', auth, async (req, res) => {
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

// Universal player discovery
router.get('/:id/all-players', auth, async (req, res) => {
  const { type = 'java' } = req.query;
  const id = req.params.id;

  try {
    if (type === 'bedrock') {
      const world = await getWorldFolder(id);

      // Bedrock: merge allowlist + permissions + leveldb players
      let allowlist = [], permissions = [];
      try { allowlist = JSON.parse(await readContainerFile(id, '/data/allowlist.json')); } catch {}
      try { permissions = JSON.parse(await readContainerFile(id, '/data/permissions.json')); } catch {}

      let leveldbPlayers = [];
      try {
        leveldbPlayers = await getBedrockPlayers(id, world);
      } catch (err) {
        console.error(`[bedrock-routes] Failed to scan LevelDB for players:`, err.message);
      }

      const playerMap = {};

      // 1. Populate from LevelDB players (they have data!)
      for (const p of leveldbPlayers) {
        const key = p.uuid;
        playerMap[key] = {
          name: p.name,
          xuid: p.uuid,
          allowlisted: false,
          permission: 'member',
          hasData: true,
        };
      }

      // 2. Merge allowlist
      for (const p of allowlist) {
        const xuid = p.xuid || '';
        const name = p.name || '';
        
        let matched = null;
        if (xuid && playerMap[xuid]) {
          matched = playerMap[xuid];
        } else {
          matched = Object.values(playerMap).find(lp => lp.name.toLowerCase() === name.toLowerCase());
        }

        if (matched) {
          matched.allowlisted = true;
          if (p.xuid) matched.xuid = p.xuid;
          if (p.name) matched.name = p.name;
        } else {
          const key = xuid || name || 'unknown';
          playerMap[key] = {
            name: name || 'Unknown',
            xuid: xuid,
            allowlisted: true,
            permission: 'member',
            hasData: false,
          };
        }
      }

      // 3. Merge permissions
      for (const p of permissions) {
        const xuid = p.xuid || '';
        const name = p.name || '';

        let matched = null;
        if (xuid && playerMap[xuid]) {
          matched = playerMap[xuid];
        } else {
          matched = Object.values(playerMap).find(lp => lp.name.toLowerCase() === name.toLowerCase());
        }

        if (matched) {
          matched.permission = p.permission || 'member';
          if (p.xuid) matched.xuid = p.xuid;
          if (p.name) matched.name = p.name;
        } else {
          const key = xuid || name || 'unknown';
          playerMap[key] = {
            name: name || xuid || 'Unknown',
            xuid: xuid,
            allowlisted: false,
            permission: p.permission || 'member',
            hasData: false,
          };
        }
      }

      res.json({
        players: Object.values(playerMap),
        hasPlayerData: true,
        worldFolder: world,
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

// Detailed player NBT and inventory inspection
router.get('/:id/player-data/:uuid', auth, async (req, res) => {
  try {
    const id = req.params.id;
    const uuid = req.params.uuid;
    const { type = 'java' } = req.query;
    const world = await getWorldFolder(id);

    console.log(`[player-data] type=${type}, world="${world}", uuid="${uuid}"`);

    if (type === 'bedrock') {
      try {
        const data = await getBedrockPlayerData(id, world, uuid);
        return res.json(data);
      } catch (bedrockErr) {
        if (bedrockErr.code === 'PLAYER_NOT_JOINED' ||
            (bedrockErr.message && bedrockErr.message.includes('not joined'))) {
          return res.status(404).json({ error: bedrockErr.message, notJoined: true });
        }
        throw bedrockErr;
      }
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
router.delete('/:id/player-data/:uuid', auth, async (req, res) => {
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
router.get('/:id/player-stats/:uuid', auth, async (req, res) => {
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

module.exports = router;
