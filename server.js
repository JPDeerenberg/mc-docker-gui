'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const Docker = require('dockerode');
const jwt = require('jsonwebtoken');

const config = require('./src/config');
const authRouter = require('./src/routes/auth');
const containersRouter = require('./src/routes/containers');
const filesRouter = require('./src/routes/files');
const playersRouter = require('./src/routes/players');
const statsRouter = require('./src/routes/stats');

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Serve bundled Minecraft item/block textures from minecraft-assets package
const MC_ASSETS_VERSION = '1.20.2';
const MC_ASSETS_BASE = path.join(__dirname, 'node_modules', 'minecraft-assets', 'minecraft-assets', 'data', MC_ASSETS_VERSION);
app.use('/mc-textures/items',  express.static(path.join(MC_ASSETS_BASE, 'items'),  { maxAge: '7d' }));
app.use('/mc-textures/blocks', express.static(path.join(MC_ASSETS_BASE, 'blocks'), { maxAge: '7d' }));

// Mount API Routers
app.use('/api', authRouter);
app.use('/api/containers', containersRouter);
app.use('/api/containers', filesRouter);
app.use('/api/containers', playersRouter);
app.use('/api/stats', statsRouter);

// Serve index.html for root
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// WebSocket Log Stream Route
const wss = new WebSocket.Server({ server, path: '/ws/logs' });
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

wss.on('connection', (ws, req) => {
  const urlParams = new URLSearchParams(req.url.split('?')[1]);
  const token = urlParams.get('token');
  const containerId = urlParams.get('container');

  if (!token || !containerId) {
    ws.close(4001, 'Missing token or containerId');
    return;
  }
  try {
    jwt.verify(token, config.JWT_SECRET);
  } catch (err) {
    ws.close(4003, 'Invalid token');
    return;
  }

  const container = docker.getContainer(containerId);
  let logStream = null;

  container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    tail: 100
  }).then(stream => {
    logStream = stream;
    
    // Demux stream data
    stream.on('data', chunk => {
      let offset = 0;
      while (offset < chunk.length) {
        if (offset + 8 > chunk.length) break;
        const type = chunk.readUInt8(offset);
        const size = chunk.readUInt32BE(offset + 4);
        if (offset + 8 + size > chunk.length) break;
        const data = chunk.slice(offset + 8, offset + 8 + size).toString('utf8');
        
        ws.send(JSON.stringify({
          type: type === 2 ? 'stderr' : 'stdout',
          data: data
        }));
        
        offset += 8 + size;
      }
    });

    stream.on('end', () => ws.close());
    stream.on('error', () => ws.close());
  }).catch(err => {
    ws.send(JSON.stringify({ type: 'stderr', data: 'Failed to bind logs: ' + err.message }));
    ws.close();
  });

  ws.on('close', () => {
    if (logStream && typeof logStream.destroy === 'function') {
      logStream.destroy();
    }
  });
});

server.listen(config.PORT, () => {
  console.log(`Server listening on port ${config.PORT}`);
});
