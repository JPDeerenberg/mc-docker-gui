// ══════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════
const state = {
  token: localStorage.getItem('mcpanel_token'),
  containers: [],
  currentContainer: null,
  serverType: 'java',
  players: {},
  allPlayers: [],
  allPlayersFilter: 'all',
  allPlayersSearch: '',
  selectedPlayerUuid: null,
  playerDataCache: {},
  playerStatsCache: {},
  currentPtab: 'whitelist',
  propsRaw: '',
  wsConn: null,

  autoScroll: true,
  cmdHistory: [],
  cmdHistoryIdx: -1,
  activeFilter: 'all',
};

// ══════════════════════════════════════════════
//  API helpers
// ══════════════════════════════════════════════
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || 'Request failed');
    err.data = data;
    throw err;
  }
  return data;
}

// ══════════════════════════════════════════════
//  TOAST
// ══════════════════════════════════════════════
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ══════════════════════════════════════════════
//  ROUTING / VIEWS
// ══════════════════════════════════════════════
function showView(name) {
  ['view-login', 'view-app'].forEach(id => {
    document.getElementById(id).classList.toggle('hidden', id !== `view-${name === 'login' ? 'login' : 'app'}`);
  });
  if (name !== 'login') {
    ['page-dashboard', 'page-container', 'page-stats'].forEach(id => {
      document.getElementById(id).classList.toggle('hidden', id !== `page-${name}`);
    });
    const bc = document.getElementById('nav-breadcrumb');
    bc.classList.toggle('hidden', name !== 'container');

    // Update top links
    document.querySelectorAll('.top-link-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.page === name);
    });

    if (name === 'stats') {
      loadStats();
      if (!window.statsInterval) {
        window.statsInterval = setInterval(loadStats, 5000);
      }
    } else {
      if (window.statsInterval) {
        clearInterval(window.statsInterval);
        window.statsInterval = null;
      }
    }
  }
}

document.querySelectorAll('.top-link-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const page = btn.dataset.page;
    showView(page);
    if (page === 'dashboard') loadContainers();
  });
});

// ══════════════════════════════════════════════
//  LOGIN
// ══════════════════════════════════════════════
document.getElementById('login-btn').addEventListener('click', doLogin);
document.getElementById('inp-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

async function doLogin() {
  const btn = document.getElementById('login-btn');
  const err = document.getElementById('login-error');
  const u   = document.getElementById('inp-user').value.trim();
  const p   = document.getElementById('inp-pass').value;
  err.classList.add('hidden');
  btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    const res = await api('POST', '/api/login', { username: u, password: p });
    state.token = res.token;
    localStorage.setItem('mcpanel_token', res.token);
    showView('dashboard');
    loadContainers();
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false; btn.textContent = 'Sign In';
  }
}

document.getElementById('logout-btn').addEventListener('click', () => {
  state.token = null;
  localStorage.removeItem('mcpanel_token');
  closeWs();
  showView('login');
});

// ══════════════════════════════════════════════
//  DASHBOARD
// ══════════════════════════════════════════════
document.getElementById('nav-home').addEventListener('click', () => {
  closeWs();
  showView('dashboard');
  loadContainers();
});
document.getElementById('back-btn').addEventListener('click', () => {
  closeWs();
  showView('dashboard');
  loadContainers();
});

const refreshBtn = document.getElementById('refresh-btn');
refreshBtn.addEventListener('click', () => loadContainers());

document.getElementById('stats-refresh-btn').addEventListener('click', loadStats);

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes) || bytes === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'], i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function loadStats() {
  const btn = document.getElementById('stats-refresh-btn');
  btn.classList.add('spinning');
  try {
    const res = await api('GET', '/api/stats');
    if (!res) return;

    // Render Host
    const h = res.host;
    const cpuPct = (h.cpu.loadAvg[0] / h.cpu.cores) * 100;
    const cpuFmt = Math.min(100, Math.max(0, cpuPct)).toFixed(1);
    const ramPct = (h.ram.used / h.ram.total) * 100;
    const tempFmt = h.temp !== null ? h.temp.toFixed(1) + '°C' : 'N/A';

    document.getElementById('stats-host-grid').innerHTML = `
      <div class="stat-hero-card">
        <div class="stat-hero-label">CPU Load</div>
        <div class="stat-hero-val">${cpuFmt}%</div>
        <div class="stat-hero-sub">${h.cpu.cores} cores • avg: ${h.cpu.loadAvg[0].toFixed(2)}</div>
        <div class="prog-bar-bg"><div class="prog-bar-fill ${cpuPct > 85 ? 'crit' : cpuPct > 60 ? 'warn' : ''}" style="width:${Math.min(100, cpuPct)}%"></div></div>
      </div>
      <div class="stat-hero-card">
        <div class="stat-hero-label">Memory</div>
        <div class="stat-hero-val">${ramPct.toFixed(1)}%</div>
        <div class="stat-hero-sub">${formatBytes(h.ram.used)} / ${formatBytes(h.ram.total)}</div>
        <div class="prog-bar-bg"><div class="prog-bar-fill ${ramPct > 85 ? 'crit' : ramPct > 60 ? 'warn' : ''}" style="width:${Math.min(100, ramPct)}%"></div></div>
      </div>
      <div class="stat-hero-card">
        <div class="stat-hero-label">Temperature</div>
        <div class="stat-hero-val">${tempFmt}</div>
        <div class="stat-hero-sub">Thermal Zone 0</div>
      </div>
    `;

    // Render Containers
    let html = '';
    for (const c of res.containers) {
      const isRunning = c.state === 'running';
      const cPct = c.cpuPercent.toFixed(1);
      const memFmt = formatBytes(c.memUsage);
      
      html += `
        <div class="srv-stat-card">
          <div class="srv-stat-header">
            <div class="srv-stat-name">${c.name}</div>
            <span class="badge ${isRunning ? 'running' : 'stopped'}">${c.state}</span>
          </div>
          <div style="margin-top:4px;">
            <div class="srv-stat-row">
              <span class="srv-stat-lbl">CPU Usage</span>
              <span class="srv-stat-val ${c.cpuPercent > 80 ? 'text-warn' : ''}">${isRunning ? cPct + '%' : '-'}</span>
            </div>
            <div class="prog-bar-bg" style="margin-top:6px; margin-bottom:8px; height:4px;">
              <div class="prog-bar-fill" style="width:${isRunning ? Math.min(100, c.cpuPercent) : 0}%"></div>
            </div>
            <div class="srv-stat-row">
              <span class="srv-stat-lbl">RAM Usage</span>
              <span class="srv-stat-val">${isRunning ? memFmt : '-'}</span>
            </div>
            <div class="prog-bar-bg" style="margin-top:6px; height:4px;">
              <div class="prog-bar-fill" style="width:${isRunning && c.memLimit ? Math.min(100, (c.memUsage / c.memLimit) * 100) : 0}%"></div>
            </div>
          </div>
        </div>
      `;
    }
    document.getElementById('stats-srv-grid').innerHTML = html || `<div style="grid-column:1/-1" class="empty-state">No servers found</div>`;

  } catch (err) {
    if (err.message.includes('401') || err.message.toLowerCase().includes('unauthorized')) {
      showView('login');
    } else {
      toast('Failed to load stats: ' + err.message, 'error');
    }
  } finally {
    btn.classList.remove('spinning');
  }
}

async function loadContainers() {
  const icon = document.getElementById('refresh-icon');
  refreshBtn.classList.add('spinning');
  try {
    state.containers = await api('GET', '/api/containers');
    renderContainers();
  } catch (e) {
    if (e.message.includes('401') || e.message.toLowerCase().includes('unauthorized')) {
      showView('login');
    } else {
      toast(e.message, 'error');
    }
  } finally {
    refreshBtn.classList.remove('spinning');
  }
}

// Filter pills
document.getElementById('filter-pills').addEventListener('click', e => {
  const pill = e.target.closest('.pill');
  if (!pill) return;
  state.activeFilter = pill.dataset.filter;
  document.querySelectorAll('.pill').forEach(p => p.classList.toggle('active', p === pill));
  renderContainers();
});

function renderContainers() {
  const grid = document.getElementById('containers-grid');
  const list = state.containers.filter(c =>
    state.activeFilter === 'all' || c.serverType === state.activeFilter
  );
  if (!list.length) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <div class="emoji">🔍</div>
        <h3>No Minecraft containers found</h3>
        <p>MCPanel looks for containers with "minecraft" or "bedrock" in the image/name, or label <code>mcpanel=true</code>.</p>
      </div>`;
    return;
  }
  grid.innerHTML = list.map(c => {
    const name   = (c.Names[0] || '').replace('/', '');
    const status = c.State.toLowerCase();
    const port   = c.Ports?.find(p => p.PublicPort)?.PublicPort;
    const type   = c.serverType || 'java';
    const typeIcon = type === 'bedrock' ? '🪨' : '☕';
    const typeLabel = type === 'bedrock' ? 'Bedrock' : 'Java';
    return `
      <div class="container-card ${type}" data-id="${c.Id}">
        <div class="card-top">
          <div class="card-icon">${typeIcon}</div>
          <div style="display:flex;gap:6px;align-items:center">
            <span class="type-badge ${type}">${typeLabel}</span>
            <span class="badge ${status}">${status}</span>
          </div>
        </div>
        <div class="card-name">${name}</div>
        <div class="card-image">${c.Image}</div>
        <div class="card-meta">
          ${port ? `<div class="card-meta-item"><strong>${port}</strong> port</div>` : ''}
          <div class="card-meta-item"><strong>${c.Status}</strong></div>
        </div>
      </div>`;
  }).join('');

  grid.querySelectorAll('.container-card').forEach(card => {
    card.addEventListener('click', () => openContainer(card.dataset.id));
  });
}

// ══════════════════════════════════════════════
//  CONTAINER DETAIL
// ══════════════════════════════════════════════
async function openContainer(id) {
  try {
    const info = await api('GET', `/api/containers/${id}`);
    state.currentContainer = info;
    state.serverType = info._serverType || 'java';
    showView('container');

    const name = info.Name.replace('/', '');
    document.getElementById('detail-name').textContent = name;
    document.getElementById('nav-bc-name').textContent = name;
    document.getElementById('console-label').textContent = `${name} — logs`;

    // Type badge
    const typeBadge = document.getElementById('detail-type-badge');
    typeBadge.textContent = state.serverType === 'bedrock' ? '🪨 Bedrock' : '☕ Java';
    typeBadge.className = `type-badge ${state.serverType}`;

    const statusEl = document.getElementById('detail-status');
    const s = (info.State.Status || '').toLowerCase();
    statusEl.textContent = s;
    statusEl.className = `badge ${s}`;

    const running = s === 'running';
    document.getElementById('btn-start').disabled   = running;
    document.getElementById('btn-stop').disabled    = !running;
    document.getElementById('btn-restart').disabled = !running;

    // Enable command input for all server types (using docker exec)
    const cmdInput = document.getElementById('cmd-input');
    const cmdSend  = document.getElementById('cmd-send');
    cmdInput.disabled = false;
    cmdSend.disabled  = false;
    cmdInput.placeholder = 'Type a command and press Enter…';

    // Switch to console tab
    switchTab('console');
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'console'));

    startLogStream(id);
  } catch (e) {
    toast(e.message, 'error');
  }
}

// Container actions
['start', 'stop', 'restart'].forEach(action => {
  document.getElementById(`btn-${action}`).addEventListener('click', async () => {
    try {
      await api('POST', `/api/containers/${state.currentContainer.Id}/action`, { action });
      toast(`${action} sent`, 'success');
      setTimeout(() => openContainer(state.currentContainer.Id), 1200);
    } catch (e) {
      toast(e.message, 'error');
    }
  });
});

// ══════════════════════════════════════════════
//  TABS
// ══════════════════════════════════════════════
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    switchTab(btn.dataset.tab);
  });
});

function switchTab(tab) {
  ['console', 'settings', 'players'].forEach(t => {
    document.getElementById(`tab-${t}`).classList.toggle('hidden', t !== tab);
  });
  if (tab === 'settings') loadSettings();
  if (tab === 'players')  loadPlayers();
}

// ══════════════════════════════════════════════
//  LOG STREAMING
// ══════════════════════════════════════════════
function closeWs() {
  if (state.wsConn) { state.wsConn.close(); state.wsConn = null; }
}

function startLogStream(id) {
  closeWs();
  const logEl = document.getElementById('log-output');
  logEl.innerHTML = '';

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws/logs?token=${state.token}&container=${id}`);
  state.wsConn = ws;

  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'stdout' || msg.type === 'stderr') {
      const lines = msg.data.split('\n');
      lines.forEach(line => {
        if (!line.trim()) return;
        const div = document.createElement('div');
        div.className = 'line ' + classifyLine(line, msg.type);
        div.textContent = line;
        logEl.appendChild(div);
      });
      if (state.autoScroll) logEl.scrollTop = logEl.scrollHeight;
    }
  };

  ws.onerror = () => appendLog('[WebSocket error — check container status]', 'stderr');
  ws.onclose = () => appendLog('[Log stream closed]', 'warn');
}

function classifyLine(line, type) {
  if (type === 'stderr') return 'stderr';
  const l = line.toLowerCase();
  if (l.includes('[warn]') || l.includes('warning')) return 'warn';
  if (l.includes('[error]') || l.includes('error]')) return 'stderr';
  if (l.includes('[info]') || l.includes('joined the game') || l.includes('left the game')) return 'info';
  return '';
}

function appendLog(text, cls = '') {
  const logEl = document.getElementById('log-output');
  const div   = document.createElement('div');
  div.className = `line ${cls}`;
  div.textContent = text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

document.getElementById('clear-log').addEventListener('click', () => {
  document.getElementById('log-output').innerHTML = '';
});

// Auto-scroll toggle
document.getElementById('autoscroll-btn').addEventListener('click', () => {
  state.autoScroll = !state.autoScroll;
  const btn = document.getElementById('autoscroll-btn');
  btn.classList.toggle('on', state.autoScroll);
  btn.textContent = state.autoScroll ? '⬇ Auto' : '⏸ Paused';
});

// Copy logs
document.getElementById('copy-log').addEventListener('click', () => {
  const text = [...document.querySelectorAll('#log-output .line')].map(d => d.textContent).join('\n');
  navigator.clipboard.writeText(text).then(() => toast('Logs copied!', 'success'));
});

// ══════════════════════════════════════════════
//  CONSOLE AUTOCOMPLETE DATA & LOGIC
// ══════════════════════════════════════════════
const JAVA_COMMANDS = [
  { cmd: 'help', hint: '', desc: 'Provides help for commands' },
  { cmd: 'list', hint: '', desc: 'Lists players currently on the server' },
  { cmd: 'say', hint: '<message>', desc: 'Broadcasts a message to all players' },
  { cmd: 'tellraw', hint: '<targets> <message>', desc: 'Sends a JSON message to players' },
  { cmd: 'time', hint: 'set <day|night|noon|midnight>', desc: 'Changes the world time' },
  { cmd: 'weather', hint: '<clear|rain|thunder> [duration]', desc: 'Sets the weather' },
  { cmd: 'whitelist', hint: '<add|remove|list|on|off|reload>', desc: 'Manages server allowlist' },
  { cmd: 'op', hint: '<player>', desc: 'Grants operator status to a player' },
  { cmd: 'deop', hint: '<player>', desc: 'Revokes operator status from a player' },
  { cmd: 'ban', hint: '<player> [reason]', desc: 'Bans a player from the server' },
  { cmd: 'ban-ip', hint: '<ip|player> [reason]', desc: 'Bans an IP address' },
  { cmd: 'pardon', hint: '<player>', desc: 'Unbans a player' },
  { cmd: 'pardon-ip', hint: '<ip>', desc: 'Unbans an IP address' },
  { cmd: 'kick', hint: '<player> [reason]', desc: 'Disconnects a player' },
  { cmd: 'gamemode', hint: '<survival|creative|adventure|spectator> [player]', desc: 'Sets a player\'s game mode' },
  { cmd: 'give', hint: '<player> <item> [count]', desc: 'Gives an item to a player' },
  { cmd: 'tp', hint: '<targets> <destination>', desc: 'Teleports entities' },
  { cmd: 'save-all', hint: '', desc: 'Saves the server world to disk' },
  { cmd: 'save-off', hint: '', desc: 'Disables automatic server saving' },
  { cmd: 'save-on', hint: '', desc: 'Enables automatic server saving' },
  { cmd: 'stop', hint: '', desc: 'Stops the server' },
  { cmd: 'reload', hint: '', desc: 'Reloads datapacks' },
  { cmd: 'seed', hint: '', desc: 'Displays the world seed' },
  { cmd: 'setblock', hint: '<pos> <block>', desc: 'Changes a block' },
  { cmd: 'fill', hint: '<from> <to> <block>', desc: 'Fills a region with a specific block' },
  { cmd: 'kill', hint: '<targets>', desc: 'Kills entities or players' },
  { cmd: 'effect', hint: 'give|clear <targets> <effect>', desc: 'Grants or removes status effects' },
  { cmd: 'difficulty', hint: '<peaceful|easy|normal|hard>', desc: 'Sets the difficulty level' },
  { cmd: 'xp', hint: 'add <targets> <amount>', desc: 'Adds experience' }
];

const BEDROCK_COMMANDS = [
  { cmd: 'help', hint: '', desc: 'Provides help for commands' },
  { cmd: 'list', hint: '', desc: 'Lists players currently on the server' },
  { cmd: 'say', hint: '<message>', desc: 'Broadcasts a message to all players' },
  { cmd: 'time', hint: 'set <day|night|noon|midnight>', desc: 'Changes the world time' },
  { cmd: 'weather', hint: '<clear|rain|thunder> [duration]', desc: 'Sets the weather' },
  { cmd: 'allowlist', hint: '<add|remove|list|on|off|reload>', desc: 'Manages server allowlist' },
  { cmd: 'permission', hint: '<list|reload>', desc: 'Manages custom permissions' },
  { cmd: 'op', hint: '<player>', desc: 'Grants operator status to a player' },
  { cmd: 'deop', hint: '<player>', desc: 'Revokes operator status from a player' },
  { cmd: 'kick', hint: '<player> [reason]', desc: 'Disconnects a player' },
  { cmd: 'gamemode', hint: '<survival|creative|adventure|spectator> [player]', desc: 'Sets a player\'s game mode' },
  { cmd: 'give', hint: '<player> <item> [amount]', desc: 'Gives an item to a player' },
  { cmd: 'tp', hint: '<victim> <destination>', desc: 'Teleports entities' },
  { cmd: 'save', hint: 'hold|resume', desc: 'Manages server backup state' },
  { cmd: 'stop', hint: '', desc: 'Stops the server' },
  { cmd: 'reload', hint: '', desc: 'Reloads server configuration/behavior packs' },
  { cmd: 'setblock', hint: '<position> <tileName>', desc: 'Changes a block' },
  { cmd: 'fill', hint: '<from> <to> <tileName>', desc: 'Fills a region with a specific block' },
  { cmd: 'kill', hint: '<target>', desc: 'Kills entities or players' },
  { cmd: 'effect', hint: '<player> <effect>', desc: 'Grants or removes status effects' },
  { cmd: 'difficulty', hint: '<peaceful|easy|normal|hard>', desc: 'Sets the difficulty level' },
  { cmd: 'xp', hint: '<amount> [player]', desc: 'Adds experience' }
];

let autocompleteSuggestions = [];
let autocompleteSelectedIdx = -1;
let autocompleteKeyNav = false;

function updateAutocomplete() {
  const popup = document.getElementById('cmd-autocomplete');
  if (!popup) return;
  const inputVal = document.getElementById('cmd-input').value.trimLeft();
  const parts = inputVal.split(/\s+/);
  const cmdPrefix = parts[0].toLowerCase();
  
  const list = state.serverType === 'bedrock' ? BEDROCK_COMMANDS : JAVA_COMMANDS;
  
  autocompleteSuggestions = list.filter(item => item.cmd.toLowerCase().startsWith(cmdPrefix));
  
  if (autocompleteSuggestions.length === 0) {
    popup.classList.add('hidden');
    popup.innerHTML = '';
    autocompleteSelectedIdx = -1;
    return;
  }
  
  popup.classList.remove('hidden');
  if (autocompleteSelectedIdx >= autocompleteSuggestions.length) {
    autocompleteSelectedIdx = 0;
  } else if (autocompleteSelectedIdx < 0 && inputVal.length > 0) {
    autocompleteSelectedIdx = 0;
  }
  
  renderAutocomplete();
}

// Ensure autocomplete popup scrolls properly and highlights selected
function renderAutocomplete() {
  const popup = document.getElementById('cmd-autocomplete');
  if (!popup) return;
  popup.innerHTML = autocompleteSuggestions.map((item, idx) => `
    <div class="autocomplete-item ${idx === autocompleteSelectedIdx ? 'selected' : ''}" data-idx="${idx}">
      <div class="autocomplete-cmd">
        <span>${item.cmd}</span>
        ${item.hint ? `<span class="autocomplete-hint">${item.hint.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>` : ''}
      </div>
      <div class="autocomplete-desc">${item.desc}</div>
    </div>
  `).join('');
  
  const selectedEl = popup.querySelector('.autocomplete-item.selected');
  if (selectedEl) {
    selectedEl.scrollIntoView({ block: 'nearest' });
  }
}

function applyAutocomplete(idx) {
  const item = autocompleteSuggestions[idx];
  if (!item) return;
  const input = document.getElementById('cmd-input');
  input.value = item.cmd + (item.hint ? ' ' : '');
  input.focus();
  const popup = document.getElementById('cmd-autocomplete');
  if (popup) popup.classList.add('hidden');
  autocompleteSelectedIdx = -1;
  autocompleteKeyNav = false;
  setTimeout(updateAutocomplete, 50);
}

document.addEventListener('click', e => {
  const item = e.target.closest('.autocomplete-item');
  if (item) {
    const idx = parseInt(item.dataset.idx, 10);
    applyAutocomplete(idx);
    return;
  }
  if (!e.target.closest('.console-input-bar')) {
    const popup = document.getElementById('cmd-autocomplete');
    if (popup) popup.classList.add('hidden');
  }
});

// ══════════════════════════════════════════════
//  SEND COMMAND (via docker exec)
// ══════════════════════════════════════════════
async function sendCommand() {
  const input = document.getElementById('cmd-input');
  const cmd   = input.value.trim();
  if (!cmd) return;
  state.cmdHistory.unshift(cmd);
  if (state.cmdHistory.length > 50) state.cmdHistory.pop();
  state.cmdHistoryIdx = -1;
  input.value = '';
  appendLog(`> ${cmd}`, 'info');
  const popup = document.getElementById('cmd-autocomplete');
  if (popup) popup.classList.add('hidden');
  try {
    const res = await api('POST', `/api/containers/${state.currentContainer.Id}/command`, { command: cmd });
    if (res.response) appendLog(res.response, 'info');
  } catch (e) {
    appendLog(`[Error: ${e.message}]`, 'stderr');
  }
}

document.getElementById('cmd-send').addEventListener('click', sendCommand);

document.getElementById('cmd-input').addEventListener('input', () => {
  autocompleteKeyNav = false;
  updateAutocomplete();
});
document.getElementById('cmd-input').addEventListener('focus', () => {
  autocompleteKeyNav = false;
  updateAutocomplete();
});

document.getElementById('cmd-input').addEventListener('keydown', e => {
  const popup = document.getElementById('cmd-autocomplete');
  const isAutocompleteVisible = popup && !popup.classList.contains('hidden');

  if (isAutocompleteVisible && autocompleteSuggestions.length > 0) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      autocompleteKeyNav = true;
      autocompleteSelectedIdx = (autocompleteSelectedIdx + 1) % autocompleteSuggestions.length;
      renderAutocomplete();
      return;
    }
    if (e.key === 'ArrowUp' && e.target.value.trim() !== '') {
      e.preventDefault();
      autocompleteKeyNav = true;
      autocompleteSelectedIdx = (autocompleteSelectedIdx - 1 + autocompleteSuggestions.length) % autocompleteSuggestions.length;
      renderAutocomplete();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const idx = autocompleteSelectedIdx >= 0 ? autocompleteSelectedIdx : 0;
      applyAutocomplete(idx);
      return;
    }
    if (e.key === 'Enter') {
      if (autocompleteKeyNav && autocompleteSelectedIdx >= 0) {
        e.preventDefault();
        applyAutocomplete(autocompleteSelectedIdx);
        return;
      }
      popup.classList.add('hidden');
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      popup.classList.add('hidden');
      autocompleteSelectedIdx = -1;
      autocompleteKeyNav = false;
      return;
    }
  }

  if (e.key === 'Enter') {
    if (popup) popup.classList.add('hidden');
    sendCommand();
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (popup) popup.classList.add('hidden');
    const idx = Math.min(state.cmdHistoryIdx + 1, state.cmdHistory.length - 1);
    state.cmdHistoryIdx = idx;
    e.target.value = state.cmdHistory[idx] || '';
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (popup) popup.classList.add('hidden');
    const idx = Math.max(state.cmdHistoryIdx - 1, -1);
    state.cmdHistoryIdx = idx;
    e.target.value = idx === -1 ? '' : (state.cmdHistory[idx] || '');
  }
});

// ══════════════════════════════════════════════
//  SETTINGS
// ══════════════════════════════════════════════
async function loadSettings() {
  const grid = document.getElementById('props-grid');
  const raw  = document.getElementById('raw-props');
  grid.innerHTML = '<div style="color:var(--text2);display:flex;align-items:center;gap:8px;padding:8px"><span class="loader"></span> Loading…</div>';

  // Show itzg notice only for itzg images
  const img = (state.currentContainer?.Config?.Image || '').toLowerCase();
  const isItzg = img.includes('itzg');
  document.getElementById('settings-itzg-notice').classList.toggle('hidden', !isItzg);

  try {
    const res = await api('GET', `/api/containers/${state.currentContainer.Id}/file?path=/data/server.properties`);
    state.propsRaw = res.content;
    raw.value = res.content;
    renderProps(res.content);
  } catch (e) {
    grid.innerHTML = `<div style="color:var(--red);padding:8px">${e.message}</div>`;
  }
}

function parseProps(raw) {
  return raw.split('\n')
    .filter(l => l.trim() && !l.trim().startsWith('#'))
    .map(l => {
      const i = l.indexOf('=');
      return i > -1 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : null;
    })
    .filter(Boolean);
}

// Property metadata: type, label, description, options, section
// ── Java Edition ──
const JAVA_PROP_META = {
  'server-name':       { section: 'general', label: 'Server Name', desc: 'The name shown in the server list', type: 'text' },
  'motd':              { section: 'general', label: 'Message of the Day', desc: 'Displayed below the server name in the multiplayer list', type: 'text' },
  'server-port':       { section: 'general', label: 'Server Port', desc: 'Port the server listens on', type: 'number', min: 1, max: 65535 },
  'max-players':       { section: 'general', label: 'Max Players', desc: 'Maximum number of players that can join', type: 'number', min: 1, max: 1000 },
  'level-name':        { section: 'general', label: 'World Name', desc: 'Name of the world folder', type: 'text' },
  'level-seed':        { section: 'general', label: 'World Seed', desc: 'Seed used for world generation (leave blank for random)', type: 'text' },
  'level-type':        { section: 'general', label: 'World Type', desc: 'Type of world generation', type: 'select', options: ['default', 'flat', 'largeBiomes', 'amplified', 'buffet'] },
  'gamemode':          { section: 'general', label: 'Default Gamemode', desc: 'Gamemode assigned to new players', type: 'select', options: ['survival', 'creative', 'adventure', 'spectator'] },
  'difficulty':        { section: 'general', label: 'Difficulty', desc: 'Server difficulty level', type: 'select', options: ['peaceful', 'easy', 'normal', 'hard'] },
  'force-gamemode':    { section: 'general', label: 'Force Gamemode', desc: 'Force players into the default gamemode when joining', type: 'toggle' },
  'hardcore':          { section: 'general', label: 'Hardcore', desc: 'Players are set to spectator mode upon death', type: 'toggle' },
  'generate-structures':    { section: 'world', label: 'Generate Structures', desc: 'Generate villages, strongholds, mineshafts, etc.', type: 'toggle' },
  'allow-nether':           { section: 'world', label: 'Allow Nether', desc: 'Allow players to travel to the Nether', type: 'toggle' },
  'spawn-monsters':         { section: 'world', label: 'Spawn Monsters', desc: 'Hostile mobs will spawn in the world', type: 'toggle' },
  'spawn-animals':          { section: 'world', label: 'Spawn Animals', desc: 'Animals will spawn in the world', type: 'toggle' },
  'spawn-npcs':             { section: 'world', label: 'Spawn NPCs', desc: 'Villagers will spawn in villages', type: 'toggle' },
  'spawn-protection':       { section: 'world', label: 'Spawn Protection Radius', desc: 'Radius (in blocks) around spawn that is protected. Set 0 to disable', type: 'number', min: 0, max: 256 },
  'max-world-size':         { section: 'world', label: 'Max World Size', desc: 'Maximum radius of the world border (in blocks)', type: 'number', min: 1, max: 29999984 },
  'max-build-height':       { section: 'world', label: 'Max Build Height', desc: 'Maximum height (Y level) players can build at', type: 'number', min: 1, max: 320 },
  'view-distance':          { section: 'world', label: 'View Distance', desc: 'Amount of chunks sent to each player (3–32)', type: 'number', min: 3, max: 32 },
  'simulation-distance':    { section: 'world', label: 'Simulation Distance', desc: 'Chunk distance that entities are ticked (3–32)', type: 'number', min: 3, max: 32 },
  'pvp':                    { section: 'players', label: 'PvP', desc: 'Allow players to fight each other', type: 'toggle' },
  'allow-flight':           { section: 'players', label: 'Allow Flight', desc: 'Allow survival players to fly (with mods)', type: 'toggle' },
  'white-list':             { section: 'players', label: 'Whitelist', desc: 'Only whitelisted players can join', type: 'toggle' },
  'enforce-whitelist':      { section: 'players', label: 'Enforce Whitelist', desc: 'Kick non-whitelisted players when whitelist reloads', type: 'toggle' },
  'online-mode':            { section: 'players', label: 'Online Mode', desc: 'Verify players against Mojang accounts. Disable for offline/cracked servers', type: 'toggle' },
  'player-idle-timeout':    { section: 'players', label: 'Idle Timeout', desc: 'Minutes before idle players are kicked (0 = disabled)', type: 'number', min: 0, max: 9999 },
  'op-permission-level':    { section: 'players', label: 'OP Permission Level', desc: 'Default permission level for operators (1–4)', type: 'select', options: ['1', '2', '3', '4'] },
  'server-ip':              { section: 'network', label: 'Server IP', desc: 'IP address to bind to (leave blank for all interfaces)', type: 'text' },
  'network-compression-threshold': { section: 'network', label: 'Compression Threshold', desc: 'Packet size threshold before compression (-1 to disable)', type: 'number', min: -1, max: 65535 },
  'rate-limit':             { section: 'network', label: 'Rate Limit', desc: 'Max packets per second per player (0 = disabled)', type: 'number', min: 0, max: 99999 },
  'prevent-proxy-connections': { section: 'network', label: 'Prevent Proxy/VPN', desc: 'Block connections from proxies and VPNs', type: 'toggle' },
  'enable-query':           { section: 'network', label: 'Enable Query', desc: 'Enable GameSpy4 query protocol', type: 'toggle' },
  'query.port':             { section: 'network', label: 'Query Port', desc: 'Port for the GameSpy4 query protocol', type: 'number', min: 1, max: 65535 },
  'enable-status':          { section: 'network', label: 'Enable Status', desc: 'Show server in the multiplayer server list', type: 'toggle' },
  'enable-rcon':            { section: 'rcon', label: 'Enable RCON', desc: 'Enable remote console access', type: 'toggle' },
  'rcon.port':              { section: 'rcon', label: 'RCON Port', desc: 'Port for the RCON protocol', type: 'number', min: 1, max: 65535 },
  'rcon.password':          { section: 'rcon', label: 'RCON Password', desc: 'Password for RCON connections', type: 'text' },
  'broadcast-rcon-to-ops':  { section: 'rcon', label: 'Broadcast RCON to OPs', desc: 'Show RCON command output to operators', type: 'toggle' },
  'broadcast-console-to-ops': { section: 'rcon', label: 'Broadcast Console to OPs', desc: 'Show console output to operators', type: 'toggle' },
  'enable-command-block':    { section: 'advanced', label: 'Command Blocks', desc: 'Allow command blocks to function', type: 'toggle' },
  'function-permission-level': { section: 'advanced', label: 'Function Permission Level', desc: 'Permission level for data packs (1–4)', type: 'select', options: ['1', '2', '3', '4'] },
  'sync-chunk-writes':      { section: 'advanced', label: 'Sync Chunk Writes', desc: 'Write chunks synchronously to disk', type: 'toggle' },
  'entity-broadcast-range-percentage': { section: 'advanced', label: 'Entity Broadcast Range %', desc: 'Percentage of default entity visibility range (10–1000)', type: 'number', min: 10, max: 1000 },
  'max-chained-neighbor-updates': { section: 'advanced', label: 'Max Chained Neighbor Updates', desc: 'Limits redstone chain length (-1 = unlimited)', type: 'number', min: -1, max: 999999 },
  'enforce-secure-profile':  { section: 'advanced', label: 'Enforce Secure Profile', desc: 'Require Mojang-signed public key from players', type: 'toggle' },
  'require-resource-pack':   { section: 'advanced', label: 'Require Resource Pack', desc: 'Kick players who decline the resource pack', type: 'toggle' },
  'resource-pack':           { section: 'advanced', label: 'Resource Pack URL', desc: 'URL to server resource pack', type: 'text' },
  'resource-pack-sha1':      { section: 'advanced', label: 'Resource Pack SHA1', desc: 'SHA1 hash of the resource pack for verification', type: 'text' },
  'text-filtering-config':   { section: 'advanced', label: 'Text Filtering Config', desc: 'Text filtering configuration', type: 'text' },
  'log-ips':                 { section: 'advanced', label: 'Log IPs', desc: 'Log player IP addresses in the server log', type: 'toggle' },
};

// ── Bedrock Edition ──
const BEDROCK_PROP_META = {
  'server-name':       { section: 'general', label: 'Server Name', desc: 'The name shown in the server list', type: 'text' },
  'gamemode':          { section: 'general', label: 'Default Gamemode', desc: 'Gamemode assigned to new players', type: 'select', options: ['survival', 'creative', 'adventure'] },
  'difficulty':        { section: 'general', label: 'Difficulty', desc: 'Server difficulty level', type: 'select', options: ['peaceful', 'easy', 'normal', 'hard'] },
  'max-players':       { section: 'general', label: 'Max Players', desc: 'Maximum number of players that can join', type: 'number', min: 1, max: 1000 },
  'force-gamemode':    { section: 'general', label: 'Force Gamemode', desc: 'Force players into the default gamemode when joining', type: 'toggle' },
  'allow-cheats':      { section: 'general', label: 'Allow Cheats', desc: 'Allow the use of cheat commands', type: 'toggle' },
  'default-player-permission-level': { section: 'general', label: 'Default Permission Level', desc: 'Permission level for new players', type: 'select', options: ['visitor', 'member', 'operator'] },
  'level-name':        { section: 'world', label: 'World Name', desc: 'Name of the world folder in the worlds/ directory', type: 'text' },
  'level-seed':        { section: 'world', label: 'World Seed', desc: 'Seed used for world generation (leave blank for random)', type: 'text' },
  'view-distance':     { section: 'world', label: 'View Distance', desc: 'Maximum number of chunks sent to the client', type: 'number', min: 5, max: 48 },
  'tick-distance':     { section: 'world', label: 'Tick Distance', desc: 'Radius (in chunks) around players that will be actively ticked (4–12)', type: 'number', min: 4, max: 12 },
  'texturepack-required': { section: 'world', label: 'Require Texture Pack', desc: 'Require players to accept the server texture pack to join', type: 'toggle' },
  'online-mode':       { section: 'players', label: 'Online Mode', desc: 'Require Xbox Live authentication for players', type: 'toggle' },
  'allow-list':        { section: 'players', label: 'Allowlist', desc: 'Only players in the allowlist can join', type: 'toggle' },
  'player-idle-timeout': { section: 'players', label: 'Idle Timeout', desc: 'Minutes before idle players are kicked (0 = disabled)', type: 'number', min: 0, max: 9999 },
  'server-port':       { section: 'network', label: 'Server Port (IPv4)', desc: 'IPv4 port the server listens on (default: 19132)', type: 'number', min: 1, max: 65535 },
  'server-portv6':     { section: 'network', label: 'Server Port (IPv6)', desc: 'IPv6 port the server listens on (default: 19133)', type: 'number', min: 1, max: 65535 },
  'compression-threshold': { section: 'network', label: 'Compression Threshold', desc: 'Raw network payload size before compression is applied', type: 'number', min: 0, max: 65535 },
  'compression-algorithm': { section: 'network', label: 'Compression Algorithm', desc: 'Algorithm used for network compression', type: 'select', options: ['zlib', 'snappy'] },
  'max-threads':       { section: 'network', label: 'Max Threads', desc: 'Maximum threads the server will use (0 = unlimited)', type: 'number', min: 0, max: 128 },
  'server-authoritative-movement': { section: 'advanced', label: 'Authoritative Movement', desc: 'How much authority the server has over player movement', type: 'select', options: ['client-auth', 'server-auth', 'server-auth-with-rewind'] },
  'server-authoritative-block-breaking': { section: 'advanced', label: 'Authoritative Block Breaking', desc: 'Server verifies block mining operations', type: 'toggle' },
  'chat-restriction':  { section: 'advanced', label: 'Chat Restriction', desc: 'Controls chat UI/functionality', type: 'select', options: ['None', 'Dropped', 'Disabled'] },
  'content-log-file-enabled': { section: 'advanced', label: 'Content Log File', desc: 'Enable logging of content errors to a file', type: 'toggle' },
};

const JAVA_SECTIONS = {
  general:  { label: 'General', icon: '⚙️' },
  world:    { label: 'World', icon: '🌍' },
  players:  { label: 'Players', icon: '👥' },
  network:  { label: 'Network', icon: '🌐' },
  rcon:     { label: 'Remote Console', icon: '🔌' },
  advanced: { label: 'Advanced', icon: '🔧' },
  other:    { label: 'Other', icon: '📋' },
};

const BEDROCK_SECTIONS = {
  general:  { label: 'General', icon: '⚙️' },
  world:    { label: 'World', icon: '🌍' },
  players:  { label: 'Players', icon: '👥' },
  network:  { label: 'Network', icon: '🌐' },
  advanced: { label: 'Advanced', icon: '🔧' },
  other:    { label: 'Other', icon: '📋' },
};

function getActivePropMeta() { return state.serverType === 'bedrock' ? BEDROCK_PROP_META : JAVA_PROP_META; }
function getActiveSections() { return state.serverType === 'bedrock' ? BEDROCK_SECTIONS : JAVA_SECTIONS; }

function renderProps(raw) {
  const container = document.getElementById('props-grid');
  const props = parseProps(raw);
  if (!props.length) { container.innerHTML = '<div style="color:var(--text2);padding:8px">No properties found.</div>'; return; }

  // Group props by section
  const activeMeta = getActivePropMeta();
  const activeSections = getActiveSections();
  const grouped = {};
  for (const sec of Object.keys(activeSections)) grouped[sec] = [];

  props.forEach(([k, v]) => {
    const meta = activeMeta[k];
    const sec = meta?.section || 'other';
    if (!grouped[sec]) grouped[sec] = [];
    grouped[sec].push([k, v, meta]);
  });

  let html = '';
  for (const [secKey, secInfo] of Object.entries(activeSections)) {
    const items = grouped[secKey];
    if (!items || !items.length) continue;

    html += `<div class="settings-section">
      <div class="settings-section-title"><span class="icon">${secInfo.icon}</span> ${secInfo.label}</div>
      <div class="props-grid">`;

    items.forEach(([k, v, meta]) => {
      html += renderPropRow(k, v, meta);
    });

    html += `</div></div>`;
  }

  container.innerHTML = html;

  // Wire up toggle changes to sync hidden input values
  container.querySelectorAll('.toggle-switch input').forEach(cb => {
    cb.addEventListener('change', () => {
      const hidden = container.querySelector(`input[type="hidden"][data-key="${cb.dataset.key}"]`);
      if (hidden) hidden.value = cb.checked ? 'true' : 'false';
    });
  });
}

function renderPropRow(key, value, meta) {
  if (!meta) {
    // Unknown property — plain text input
    return `<div class="prop-row">
      <div class="prop-key">${escHtml(key)}</div>
      <div class="prop-value"><input type="text" data-key="${escHtml(key)}" value="${escHtml(value)}"></div>
    </div>`;
  }

  const label = meta.label || key;
  const desc  = meta.desc ? `<div class="prop-desc">${escHtml(meta.desc)}</div>` : '';
  const ek    = escHtml(key);
  const ev    = escHtml(value);

  if (meta.type === 'toggle') {
    const checked = value === 'true' ? 'checked' : '';
    return `<div class="prop-row toggle-row">
      <div class="prop-info">
        <div class="prop-label">${escHtml(label)}</div>
        ${desc}
        <div class="prop-key">${ek}</div>
      </div>
      <label class="toggle-switch">
        <input type="checkbox" data-key="${ek}" ${checked}>
        <span class="toggle-track"></span>
      </label>
      <input type="hidden" data-key="${ek}" value="${ev}">
    </div>`;
  }

  if (meta.type === 'select') {
    const opts = meta.options.map(o =>
      `<option value="${escHtml(o)}" ${o === value ? 'selected' : ''}>${escHtml(o)}</option>`
    ).join('');
    return `<div class="prop-row">
      <div class="prop-label">${escHtml(label)}</div>
      ${desc}
      <div class="prop-key">${ek}</div>
      <div class="prop-value"><select data-key="${ek}">${opts}</select></div>
    </div>`;
  }

  if (meta.type === 'number') {
    const rangeLabel = meta.min !== undefined ? `<div class="prop-range-label">${meta.min} – ${meta.max}</div>` : '';
    return `<div class="prop-row">
      <div class="prop-label">${escHtml(label)}</div>
      ${desc}
      <div class="prop-key">${ek}</div>
      <div class="prop-value">
        <input type="number" data-key="${ek}" value="${ev}" min="${meta.min ?? ''}" max="${meta.max ?? ''}" step="1">
        ${rangeLabel}
      </div>
    </div>`;
  }

  // Default: text input with label + desc
  return `<div class="prop-row">
    <div class="prop-label">${escHtml(label)}</div>
    ${desc}
    <div class="prop-key">${ek}</div>
    <div class="prop-value"><input type="text" data-key="${ek}" value="${ev}"></div>
  </div>`;
}

async function collectSettingsContent() {
  const rawView = !document.getElementById('settings-raw').classList.contains('hidden');
  if (rawView) return document.getElementById('raw-props').value;
  const lines = state.propsRaw.split('\n');
  const updated = {};
  document.querySelectorAll('#props-grid input[data-key][type="text"], #props-grid input[data-key][type="number"], #props-grid input[data-key][type="hidden"]').forEach(inp => {
    updated[inp.dataset.key] = inp.value;
  });
  document.querySelectorAll('#props-grid select[data-key]').forEach(sel => {
    updated[sel.dataset.key] = sel.value;
  });
  return lines.map(l => {
    if (l.trim().startsWith('#') || !l.trim()) return l;
    const i = l.indexOf('=');
    if (i < 0) return l;
    const k = l.slice(0, i).trim();
    return updated[k] !== undefined ? `${k}=${updated[k]}` : l;
  }).join('\n');
}

async function saveSettings() {
  const content = await collectSettingsContent();
  await api('PUT', `/api/containers/${state.currentContainer.Id}/file`, {
    path: '/data/server.properties', content,
  });
  state.propsRaw = content;
}

document.getElementById('save-settings').addEventListener('click', async () => {
  const btn = document.getElementById('save-settings');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await saveSettings();
    toast('Settings saved! Restart server for changes to take effect.', 'info');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Save';
  }
});

document.getElementById('save-restart-settings').addEventListener('click', async () => {
  const btn = document.getElementById('save-restart-settings');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await saveSettings();
    toast('Settings saved! Restarting server…', 'success');
    btn.textContent = 'Restarting…';
    await api('POST', `/api/containers/${state.currentContainer.Id}/action`, { action: 'restart' });
    toast('Server restarting — settings will take effect.', 'success');
    setTimeout(() => openContainer(state.currentContainer.Id), 3000);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Save & Restart';
  }
});

// Settings sub-tabs (visual / raw)
document.querySelectorAll('.stab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.stab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const raw = btn.dataset.stab === 'raw';
    document.getElementById('settings-visual').classList.toggle('hidden', raw);
    document.getElementById('settings-raw').classList.toggle('hidden', !raw);
  });
});

// Sync raw textarea changes to visual
document.getElementById('raw-props').addEventListener('input', function() {
  state.propsRaw = this.value;
  renderProps(this.value);
});

// ══════════════════════════════════════════════
//  PLAYERS
// ══════════════════════════════════════════════

const ITEM_ICONS = {
  diamond_sword:'⚔️', iron_sword:'🗡️', wooden_sword:'🗡️', stone_sword:'🗡️', golden_sword:'🗡️', netherite_sword:'⚔️',
  bow:'🏹', crossbow:'🏹', trident:'🔱', shield:'🛡️',
  diamond_pickaxe:'⛏️', iron_pickaxe:'⛏️', wooden_pickaxe:'⛏️', stone_pickaxe:'⛏️', golden_pickaxe:'⛏️', netherite_pickaxe:'⛏️',
  diamond_axe:'🪓', iron_axe:'🪓', wooden_axe:'🪓', stone_axe:'🪓', golden_axe:'🪓', netherite_axe:'🪓',
  diamond_shovel:'🪏', iron_shovel:'🪏',
  diamond_helmet:'🪖', iron_helmet:'🪖', golden_helmet:'🪖', netherite_helmet:'🪖', leather_helmet:'🪖',
  diamond_chestplate:'👕', iron_chestplate:'👕', golden_chestplate:'👕', netherite_chestplate:'👕',
  diamond_leggings:'👖', iron_leggings:'👖', golden_leggings:'👖', netherite_leggings:'👖',
  diamond_boots:'👢', iron_boots:'👢', golden_boots:'👢', netherite_boots:'👢',
  apple:'🍎', golden_apple:'🍏', enchanted_golden_apple:'✨', bread:'🍞', cooked_beef:'🥩', cooked_porkchop:'🥩',
  diamond:'💎', emerald:'💚', gold_ingot:'🥇', iron_ingot:'🪙', netherite_ingot:'🟫',
  coal:'🪨', torch:'🔦', ender_pearl:'🟣', blaze_rod:'🥢',
  oak_log:'🪵', cobblestone:'🪨', dirt:'🟫', sand:'🟨',
  arrow:'➡️', tnt:'🧨', bucket:'🪣', water_bucket:'💧', lava_bucket:'🟠',
  elytra:'🪂', totem_of_undying:'🗿', compass:'🧭', clock:'🕐', map:'🗺️', filled_map:'🗺️',
  book:'📕', writable_book:'📖', enchanted_book:'📗', name_tag:'🏷️',
  fishing_rod:'🎣', lead:'🪢', saddle:'🪑',
};

function getItemIcon(id) { return ITEM_ICONS[id] || '📦'; }

function formatItemName(id) {
  return id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatStatKey(key) {
  return key.replace('minecraft:', '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatStatNumber(n) {
  if (n >= 1000000) return (n/1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n/1000).toFixed(1) + 'K';
  return n.toLocaleString();
}

async function loadPlayers() {
  const container = document.getElementById('players-list-container');
  container.innerHTML = '<div class="pd-loading"><span class="loader"></span> Loading players…</div>';

  const isBedrock = state.serverType === 'bedrock';

  state.selectedPlayerUuid = null;
  state.playerDataCache = {};
  state.playerStatsCache = {};
  state.allPlayersFilter = 'all';
  state.allPlayersSearch = '';
  document.getElementById('players-search').value = '';

  try {
    const res = await api('GET', `/api/containers/${state.currentContainer.Id}/all-players?type=${state.serverType}`);
    state.allPlayers = res.players || [];
    renderPlayerFilterTabs();
    renderAllPlayers();
  } catch (e) {
    container.innerHTML = `<div class="empty-players"><span class="emoji">⚠️</span><h3>Could not load players</h3>${escHtml(e.message)}</div>`;
  }
}

// Search handler
document.getElementById('players-search').addEventListener('input', function() {
  state.allPlayersSearch = this.value.toLowerCase().trim();
  renderAllPlayers();
});

function renderPlayerFilterTabs() {
  const tabs = document.getElementById('player-filter-tabs');
  const isBedrock = state.serverType === 'bedrock';
  const all = state.allPlayers;

  if (isBedrock) {
    const wlCount = all.filter(p => p.allowlisted).length;
    const opCount = all.filter(p => p.permission === 'operator').length;
    tabs.innerHTML = `
      <button class="pft-btn active" data-pf="all">All <span class="pft-count">${all.length}</span></button>
      <button class="pft-btn" data-pf="allowlisted">📜 Allowlisted <span class="pft-count">${wlCount}</span></button>
      <button class="pft-btn" data-pf="operator">👑 Operator <span class="pft-count">${opCount}</span></button>`;
  } else {
    const wlCount = all.filter(p => p.whitelisted).length;
    const opCount = all.filter(p => p.op).length;
    const banCount = all.filter(p => p.banned).length;
    tabs.innerHTML = `
      <button class="pft-btn active" data-pf="all">All <span class="pft-count">${all.length}</span></button>
      <button class="pft-btn" data-pf="whitelisted">✅ Whitelisted <span class="pft-count">${wlCount}</span></button>
      <button class="pft-btn" data-pf="op">👑 Operators <span class="pft-count">${opCount}</span></button>
      <button class="pft-btn" data-pf="banned">🚫 Banned <span class="pft-count">${banCount}</span></button>`;
  }

  tabs.querySelectorAll('.pft-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      tabs.querySelectorAll('.pft-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.allPlayersFilter = btn.dataset.pf;
      renderAllPlayers();
    });
  });
}

function getFilteredPlayers() {
  let list = state.allPlayers;
  const f = state.allPlayersFilter;
  const isBedrock = state.serverType === 'bedrock';

  if (f !== 'all') {
    if (isBedrock) {
      if (f === 'allowlisted') list = list.filter(p => p.allowlisted);
      if (f === 'operator') list = list.filter(p => p.permission === 'operator');
    } else {
      if (f === 'whitelisted') list = list.filter(p => p.whitelisted);
      if (f === 'op') list = list.filter(p => p.op);
      if (f === 'banned') list = list.filter(p => p.banned);
    }
  }

  if (state.allPlayersSearch) {
    const q = state.allPlayersSearch;
    list = list.filter(p => (p.name || '').toLowerCase().includes(q) || (p.uuid || '').toLowerCase().includes(q) || (p.xuid || '').toLowerCase().includes(q));
  }

  return list;
}

function renderAllPlayers() {
  const container = document.getElementById('players-list-container');
  const filtered = getFilteredPlayers();
  const isBedrock = state.serverType === 'bedrock';

  document.getElementById('players-count').textContent = `${filtered.length} of ${state.allPlayers.length} players`;

  if (!filtered.length) {
    container.innerHTML = `<div class="empty-players"><span class="emoji">👥</span><h3>No players found</h3>${state.allPlayersSearch ? 'Try a different search term.' : 'No players have joined this server yet.'}</div>`;
    return;
  }

  let html = '<div class="players-grid">';
  for (const p of filtered) {
    const id = p.uuid || p.xuid || p.name;
    const isActive = state.selectedPlayerUuid === id;
    const name = escHtml(p.name || 'Unknown');
    const idStr = p.uuid ? escHtml(p.uuid) : (p.xuid ? `XUID: ${escHtml(p.xuid)}` : '');

    let badges = '';
    if (isBedrock) {
      if (p.allowlisted) badges += '<span class="pc-badge wl">Allowed</span>';
      if (p.permission === 'operator') badges += '<span class="pc-badge op">Operator</span>';
      else if (p.permission && p.permission !== 'member') badges += `<span class="pc-badge perm">${escHtml(p.permission)}</span>`;
    } else {
      if (p.op) badges += `<span class="pc-badge op">OP ${p.opLevel || ''}</span>`;
      if (p.whitelisted) badges += '<span class="pc-badge wl">Whitelisted</span>';
      if (p.banned) badges += '<span class="pc-badge ban">Banned</span>';
    }

    // Action buttons
    let actions = '<div class="pc-actions" style="display:flex;gap:4px;flex-shrink:0;flex-wrap:wrap">';
    if (isBedrock) {
      if (p.allowlisted) {
        actions += `<button class="pc-act-btn remove" data-cmd="allowlist remove ${name}" title="Remove from allowlist">✕ Allow</button>`;
      } else {
        actions += `<button class="pc-act-btn add" data-cmd="allowlist add ${name}" title="Add to allowlist">+ Allow</button>`;
      }
      if (p.permission === 'operator') {
        actions += `<button class="pc-act-btn remove" data-cmd="deop ${name}" title="Remove operator">✕ OP</button>`;
      } else {
        actions += `<button class="pc-act-btn add" data-cmd="op ${name}" title="Make operator">+ OP</button>`;
      }
      actions += `<button class="pc-act-btn ban" style="background:rgba(255,179,64,0.1);color:var(--amber);border-color:rgba(255,179,64,0.2)" data-cmd="kick ${name}" title="Kick player from server">Kick</button>`;
    } else {
      if (p.whitelisted) {
        actions += `<button class="pc-act-btn remove" data-cmd="whitelist remove ${name}" title="Remove from whitelist">✕ WL</button>`;
      } else {
        actions += `<button class="pc-act-btn add" data-cmd="whitelist add ${name}" title="Add to whitelist">+ WL</button>`;
      }
      if (p.op) {
        actions += `<button class="pc-act-btn remove" data-cmd="deop ${name}" title="Remove operator">✕ OP</button>`;
      } else {
        actions += `<button class="pc-act-btn add" data-cmd="op ${name}" title="Make operator">+ OP</button>`;
      }
      actions += `<button class="pc-act-btn ban" style="background:rgba(255,179,64,0.1);color:var(--amber);border-color:rgba(255,179,64,0.2)" data-cmd="kick ${name}" title="Kick player from server">Kick</button>`;
      if (p.banned) {
        actions += `<button class="pc-act-btn add" data-cmd="pardon ${name}" title="Unban player">Pardon</button>`;
      } else {
        actions += `<button class="pc-act-btn ban" data-cmd="ban ${name}" title="Ban player">Ban</button>`;
      }
    }
    actions += '</div>';

    const hasDetail = true;
    const avatarSrc = p.uuid ? `https://mc-heads.net/avatar/${name}/40` : '';

    html += `<div class="player-card${isActive ? ' active' : ''}" data-pid="${escHtml(id)}">
      <div class="pc-avatar">${avatarSrc ? `<img src="${avatarSrc}" alt="${name}" onerror="this.replaceWith(document.createTextNode('👤'))">` : '👤'}</div>
      <div class="pc-info">
        <div class="pc-name">${name} <span class="pc-badges">${badges}</span></div>
        ${idStr ? `<div class="pc-uuid">${idStr}</div>` : ''}
      </div>
      ${actions}
      ${hasDetail ? '<span class="pc-arrow">›</span>' : ''}
    </div>`;

    if (isActive && hasDetail) {
      html += `<div class="player-detail-panel open" id="pd-panel-${escHtml(id)}"><div class="pd-loading"><span class="loader"></span> Loading player data…</div></div>`;
    }
  }
  html += '</div>';
  container.innerHTML = html;

  // Wire click handlers for expanding player details
  container.querySelectorAll('.player-card').forEach(card => {
    card.addEventListener('click', (e) => {
      // Don't toggle if an action button was clicked
      if (e.target.closest('.pc-act-btn')) return;
      const pid = card.dataset.pid;
      const player = state.allPlayers.find(p => (p.uuid || p.xuid || p.name) === pid);
      if (!player) return;

      if (state.selectedPlayerUuid === pid) {
        state.selectedPlayerUuid = null;
      } else {
        state.selectedPlayerUuid = pid;
      }
      renderAllPlayers();

      if (state.selectedPlayerUuid === pid) {
        loadPlayerDetail(pid);
      }
    });
  });

  // Wire action button handlers
  container.querySelectorAll('.pc-act-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cmd = btn.dataset.cmd;
      btn.disabled = true;
      const origText = btn.textContent;
      btn.textContent = '…';
      try {
        const res = await api('POST', `/api/containers/${state.currentContainer.Id}/command`, { command: cmd });
        toast(res.response || `Command sent: ${cmd}`, 'success');
        // Refresh player list after a short delay to let the server process
        setTimeout(() => loadPlayers(), 800);
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = origText;
      }
    });
  });
}

async function loadPlayerDetail(uuid) {
  const panel = document.getElementById(`pd-panel-${uuid}`);
  if (!panel) return;

  try {
    // Load data + stats in parallel
    const [dataRes, statsRes] = await Promise.allSettled([
      state.playerDataCache[uuid] || api('GET', `/api/containers/${state.currentContainer.Id}/player-data/${uuid}?type=${state.serverType}`),
      state.playerStatsCache[uuid] || api('GET', `/api/containers/${state.currentContainer.Id}/player-stats/${uuid}?type=${state.serverType}`).catch(() => null),
    ]);

    const pdata = dataRes.status === 'fulfilled' ? dataRes.value : null;
    const pstats = statsRes.status === 'fulfilled' ? statsRes.value : null;
    if (pdata) state.playerDataCache[uuid] = pdata;
    if (pstats) state.playerStatsCache[uuid] = pstats;

    if (!pdata) {
      // Check if this is a "player hasn't joined yet" case
      const reason = dataRes.reason;
      if (reason?.data?.notJoined) {
        panel.innerHTML = `
          <div class="pd-not-joined">
            <div class="pd-not-joined-icon">🎮</div>
            <div class="pd-not-joined-title">No play data yet</div>
            <div class="pd-not-joined-msg">This player is on the allowlist but hasn't joined the server yet. Data will appear after their first login.</div>
          </div>`;
      } else {
        const errMsg = reason?.message || 'Unknown error';
        panel.innerHTML = `<div class="pd-error">Could not load player data: ${escHtml(errMsg)}</div>`;
      }
      return;
    }

    renderPlayerDetail(panel, uuid, pdata, pstats);
  } catch (e) {
    panel.innerHTML = `<div class="pd-error">${escHtml(e.message)}</div>`;
  }
}

function renderPlayerDetail(panel, uuid, pdata, pstats) {
  const hasStats = pstats && pstats.stats;
  panel.innerHTML = `
    <div class="pd-tabs">
      <button class="pd-tab active" data-pdt="overview">Overview</button>
      <button class="pd-tab" data-pdt="inventory">Inventory</button>
      <button class="pd-tab" data-pdt="enderchest">Ender Chest</button>
      ${hasStats ? '<button class="pd-tab" data-pdt="stats">Stats</button>' : ''}
    </div>
    <div class="pd-content" id="pd-content-${uuid}"></div>`;

  // Tab switching
  panel.querySelectorAll('.pd-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      panel.querySelectorAll('.pd-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderPlayerDetailTab(uuid, tab.dataset.pdt, pdata, pstats);
    });
  });

  renderPlayerDetailTab(uuid, 'overview', pdata, pstats);
}

function renderPlayerDetailTab(uuid, tab, pdata, pstats) {
  const el = document.getElementById(`pd-content-${uuid}`);
  if (!el) return;

  if (tab === 'overview') {
    const hpPct = Math.round((pdata.health / pdata.maxHealth) * 100);
    const foodPct = Math.round((pdata.foodLevel / 20) * 100);
    el.innerHTML = `<div class="pd-overview-grid">
      <div class="pd-stat-card"><div class="pd-stat-label">Health</div><div class="pd-stat-value"><span class="pd-stat-icon">❤️</span>${Math.round(pdata.health * 10) / 10} / ${pdata.maxHealth}</div><div class="pd-stat-sub"><div style="background:var(--border);border-radius:4px;height:4px;margin-top:4px"><div style="background:#ff4d6d;width:${hpPct}%;height:100%;border-radius:4px"></div></div></div></div>
      <div class="pd-stat-card"><div class="pd-stat-label">Food</div><div class="pd-stat-value"><span class="pd-stat-icon">🍖</span>${pdata.foodLevel} / 20</div><div class="pd-stat-sub"><div style="background:var(--border);border-radius:4px;height:4px;margin-top:4px"><div style="background:#ffb340;width:${foodPct}%;height:100%;border-radius:4px"></div></div></div></div>
      <div class="pd-stat-card"><div class="pd-stat-label">XP Level</div><div class="pd-stat-value"><span class="pd-stat-icon">⭐</span>${pdata.xpLevel}</div><div class="pd-stat-sub">${pdata.xpTotal.toLocaleString()} total XP</div></div>
      <div class="pd-stat-card"><div class="pd-stat-label">Gamemode</div><div class="pd-stat-value"><span class="pd-stat-icon">🎮</span>${escHtml(pdata.gamemode)}</div></div>
      <div class="pd-stat-card"><div class="pd-stat-label">Position</div><div class="pd-stat-value"><span class="pd-stat-icon">📍</span>${pdata.position.join(', ')}</div><div class="pd-stat-sub">${escHtml(pdata.dimension)}</div></div>
      <div class="pd-stat-card"><div class="pd-stat-label">Score</div><div class="pd-stat-value"><span class="pd-stat-icon">🏆</span>${pdata.score}</div></div>
    </div>
    ${pdata.armor.length ? `<div class="pd-inv-section"><div class="pd-inv-label">Armor</div><div class="pd-armor-grid">${renderArmorSlots(pdata.armor)}</div></div>` : ''}
    ${state.serverType === 'java' ? `
      <div style="margin-top:24px;padding-top:20px;border-top:1px solid var(--border);display:flex;justify-content:flex-end">
        <button class="pc-act-btn ban" onclick="confirmDeletePlayerData('${uuid}')" style="padding:8px 16px;font-size:12px">⚠️ Delete Player Data</button>
      </div>` : ''}`;

  } else if (tab === 'inventory') {
    el.innerHTML = `<div class="pd-inv-section"><div class="pd-inv-label">Hotbar (selected: slot ${pdata.selectedSlot})</div><div class="pd-inv-grid">${renderInvSlots(pdata.inventory, 0, 8, pdata.selectedSlot)}</div></div>
    <div class="pd-inv-section"><div class="pd-inv-label">Main Inventory</div><div class="pd-inv-grid">${renderInvSlots(pdata.inventory, 9, 35)}</div></div>
    ${pdata.inventory.filter(i => i.slot === -106).length ? `<div class="pd-inv-section"><div class="pd-inv-label">Offhand</div><div class="pd-inv-grid" style="grid-template-columns:1fr;max-width:60px">${renderSingleSlot(pdata.inventory.find(i => i.slot === -106))}</div></div>` : ''}`;

  } else if (tab === 'enderchest') {
    if (!pdata.enderChest.length) {
      el.innerHTML = '<div class="pd-loading" style="padding:30px">Ender chest is empty.</div>';
    } else {
      el.innerHTML = `<div class="pd-inv-section"><div class="pd-inv-label">Ender Chest (${pdata.enderChest.length} items)</div><div class="pd-inv-grid">${renderInvSlots(pdata.enderChest, 0, 26)}</div></div>`;
    }

  } else if (tab === 'stats' && pstats && pstats.stats) {
    const cats = pstats.stats;
    const CAT_LABELS = {
      'minecraft:custom': '📊 General',
      'minecraft:mined': '⛏️ Blocks Mined',
      'minecraft:crafted': '🔨 Items Crafted',
      'minecraft:used': '🖐️ Items Used',
      'minecraft:broken': '💔 Items Broken',
      'minecraft:picked_up': '📥 Items Picked Up',
      'minecraft:dropped': '📤 Items Dropped',
      'minecraft:killed': '⚔️ Mobs Killed',
      'minecraft:killed_by': '💀 Killed By',
    };

    let html = '<div class="pd-stats-grid">';
    for (const [catKey, entries] of Object.entries(cats)) {
      const sorted = Object.entries(entries).sort((a, b) => b[1] - a[1]).slice(0, 15);
      if (!sorted.length) continue;
      const label = CAT_LABELS[catKey] || formatStatKey(catKey);
      html += `<div class="pd-stats-category"><div class="pd-stats-cat-title">${escHtml(label)}</div><div class="pd-stats-cat-body">`;
      for (const [k, v] of sorted) {
        let val = v;
        // Convert ticks to hours for time stats
        if (k.includes('time') || k.includes('since')) val = Math.round(v / 20 / 60) + ' min';
        else if (k.includes('one_cm')) val = (v / 100).toFixed(1) + ' m';
        else val = formatStatNumber(v);
        html += `<div class="pd-stat-row"><span class="stat-key">${formatStatKey(k)}</span><span class="stat-val">${val}</span></div>`;
      }
      html += '</div></div>';
    }
    html += '</div>';
    el.innerHTML = html;
  }
}

function renderInvSlots(items, startSlot, endSlot, selectedSlot) {
  let html = '';
  for (let s = startSlot; s <= endSlot; s++) {
    const item = items.find(i => i.slot === s);
    html += renderSingleSlot(item, s === selectedSlot);
  }
  return html;
}

function renderSingleSlot(item, isSelected) {
  if (!item) return `<div class="pd-inv-slot${isSelected ? ' selected' : ''}"></div>`;
  
  const itemUrl = `https://cdn.jsdelivr.net/gh/PrismarineJS/minecraft-assets@master/data/1.20.2/minecraft/textures/item/${item.id}.png`;
  const blockUrl = `https://cdn.jsdelivr.net/gh/PrismarineJS/minecraft-assets@master/data/1.20.2/minecraft/textures/block/${item.id}.png`;
  const fallbackIcon = getItemIcon(item.id);
  const formattedName = formatItemName(item.id);

  return `<div class="pd-inv-slot has-item${isSelected ? ' selected' : ''}" title="${formattedName} x${item.count}">
    <span class="item-icon">
      <img src="${itemUrl}" 
           alt="${escHtml(item.id)}"
           class="pd-item-img"
           onerror="if (this.src !== '${blockUrl}') { this.src = '${blockUrl}'; } else { this.replaceWith(document.createTextNode('${fallbackIcon}')); }" />
    </span>
    ${item.count > 1 ? `<span class="item-count">${item.count}</span>` : ''}
  </div>`;
}

function renderArmorSlots(armor) {
  const ARMOR_SLOTS = [
    { slot: 103, label: 'Helmet' },
    { slot: 102, label: 'Chest' },
    { slot: 101, label: 'Legs' },
    { slot: 100, label: 'Boots' },
  ];
  return ARMOR_SLOTS.map(as => {
    const item = armor.find(a => a.slot === as.slot);
    return renderSingleSlot(item);
  }).join('');
}
// Add Player button opens modal
document.getElementById('add-player-btn').addEventListener('click', () => {
  const isBedrock = state.serverType === 'bedrock';
  document.getElementById('modal-title').textContent = isBedrock ? 'Add to Allowlist' : 'Add to Whitelist';
  document.getElementById('modal-label').textContent = 'Player Name';
  document.getElementById('modal-input').value = '';
  document.getElementById('modal-input').placeholder = 'PlayerName';
  document.getElementById('modal-overlay').dataset.mode = 'add';
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('modal-input').focus();
});

// Remove Player button
document.getElementById('remove-player-btn').addEventListener('click', () => {
  const isBedrock = state.serverType === 'bedrock';
  document.getElementById('modal-title').textContent = isBedrock ? 'Remove from Allowlist' : 'Remove from Whitelist';
  document.getElementById('modal-label').textContent = 'Player Name';
  document.getElementById('modal-input').value = '';
  document.getElementById('modal-input').placeholder = 'PlayerName';
  document.getElementById('modal-overlay').dataset.mode = 'remove';
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('modal-input').focus();
});

// Modal handler
document.getElementById('modal-cancel').addEventListener('click', () => {
  document.getElementById('modal-overlay').classList.add('hidden');
});

document.getElementById('modal-confirm').addEventListener('click', () => {
  if (document.getElementById('modal-overlay').dataset.mode === 'remove') confirmRemovePlayer();
  else confirmAddPlayer();
});
document.getElementById('modal-input').addEventListener('keydown', e => { 
  if (e.key === 'Enter') {
    if (document.getElementById('modal-overlay').dataset.mode === 'remove') confirmRemovePlayer();
    else confirmAddPlayer();
  }
});

async function confirmRemovePlayer() {
  const val = document.getElementById('modal-input').value.trim();
  if (!val) return;
  document.getElementById('modal-overlay').classList.add('hidden');

  const isBedrock = state.serverType === 'bedrock';
  const cmd = isBedrock ? `allowlist remove ${val}` : `whitelist remove ${val}`;

  try {
    const res = await api('POST', `/api/containers/${state.currentContainer.Id}/command`, { command: cmd });
    // Also try to deop and kick
    await api('POST', `/api/containers/${state.currentContainer.Id}/command`, { command: `deop ${val}` });
    await api('POST', `/api/containers/${state.currentContainer.Id}/command`, { command: `kick ${val} Removed by admin` });
    
    toast(res.response || `Removed ${val}!`, 'success');
    setTimeout(() => loadPlayers(), 800);
  } catch (e) { toast(e.message, 'error'); }
}

async function confirmAddPlayer() {
  const val = document.getElementById('modal-input').value.trim();
  if (!val) return;
  document.getElementById('modal-overlay').classList.add('hidden');

  const isBedrock = state.serverType === 'bedrock';
  const cmd = isBedrock ? `allowlist add ${val}` : `whitelist add ${val}`;

  try {
    const res = await api('POST', `/api/containers/${state.currentContainer.Id}/command`, { command: cmd });
    toast(res.response || `Added ${val}!`, 'success');
    setTimeout(() => loadPlayers(), 800);
  } catch (e) { toast(e.message, 'error'); }
}

async function confirmDeletePlayerData(uuid) {
  if (!confirm('Are you sure you want to PERMANENTLY delete this player\'s data? This includes inventory, stats, and achievements. This cannot be undone.')) return;
  
  try {
    await api('DELETE', `/api/containers/${state.currentContainer.Id}/player-data/${uuid}`);
    toast('Player data deleted successfully.', 'success');
    state.selectedPlayerUuid = null;
    setTimeout(() => loadPlayers(), 800);
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ══════════════════════════════════════════════
//  UTILS
// ══════════════════════════════════════════════
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ══════════════════════════════════════════════
//  KEYBOARD SHORTCUTS
// ══════════════════════════════════════════════
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'Escape' && !document.getElementById('page-dashboard').classList.contains('hidden') === false) {
    // On container view, Escape goes back
    if (!document.getElementById('page-container').classList.contains('hidden')) {
      closeWs(); showView('dashboard'); loadContainers();
    }
  }
  if (e.key === 'r' || e.key === 'R') {
    if (!document.getElementById('page-dashboard').classList.contains('hidden')) {
      loadContainers();
    }
  }
});

// ══════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════
if (state.token) {
  showView('dashboard');
  loadContainers();
} else {
  showView('login');
}
