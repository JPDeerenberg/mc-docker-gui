'use strict';

const Docker = require('dockerode');
const tar = require('tar-stream');
const path = require('path');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

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

module.exports = {
  docker,
  detectServerType,
  readContainerFile,
  readContainerFileBuffer,
  writeContainerFile,
  listContainerDir,
  getWorldFolder
};
