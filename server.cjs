const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const protobuf = require('protobufjs');
// 官方 rustplus.proto 把大量字段标为 required，但真实服务器会省略值为 0 / 空的字段（例如 queuedPlayers），
// 解码时抛出 ProtocolError 并导致整个后台崩溃。这里在加载 rustplus.proto 后把所有字段放宽为 optional。
const loadProto = protobuf.load;
protobuf.load = function(file, ...rest) {
  const relax = ns => { for (const o of ns.nestedArray || []) { if (o instanceof protobuf.Type) for (const f of o.fieldsArray) { f.rule = 'optional'; if (f._features) f._features.field_presence = 'EXPLICIT'; } if (o.nestedArray) relax(o); } return ns; };
  const p = loadProto.call(this, file, ...rest);
  return typeof file === 'string' && file.endsWith('rustplus.proto') && p?.then ? p.then(relax) : p;
};
const RustPlus = require('@liamcottle/rustplus.js');
const {clock, realDuration, dayNight, timeSummary, grid, deaths, presenceChanges, monumentName, monumentLabels, validate} = require('./core.cjs');
const {DiscordBridge} = require('./discord.cjs');

const root = __dirname, data = process.env.RUSTPLUS_DATA_DIR || path.join(root, 'data');
fs.mkdirSync(data, {recursive: true});
const tempDir = path.join(data, 'tmp'); fs.mkdirSync(tempDir, {recursive: true});
const settingsFile = path.join(data, 'settings.json');
const fcmFile = path.join(data, 'rustplus.config.json');
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };

let config = {
  lang: 'zh-CN',
  name: '我的 Rust 服务器',
  host: '',
  port: 28082,
  playerId: '',
  playerToken: '',
  deathNotify: true,
  onlineNotify: false,
  timeEvery: 0,
  servers: [],
  discord: {
    enabled: false,
    webhookUrl: '',
    botToken: '',
    channelId: '',
    notifyDeath: true,
    notifyOnline: true,
    notifyChat: false,
    chatBridge: false
  },
  ...read(settingsFile)
};
delete config.eventNotify;
if (!Array.isArray(config.servers)) config.servers = [];
if (!config.discord || typeof config.discord !== 'object') config.discord = {};

function upsertServer(c) {
  if (!c.host || !c.port || !c.playerId || !c.playerToken) return;
  const id = `${c.host}:${c.port}`;
  const entry = {id, name: c.name || id, host: c.host, port: Number(c.port), playerId: String(c.playerId), playerToken: String(c.playerToken)};
  const idx = config.servers.findIndex(s => s.id === id);
  if (idx >= 0) config.servers[idx] = entry;
  else config.servers.unshift(entry);
  if (config.servers.length > 20) config.servers.length = 20;
}
try { validate(config, config); upsertServer(config); } catch {}

let client, timer, retry, busy = false, generation = 0, pollCount = 0;
let previous = new Map(), mapImage = null, lastTimeSent = Date.now(), receiver, registration;
const csrf = crypto.randomBytes(24).toString('hex');
const state = {
  connection: '未连接',
  authenticated: false,
  server: null,
  time: null,
  leaderSteamId: '',
  members: [],
  deaths: [],
  chat: [],
  mapMeta: null,
  events: [],
  pairing: '尚未配对',
  updated: null
};

const event = (text, type = 'info') => {
  state.events.unshift({at: new Date().toISOString(), text, type});
  state.events.length = Math.min(state.events.length, 200);
};
function save() { fs.writeFileSync(settingsFile, JSON.stringify(config, null, 2)); }

const discord = new DiscordBridge({
  apiBase: process.env.DISCORD_API_BASE,
  gatewayUrl: process.env.DISCORD_GATEWAY_URL,
  getState: () => ({...state, config, clock: clock(state.time?.time), dayNight: dayNight(state.time), mapImage}),
  sendToGame: text => queueSend(text, 'Discord 转发：' + text, 'sent'),
  promoteLeader: steamId => promoteLeader(steamId),
  onEvent: (text, type) => event(text, type)
});
try { discord.configure(config.discord); } catch {}

function cleanConfig() {
  const {playerToken, servers = [], discord: dc, ...rest} = config;
  return {
    ...rest,
    hasToken: !!playerToken,
    activeServerId: config.host && config.port ? `${config.host}:${config.port}` : '',
    servers: servers.map(({playerToken: t, ...s}) => ({...s, hasToken: !!t})),
    discord: discord.cleanConfig()
  };
}
function stop() {
  generation++; clearInterval(timer); clearTimeout(retry); timer = retry = null;
  const c = client; client = null; c?.disconnect();
  previous.clear(); mapImage = null; busy = false; pollCount = 0;
  state.connection = '未连接'; state.authenticated = false; state.leaderSteamId = '';
  state.members = []; state.chat = []; state.mapMeta = null;
  state.server = null; state.time = null; state.updated = null;
}

async function request(key, payload = {}) {
  const c = client; if (!c) throw Error('请先连接服务器');
  let r;
  try { r = await c.sendRequestAsync({[key]: payload}, 10000); }
  catch (e) { throw Error(e.error ? '服务器拒绝请求：' + e.error : (e.message || 'Rust+ 请求失败')); }
  const response = r.response || r;
  if (response.error) throw Error('服务器拒绝请求：' + response.error.error);
  return response;
}

let sendChain = Promise.resolve();
function queueSend(message, logText, logType = 'sent') {
  const g = generation;
  const job = sendChain.catch(() => {}).then(async () => {
    if (g !== generation) throw Error('连接已更改');
    await request('sendTeamMessage', {message});
    if (logText) event(logText, logType);
    await new Promise(r => setTimeout(r, 1200));
  });
  sendChain = job;
  return job;
}
function send(text) {
  return queueSend('[队伍助手] ' + text, text, 'sent');
}
function appendChat(msg) {
  const item = {
    steamId: String(msg.steamId || ''),
    name: String(msg.name || '队员'),
    message: String(msg.message || ''),
    color: String(msg.color || '#b1e784'),
    time: Number(msg.time) || Math.floor(Date.now() / 1000)
  };
  if (!item.message) return;
  const last = state.chat[state.chat.length - 1];
  if (last && last.steamId === item.steamId && last.message === item.message && Math.abs(last.time - item.time) <= 2) return;
  state.chat.push(item);
  if (state.chat.length > 60) state.chat.splice(0, state.chat.length - 60);
}

function updateServerInfo(info) {
  if (!info) return;
  state.server = {
    ...info,
    players: Number(info.players) || 0,
    maxPlayers: Number(info.maxPlayers) || 0,
    queuedPlayers: Number(info.queuedPlayers) || 0,
    mapSize: Number(info.mapSize) || 4500
  };
  if (state.mapMeta) state.mapMeta.mapSize = state.server.mapSize;
}

function updateTeam(teamInfo) {
  const mapSize = state.server?.mapSize || 4500;
  const srvName = state.server?.name || config.name;
  const leaderSteamId = String(teamInfo?.leaderSteamId || '');
  state.leaderSteamId = leaderSteamId;
  const members = teamInfo?.members || [];
  const normalized = members.map(m => {
    const steamId = String(m.steamId);
    const x = Number(m.x) || 0, y = Number(m.y) || 0;
    return {
      ...m,
      steamId,
      x,
      y,
      isOnline: Boolean(m.isOnline),
      isAlive: Boolean(m.isAlive),
      spawnTime: Number(m.spawnTime) || 0,
      deathTime: Number(m.deathTime) || 0,
      grid: grid(x, y, mapSize),
      isLeader: steamId === leaderSteamId
    };
  });
  for (const m of deaths(previous, normalized)) {
    const pos = m.grid ? `（坐标 ${m.grid}）` : '';
    const clockText = clock(state.time?.time);
    const realNow = new Date().toLocaleTimeString('zh-CN', {hour12: false, hour: '2-digit', minute: '2-digit'});
    const text = `${m.name} 已死亡${pos}，游戏时间 ${clockText}（现实 ${realNow}）`;
    state.deaths.unshift({name: m.name, steamId: m.steamId, x: m.x, y: m.y, grid: m.grid, at: new Date().toISOString(), clock: clockText, realClock: realNow});
    if (state.deaths.length > 15) state.deaths.length = 15;
    event(text, 'death');
    if (config.deathNotify) send(text).catch(e => event(e.message, 'error'));
    discord.notifyDeath(m, `${clockText}（现实 ${realNow}）`, srvName);
  }
  for (const c of presenceChanges(previous, normalized)) {
    const text = `${c.member.name} 已${c.isOnline ? '上线' : '离线'}`;
    event(text, 'info');
    if (config.onlineNotify) send(text).catch(e => event(e.message, 'error'));
    discord.notifyPresence(c.member, c.isOnline, srvName);
  }
  previous = new Map(normalized.map(m => [m.steamId, m]));
  state.members = normalized;
}

async function fetchMap(g = generation) {
  try {
    const r = await request('getMap');
    if (g !== generation || !r.map) return;
    const mapSize = state.server?.mapSize || 4500;
    if (r.map.jpgImage && r.map.jpgImage.length) {
      mapImage = Buffer.from(r.map.jpgImage);
    }
    const monuments = [];
    for (const m of r.map.monuments || []) {
      const labels = monumentLabels(m.token);
      if (!labels) continue;
      const x = Number(m.x) || 0, y = Number(m.y) || 0;
      monuments.push({name: labels['zh-CN'], labels, x, y, grid: grid(x, y, mapSize)});
    }
    state.mapMeta = {
      hasImage: !!mapImage,
      width: Number(r.map.width) || 0,
      height: Number(r.map.height) || 0,
      oceanMargin: Number(r.map.oceanMargin) || 0,
      background: r.map.background || '#0b3b4a',
      mapSize,
      monuments,
      updatedAt: Date.now()
    };
  } catch {}
}

async function fetchTeamChat(g = generation) {
  try {
    const r = await request('getTeamChat');
    if (g !== generation) return;
    for (const m of r.teamChat?.messages || []) appendChat(m);
  } catch {}
}

async function promoteLeader(targetSteamId) {
  const target = state.members.find(m => m.steamId === String(targetSteamId));
  if (!target) throw Error('未在当前队伍中找到该成员');
  await request('promoteToLeader', {steamId: String(target.steamId)});
  state.leaderSteamId = target.steamId;
  state.members = state.members.map(m => ({...m, isLeader: m.steamId === target.steamId}));
  event(`已请求将队长移交给 ${target.name}`);
  return target;
}

async function poll() {
  if (busy || !client) return;
  busy = true;
  const g = generation;
  const currentPoll = ++pollCount;
  try {
    if (!state.server || currentPoll % 3 === 0) {
      try {
        const info = await request('getInfo');
        if (g !== generation) return;
        updateServerInfo(info.info);
      } catch {}
    }
    const t = await request('getTime'); if (g !== generation) return; state.time = t.time;
    const team = await request('getTeamInfo'); if (g !== generation) return;
    updateTeam(team.teamInfo);
    state.authenticated = true; state.connection = '已连接'; state.updated = new Date().toISOString();
    if (config.timeEvery > 0 && Date.now() - lastTimeSent >= config.timeEvery * 60000) {
      lastTimeSent = Date.now();
      await send(timeSummary(state.time));
    }
  } catch (e) {
    if (g === generation) { state.authenticated = false; state.connection = '请求失败'; event(e.message, 'error'); }
  } finally {
    if (g === generation) busy = false;
  }
}

function connect() {
  validate(config, config);
  upsertServer(config);
  save();
  stop();
  const g = generation;
  state.connection = '连接中';
  const c = new RustPlus(config.host, String(config.port), config.playerId, Number(config.playerToken));
  client = c;
  c.on('connected', async () => {
    if (g !== generation) return;
    state.connection = '验证配对中';
    event('Rust+ 通道已连接，正在验证配对');
    try { const r = await request('getInfo'); if (g !== generation) return; updateServerInfo(r.info); } catch (e) { event(e.message, 'error'); }
    if (g !== generation) return;
    await poll();
    if (g !== generation) return;
    fetchTeamChat(g);
    fetchMap(g);
    timer = setInterval(poll, 10000);
  });
  c.on('disconnected', () => {
    if (g !== generation) return;
    clearInterval(timer);
    state.connection = '连接中断，30 秒后重试';
    state.authenticated = false;
    retry = setTimeout(() => { if (g === generation) connect(); }, 30000);
  });
  c.on('error', () => {
    if (g === generation) event('Rust+ 连接失败，请检查地址、端口、配对令牌和网络', 'error');
  });
  let commandAt = 0;
  c.on('message', msg => {
    if (g !== generation) return;
    if (msg.broadcast?.teamChanged?.teamInfo) {
      updateTeam(msg.broadcast.teamChanged.teamInfo);
    }
    const chat = msg.broadcast?.teamMessage?.message;
    if (!chat) return;
    appendChat(chat);
    discord.notifyTeamChat(chat, state.server?.name || config.name);
    if (String(chat.message || '').startsWith('[队伍助手]')) return;
    const raw = String(chat.message || '').trim();
    if (!raw.startsWith('!') && !raw.startsWith('！')) return;
    const normalizedCmd = raw.replace(/^！/, '!');
    const [cmd, ...rest] = normalizedCmd.split(/\s+/);
    const arg = rest.join(' ').trim();
    const known = ['!time', '!时间', '!pop', '!人数', '!deaths', '!死亡', '!pos', '!位置', '!team', '!leader', '!队长', '!help', '!帮助'];
    if (!known.includes(cmd.toLowerCase()) || Date.now() - commandAt < 5000) return;
    commandAt = Date.now();
    const key = cmd.toLowerCase();
    if (['!leader', '!队长'].includes(key)) {
      const senderId = String(chat.steamId || '');
      const target = arg
        ? state.members.find(m => m.name.toLowerCase().includes(arg.toLowerCase()) || m.steamId === arg)
        : state.members.find(m => m.steamId === senderId);
      if (!target) {
        send('未找到目标队友').catch(e => event(e.message, 'error'));
      } else {
        promoteLeader(target.steamId)
          .then(t => send(`已将队长移交给 ${t.name}`))
          .catch(e => send('移交队长失败：' + e.message).catch(() => {}));
      }
      return;
    }
    let text;
    if (['!time', '!时间'].includes(key)) {
      text = timeSummary(state.time);
    } else if (['!pop', '!人数'].includes(key)) {
      text = state.server
        ? `服务器在线 ${state.server.players}/${state.server.maxPlayers}，排队 ${state.server.queuedPlayers || 0} 人`
        : '暂无服务器人数信息';
    } else if (['!deaths', '!死亡'].includes(key)) {
      text = state.deaths.length
        ? state.deaths.slice(0, 3).map(d => `${d.name}${d.grid ? '(' + d.grid + ')' : ''} ${realDuration((Date.now() - new Date(d.at).getTime()) / 1000)}前（游戏 ${d.clock}）`).join('；')
        : (state.events.filter(e => e.type === 'death').slice(0, 3).map(e => e.text).join('；') || '本次运行期间暂无死亡记录');
    } else if (['!pos', '!位置', '!team'].includes(key)) {
      text = state.members.length
        ? '队伍位置：' + state.members.map(m => `${m.name}(${m.grid || '?'}${m.isAlive ? '' : '·死'}${m.isOnline ? '' : '·离'})`).join('、')
        : '暂无队伍位置信息';
    } else {
      text = '命令：!时间 !人数 !位置 !死亡 !队长 !帮助';
    }
    send(text).catch(e => event(e.message, 'error'));
  });
  c.connect();
  lastTimeSent = Date.now();
}

async function listenPairing() {
  if (receiver) return;
  const cred = read(fcmFile).fcm_credentials;
  if (!cred?.gcm) throw Error('请先完成 Steam 配对登录，或导入已有 Rust+ 配置');
  const PushClient = require('@liamcottle/push-receiver/src/client');
  const r = new PushClient(cred.gcm.androidId, cred.gcm.securityToken, []);
  receiver = r;
  r.on('ON_DATA_RECEIVED', notification => {
    try {
      const pairs = notification.appData || notification.notification?.data || notification.data || [];
      const raw = Array.isArray(pairs) ? pairs.find(p => p.key === 'body')?.value : pairs.body;
      const body = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (body?.type !== 'server') return;
      config = validate({host: body.ip, port: body.port, playerId: body.playerId, playerToken: body.playerToken, name: body.name}, config);
      upsertServer(config);
      save();
      state.pairing = '已收到服务器配对：' + config.name;
      event(state.pairing);
      try { connect(); } catch {}
    } catch {
      event('收到无法解析的配对通知，请尝试重新配对', 'error');
    }
  });
  try { await r.connect(); state.pairing = '等待游戏内 ESC → Rust+ → 与服务器配对'; }
  catch { receiver = null; throw Error('无法连接推送服务，请检查网络'); }
}

function findBrowser() {
  const exists = p => { try { return !!p && fs.statSync(p).isFile(); } catch { return false; } };
  const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']].filter(Boolean);
  if (exists(process.env.CHROME_PATH)) return {name: 'Chrome', path: process.env.CHROME_PATH};
  for (const r of roots) for (const s of ['Google/Chrome/Application/chrome.exe', 'Google/Chrome SxS/Application/chrome.exe']) if (exists(path.join(r, s))) return {name: 'Chrome', path: path.join(r, s)};
  for (const r of roots) if (exists(path.join(r, 'Microsoft/Edge/Application/msedge.exe'))) return {name: 'Edge', path: path.join(r, 'Microsoft/Edge/Application/msedge.exe')};
  return null;
}

function register() {
  if (registration) throw Error('配对登录已在运行，请在打开的专用浏览器窗口完成登录');
  const browser = findBrowser(); if (!browser) throw Error('未找到 Google Chrome 或 Microsoft Edge，请安装其一，或使用「导入已有配对配置」');
  const original = path.join(path.dirname(require.resolve('@liamcottle/rustplus.js/package.json')), 'cli', 'index.js');
  let source = fs.readFileSync(original, 'utf8');
  const pairPage = path.join(data, 'pair.html');
  let html = fs.readFileSync(path.join(path.dirname(original), 'pair.html'), 'utf8');
  html = html.replace('<html lang="en">', '<html lang="zh-CN">').replace('RustPlus Pairing', 'Rust+ 账号配对').replace('To pair rustplus.js with Rust+, you must allow popup windows. You may need to refresh this page after enabling popups.', '请在弹出的 Steam 官方页面登录，完成后此专用窗口会自动关闭。若未弹出登录页，请允许此页面弹出窗口并刷新。');
  fs.writeFileSync(pairPage, html);
  source = source.replace("app.listen(port, async () =>", "app.listen(port, '127.0.0.1', async () =>");
  source = source.replace("'--user-data-dir=/tmp/temporary-chrome-profile-dir-rustplus'", JSON.stringify('--user-data-dir=' + path.join(data, 'pairing-' + browser.name.toLowerCase())));
  source = source.replace("path.join(__dirname + '/pair.html')", JSON.stringify(pairPage));
  source = source.replace('Steam Account successfully linked with rustplus.js, you can now close this window and go back to the console.', 'Steam 账号已关联，请返回中文队伍助手网页。');
  const patched = path.join(root, 'pair-register.cjs'); fs.writeFileSync(patched, source);
  registration = spawn(process.execPath, [patched, '--config-file', fcmFile, 'fcm-register'], {cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, TEMP: tempDir, TMP: tempDir, CHROME_PATH: browser.path}});
  state.pairing = `正在注册推送并打开 ${browser.name}，请在弹出窗口登录 Steam`;
  registration.stdout.on('data', chunk => { const text = chunk.toString(); if (text.includes('Chrome is launching')) state.pairing = `请在专用 ${browser.name} 窗口完成 Steam 登录`; });
  registration.stderr.on('data', () => {});
  registration.on('error', () => { state.pairing = '无法启动登录流程'; registration = null; });
  registration.on('exit', code => { registration = null; if (code === 0 && read(fcmFile).fcm_credentials) { event('Steam 配对注册完成'); listenPairing().catch(e => { state.pairing = e.message; }); } else state.pairing = '登录注册未完成，请检查网络，或导入已有配对配置'; });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
  const allowed = ['127.0.0.1:3210', 'localhost:3210']; if (!allowed.includes(req.headers.host)) { res.writeHead(403); return res.end(); }
  const json = (obj, status = 200) => { res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'}); res.end(JSON.stringify(obj)); };
  try {
    const urlPath = req.url.split('?')[0];
    if (req.method === 'GET' && urlPath === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(fs.readFileSync(path.join(root, 'index.html'))); }
    if (req.method === 'GET' && urlPath === '/api/state') {
      const l = config.lang || 'zh-CN';
      return json({...state, appId: 'rustplus-zh-web', config: cleanConfig(), discordStatus: discord.status, clock: clock(state.time?.time), dayNight: dayNight(state.time, l), csrf});
    }
    if (req.method === 'GET' && urlPath === '/api/map.jpg') {
      if (!mapImage) { res.writeHead(404); return res.end(); }
      res.writeHead(200, {'Content-Type': 'image/jpeg'});
      return res.end(mapImage);
    }
    if (req.method !== 'POST') return json({error: '未找到页面'}, 404);
    if (req.headers['x-csrf-token'] !== csrf || !['http://127.0.0.1:3210', 'http://localhost:3210'].includes(req.headers.origin)) return json({error: '请求来源无效，请刷新网页'}, 403);
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 131072) throw Error('提交内容过大'); } const body = JSON.parse(raw || '{}');
    switch (urlPath) {
      case '/api/lang': {
        if (!['zh-CN', 'zh-TW', 'en'].includes(body.lang)) throw Error('不支持的语言');
        config.lang = body.lang;
        save();
        break;
      }
      case '/api/config':
        config = validate(body, config);
        config.deathNotify = body.deathNotify === true;
        config.onlineNotify = body.onlineNotify === true;
        config.timeEvery = Number(body.timeEvery) || 0;
        if (![0, 5, 10, 15, 30, 60].includes(config.timeEvery)) throw Error('请选择有效的播报间隔');
        upsertServer(config);
        save();
        break;
      case '/api/discord': {
        const next = {
          enabled: body.enabled === true,
          webhookUrl: body.webhookUrl !== undefined && !String(body.webhookUrl).includes('******') ? String(body.webhookUrl).trim() : (config.discord?.webhookUrl || ''),
          botToken: body.botToken !== undefined && String(body.botToken).trim() !== '' ? String(body.botToken).trim() : (config.discord?.botToken || ''),
          channelId: String(body.channelId || '').trim(),
          notifyDeath: body.notifyDeath !== false,
          notifyOnline: body.notifyOnline === true,
          notifyChat: body.notifyChat === true,
          chatBridge: body.chatBridge === true,
          clearBotToken: body.clearBotToken === true
        };
        if (next.clearBotToken) next.botToken = '';
        discord.configure(next);
        config.discord = {...discord.config};
        save();
        break;
      }
      case '/api/discord-test': {
        if (!discord.config.enabled) throw Error('请先勾选启用 Discord 机器人 / Webhook 并保存设置');
        const srvName = state.server?.name || config.name;
        await discord.sendEmbed({
          color: 0xb1e784,
          title: '✅ Discord 联动测试成功',
          description: [
            `当前服务器：**${srvName}**（${state.connection}）`,
            `游戏内时间：**${clock(state.time?.time)}**（${dayNight(state.time).text}）`,
            `队伍在线：**${state.members.filter(m => m.isOnline).length} / ${state.members.length}**`
          ].join('\n'),
          footer: 'Rust+ 中文队伍助手'
        });
        event('已向 Discord 发送测试卡片', 'sent');
        break;
      }
      case '/api/discord-map': {
        if (!discord.config.enabled) throw Error('请先启用 Discord 机器人 / Webhook');
        if (!mapImage) throw Error('当前尚未加载到服务器地图，请先连接服务器');
        const {embed, imageBuffer} = await discord.buildCommandEmbed('map');
        await discord.sendEmbed(embed, discord.config.channelId, imageBuffer);
        event('已向 Discord 发送服务器高清地图', 'sent');
        break;
      }
      case '/api/connect': connect(); break;
      case '/api/disconnect': stop(); break;
      case '/api/shutdown': json({ok: true}); setTimeout(shutdown, 100); return;
      case '/api/send-time': if (!state.authenticated) throw Error('请先连接并验证服务器'); await send(timeSummary(state.time)); break;
      case '/api/chat': {
        if (!state.authenticated) throw Error('请先连接并验证服务器');
        const msg = String(body.message || '').trim();
        if (!msg) throw Error('请输入要发送的消息');
        if (msg.length > 128) throw Error('单条队伍消息不能超过 128 个字符');
        await queueSend(msg, '网页发送：' + msg, 'sent');
        break;
      }
      case '/api/leader': {
        if (!state.authenticated) throw Error('请先连接并验证服务器');
        await promoteLeader(body.steamId);
        break;
      }
      case '/api/refresh-map': {
        if (!state.authenticated) throw Error('请先连接并验证服务器');
        await fetchMap(generation);
        break;
      }
      case '/api/server-select': {
        const target = config.servers.find(s => s.id === String(body.id));
        if (!target) throw Error('未找到保存的服务器');
        config = validate(target, config);
        save();
        connect();
        break;
      }
      case '/api/server-delete': {
        config.servers = config.servers.filter(s => s.id !== String(body.id));
        save();
        break;
      }
      case '/api/register': register(); break;
      case '/api/listen': await listenPairing(); break;
      case '/api/import': {
        const imported = typeof body.config === 'string' ? JSON.parse(body.config) : body.config;
        if (imported.fcm_credentials?.gcm) {
          fs.writeFileSync(fcmFile, JSON.stringify(imported, null, 2));
          receiver?.destroy(); receiver = null;
          await listenPairing();
        } else {
          config = validate({host: imported.ip || imported.host, port: imported.port, playerId: imported.playerId, playerToken: imported.playerToken, name: imported.name || config.name}, config);
          upsertServer(config);
          save();
          state.pairing = '已导入服务器配置';
        }
        break;
      }
      default: return json({error: '未知操作'}, 404);
    }
    json({ok: true});
  } catch (e) { json({error: e.message}, 400); }
});

server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? '端口 3210 已被占用' : e); process.exit(1); });
server.listen(3210, '127.0.0.1', () => console.log('中文 Rust+ 队伍助手 http://127.0.0.1:3210'));
if (read(fcmFile).fcm_credentials) listenPairing().catch(e => { state.pairing = e.message; });
if (config.host && config.playerId && config.playerToken) {
  try { connect(); } catch {}
}
function shutdown() { stop(); discord.stop(); receiver?.destroy(); registration?.kill(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
// 兜底：单条无法解析的 Rust+ / 推送消息不应让整个后台退出（网页会显示「无法连接本机服务」）
process.on('uncaughtException', e => { console.error(new Date().toISOString(), e); event('后台遇到异常已忽略：' + (e?.message || e), 'error'); });
process.on('unhandledRejection', e => { console.error(new Date().toISOString(), e); event('后台遇到异常已忽略：' + (e?.message || e), 'error'); });
