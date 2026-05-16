'use strict';

const express = require('express');
const router = express.Router();
const os = require('os');
const fs = require('fs');
const auth = require('../middleware/auth');
const { docker, detectServerType } = require('../services/docker');

router.get('/', auth, async (req, res) => {
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
    // Filter for Minecraft containers
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

module.exports = router;
