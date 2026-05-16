'use strict';

const mcpeDb = require('leveldb-mcpe');
const nbt = require('prismarine-nbt');
const fs = require('fs');
const path = require('path');
const tar = require('tar-stream');
const { docker } = require('./docker');

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

// ══════════════════════════════════════════════
//  SERIALIZATION MUTEX QUEUE FOR SINGLETON LEVELDB
// ══════════════════════════════════════════════
let dbLock = Promise.resolve();

async function runSerialized(fn) {
  return new Promise((resolve, reject) => {
    dbLock = dbLock.then(async () => {
      try {
        const result = await fn();
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function getBedrockPlayerDataInternal(containerId, worldName, playerIdentifier) {
  let tmpPath = null;
  let isOpen = false;

  try {
    console.log(`[bedrock] Extracting DB for container=${containerId}, world="${worldName}", player="${playerIdentifier}"`);
    const extracted = await extractBedrockDb(containerId, worldName);
    tmpPath = extracted.tmpPath;
    console.log(`[bedrock] DB extracted to ${extracted.dbDir}`);

    mcpeDb.open(extracted.dbDir);
    isOpen = true;
    console.log(`[bedrock] LevelDB opened successfully`);

    const allKeys = mcpeDb.getKeys();
    const activePlayerKeys = allKeys.filter(k => k.startsWith('player_server_') || k === '~local_player');
    const mappingKeys = allKeys.filter(k => k.startsWith('player_') && !k.startsWith('player_server_'));
    console.log(`[bedrock] DB has ${allKeys.length} total keys, ${activePlayerKeys.length} active player keys, ${mappingKeys.length} mapping keys`);

    if (activePlayerKeys.length === 0) {
      mcpeDb.close();
      isOpen = false;
      const err = new Error('Player has not joined this server yet');
      err.code = 'PLAYER_NOT_JOINED';
      throw err;
    }

    let matchedKey = null;

    // 1. Try exact key match with active keys
    for (const key of activePlayerKeys) {
      if (key === playerIdentifier ||
          key === `player_server_${playerIdentifier}`) {
        matchedKey = key;
        break;
      }
    }

    // 2. Try mapping keys (resolving XUID/MSA ID -> ServerId)
    if (!matchedKey) {
      for (const key of mappingKeys) {
        if (key === `player_${playerIdentifier}` || key.slice('player_'.length) === playerIdentifier) {
          const val = mcpeDb.get(key);
          if (val && val.length > 0) {
            try {
              const buf = Buffer.isBuffer(val) ? val : Buffer.from(val, 'binary');
              const { parsed } = await nbt.parse(buf, 'little');
              const data = nbt.simplify(parsed);
              if (data.ServerId && activePlayerKeys.includes(data.ServerId)) {
                matchedKey = data.ServerId;
                console.log(`[bedrock] Resolved identifier "${playerIdentifier}" to ServerId "${matchedKey}" via mapping key "${key}"`);
                break;
              }
            } catch (e) {}
          }
        }
      }
    }

    // 3. Search active keys for NameTag match
    if (!matchedKey) {
      for (const key of activePlayerKeys) {
        const val = mcpeDb.get(key);
        if (!val || val.length === 0) continue;
        try {
          const buf = Buffer.isBuffer(val) ? val : Buffer.from(val, 'binary');
          const { parsed } = await nbt.parse(buf, 'little');
          const d = nbt.simplify(parsed);
          const nameTag = d.NameTag || '';
          if (nameTag.toLowerCase() === playerIdentifier.toLowerCase()) {
            matchedKey = key;
            console.log(`[bedrock] Matched by NameTag "${nameTag}" in key "${key}"`);
            break;
          }
        } catch (e) {}
      }
    }

    // 4. Try matching raw string content of active keys (last resort search)
    if (!matchedKey) {
      for (const key of activePlayerKeys) {
        const val = mcpeDb.get(key);
        if (val && val.length > 0 && val.includes(playerIdentifier)) {
          matchedKey = key;
          console.log(`[bedrock] Matched by raw content search in key "${key}"`);
          break;
        }
      }
    }

    // 5. Fallback to the first active player key
    if (!matchedKey) {
      matchedKey = activePlayerKeys[0];
      console.log(`[bedrock] Fallback to key "${matchedKey}"`);
    }

    const rawStr = mcpeDb.get(matchedKey);
    mcpeDb.close();
    isOpen = false;

    if (!rawStr || rawStr.length === 0) {
      throw new Error(`Player data not found for "${playerIdentifier}"`);
    }

    const rawBuffer = Buffer.isBuffer(rawStr) ? rawStr : Buffer.from(rawStr, 'binary');
    console.log(`[bedrock] Parsing NBT from key "${matchedKey}" (${rawBuffer.length} bytes)`);

    const { parsed } = await nbt.parse(rawBuffer, 'little');
    const data = nbt.simplify(parsed);
    console.log(`[bedrock] NBT parsed successfully. GameMode=${data.PlayerGameMode}, Pos=${data.Pos}`);
    return parseBedrockPlayerNbt(data);

  } catch (err) {
    console.error(`[bedrock] getBedrockPlayerDataInternal FAILED:`, err.message);
    if (isOpen) {
      try { mcpeDb.close(); } catch (e) {}
      isOpen = false;
    }
    throw new Error(`Data extraction failed: ${err.message}`);
  } finally {
    if (tmpPath) {
      fs.rmSync(tmpPath, { recursive: true, force: true });
    }
  }
}

async function getBedrockPlayersInternal(containerId, worldName) {
  let tmpPath = null;
  let isOpen = false;

  try {
    console.log(`[bedrock] Extracting DB for player listing: container=${containerId}, world="${worldName}"`);
    const extracted = await extractBedrockDb(containerId, worldName);
    tmpPath = extracted.tmpPath;
    console.log(`[bedrock] DB extracted to ${extracted.dbDir}`);

    mcpeDb.open(extracted.dbDir);
    isOpen = true;
    console.log(`[bedrock] LevelDB opened successfully for listing`);

    const allKeys = mcpeDb.getKeys();
    const activePlayerKeys = allKeys.filter(k => k.startsWith('player_server_') || k === '~local_player');
    const mappingKeys = allKeys.filter(k => k.startsWith('player_') && !k.startsWith('player_server_'));
    console.log(`[bedrock] DB has ${allKeys.length} total keys, ${activePlayerKeys.length} active player keys, ${mappingKeys.length} mapping keys`);

    const serverToXuidMap = {};
    for (const key of mappingKeys) {
      const val = mcpeDb.get(key);
      if (!val || val.length === 0) continue;
      try {
        const buf = Buffer.isBuffer(val) ? val : Buffer.from(val, 'binary');
        const { parsed } = await nbt.parse(buf, 'little');
        const data = nbt.simplify(parsed);
        
        const serverId = data.ServerId;
        const xuid = data.PlatformOnlineId;
        if (serverId && xuid) {
          serverToXuidMap[serverId] = xuid;
        }
      } catch (e) {}
    }

    const players = [];
    for (const key of activePlayerKeys) {
      const val = mcpeDb.get(key);
      if (!val || val.length === 0) continue;
      try {
        const buf = Buffer.isBuffer(val) ? val : Buffer.from(val, 'binary');
        const { parsed } = await nbt.parse(buf, 'little');
        const data = nbt.simplify(parsed);

        let uuid = '';
        if (key.startsWith('player_server_')) {
          uuid = key.slice('player_server_'.length);
        } else {
          uuid = key;
        }

        const xuid = serverToXuidMap[key] || '';
        players.push({
          uuid,
          xuid,
          name: data.NameTag || 'Unknown',
          hasData: true
        });
      } catch (e) {
        console.error(`[bedrock] Failed to parse active player key "${key}" during listing:`, e.message);
      }
    }

    mcpeDb.close();
    isOpen = false;
    return players;

  } catch (err) {
    console.error(`[bedrock] getBedrockPlayersInternal FAILED:`, err.message);
    if (isOpen) {
      try { mcpeDb.close(); } catch (e) {}
      isOpen = false;
    }
    // Return empty array instead of throwing to prevent complete UI crash when world has no players/DB yet
    return [];
  } finally {
    if (tmpPath) {
      fs.rmSync(tmpPath, { recursive: true, force: true });
    }
  }
}

async function getBedrockPlayerData(containerId, worldName, playerIdentifier) {
  return runSerialized(() => getBedrockPlayerDataInternal(containerId, worldName, playerIdentifier));
}

async function getBedrockPlayers(containerId, worldName) {
  return runSerialized(() => getBedrockPlayersInternal(containerId, worldName));
}

module.exports = {
  extractBedrockDb,
  parseBedrockPlayerNbt,
  getBedrockPlayerData,
  getBedrockPlayers
};
