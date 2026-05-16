'use strict';

const express = require('express');
const router = express.Router();
const { PassThrough } = require('stream');
const auth = require('../middleware/auth');
const { docker, detectServerType } = require('../services/docker');

// List Minecraft containers (Java + Bedrock)
router.get('/', auth, async (req, res) => {
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
router.get('/:id', auth, async (req, res) => {
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
router.post('/:id/action', auth, async (req, res) => {
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

// Execute command in container
router.post('/:id/command', auth, async (req, res) => {
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
      execCmd = ['send-command', ...command.split(/\s+/)];
    } else {
      // Java: use rcon-cli which connects via RCON protocol
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

module.exports = router;
