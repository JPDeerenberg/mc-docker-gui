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
    const allFiles = fs.readdirSync(extracted.dbDir);
    console.log(`[bedrock] DB dir contents (${allFiles.length} items): ${allFiles.join(', ')}`);

    mcpeDb.open(extracted.dbDir);
    isOpen = true;
    console.log(`[bedrock] LevelDB opened successfully`);

    // Discover what player keys exist in the database
    const allKeys = mcpeDb.getKeys();
    const playerKeys = allKeys.filter(k =>
      k.startsWith('player_server_') || k.startsWith('player_') || k === '~local_player'
    );
    console.log(`[bedrock] DB has ${allKeys.length} total keys, ${playerKeys.length} player keys`);

    if (playerKeys.length === 0) {
      mcpeDb.close();
      isOpen = false;
      const err = new Error('Player has not joined this server yet');
      err.code = 'PLAYER_NOT_JOINED';
      throw err;
    }

    // Try to find the right player entry
    let rawStr = null;
    let matchedKey = null;

    // 1. Try exact key match with the identifier (in case it IS a UUID)
    for (const key of playerKeys) {
      if (key === `player_server_${playerIdentifier}` ||
          key === `player_${playerIdentifier}`) {
        rawStr = mcpeDb.get(key);
        matchedKey = key;
        break;
      }
    }

    // 2. Search for the identifier (XUID or name) in the raw NBT bytes
    if (!rawStr) {
      for (const key of playerKeys) {
        const val = mcpeDb.get(key);
        if (val && val.length > 0 && val.includes(playerIdentifier)) {
          rawStr = val;
          matchedKey = key;
          console.log(`[bedrock] Matched by raw content search in key "${key}"`);
          break;
        }
      }
    }

    // 3. If only one player entry exists, use it
    if (!rawStr && playerKeys.length === 1) {
      const key = playerKeys[0];
      rawStr = mcpeDb.get(key);
      matchedKey = key;
      console.log(`[bedrock] Using only available player key "${key}"`);
    }

    // 4. Try parsing each entry's NBT and check NameTag
    if (!rawStr) {
      for (const key of playerKeys) {
        const val = mcpeDb.get(key);
        if (!val || val.length === 0) continue;
        try {
          const buf = Buffer.from(val, 'binary');
          const { parsed } = await nbt.parse(buf, 'little');
          const d = nbt.simplify(parsed);
          const nameTag = d.NameTag || '';
          if (nameTag.toLowerCase() === playerIdentifier.toLowerCase()) {
            rawStr = val;
            matchedKey = key;
            console.log(`[bedrock] Matched by NameTag "${nameTag}" in key "${key}"`);
            break;
          }
        } catch (e) { /* skip unparseable */ }
      }
    }

    // 5. Last resort: just use the first player_server_ or player_ entry
    if (!rawStr) {
      const serverKey = playerKeys.find(k => k.startsWith('player_server_'));
      const playerKey = playerKeys.find(k => k.startsWith('player_') && !k.startsWith('player_server_'));
      const localKey = playerKeys.find(k => k === '~local_player');
      const fallbackKey = serverKey || playerKey || localKey;
      if (fallbackKey) {
        rawStr = mcpeDb.get(fallbackKey);
        matchedKey = fallbackKey;
        console.log(`[bedrock] Fallback to key "${fallbackKey}"`);
      }
    }

    mcpeDb.close();
    isOpen = false;

    if (!rawStr || rawStr.length === 0) {
      throw new Error(`Player data not found for "${playerIdentifier}" (searched ${playerKeys.length} keys)`);
    }

    // mcpeDb.get() returns binary data as a JS string — convert to Buffer for NBT parsing
    const rawBuffer = Buffer.from(rawStr, 'binary');
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
    const playerKeys = allKeys.filter(k =>
      k.startsWith('player_server_') || k.startsWith('player_') || k === '~local_player'
    );
    console.log(`[bedrock] DB has ${allKeys.length} total keys, ${playerKeys.length} player keys`);
    if (playerKeys.length === 0 && allKeys.length > 0) {
      console.log(`[bedrock] First 10 keys found in LevelDB:`, allKeys.slice(0, 10));
    }

    const players = [];
    for (const key of playerKeys) {
      const val = mcpeDb.get(key);
      if (!val || val.length === 0) continue;
      try {
        const buf = Buffer.from(val, 'binary');
        const { parsed } = await nbt.parse(buf, 'little');
        const data = nbt.simplify(parsed);

        let uuid = '';
        if (key.startsWith('player_server_')) {
          uuid = key.slice('player_server_'.length);
        } else if (key.startsWith('player_')) {
          uuid = key.slice('player_'.length);
        } else {
          uuid = key; // ~local_player
        }

        players.push({
          uuid,
          name: data.NameTag || 'Unknown',
          hasData: true
        });
      } catch (e) {
        console.error(`[bedrock] Failed to parse player key "${key}" during listing:`, e.message);
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
