const WebSocket = require('ws');

const SLASH_COMMANDS = [
  {name: 'time', description: '查询当前 Rust 游戏内时间与天亮/天黑倒计时'},
  {name: 'pop', description: '查询当前服务器在线人数与排队人数'},
  {name: 'pos', description: '查询全体队友当前地图网格坐标与状态'},
  {name: 'deaths', description: '查询本次运行最近死亡记录'},
  {name: 'map', description: '获取当前服务器高清地图与队友位置'},
  {
    name: 'say',
    description: '发送消息到游戏内 Rust 队伍聊天频道',
    options: [{name: 'message', description: '要发送的消息内容', type: 3, required: true}]
  },
  {
    name: 'leader',
    description: '将游戏内队伍队长移交给指定队友',
    options: [{name: 'member', description: '队友名称或 SteamID64', type: 3, required: true}]
  }
];

class DiscordBridge {
  constructor(hooks) {
    this.hooks = hooks; // { getState, sendToGame, promoteLeader, onEvent, apiBase, gatewayUrl }
    this.config = {
      enabled: false,
      webhookUrl: '',
      botToken: '',
      channelId: '',
      notifyDeath: true,
      notifyOnline: true,
      notifyChat: false,
      chatBridge: false
    };
    this.ws = null;
    this.heartbeat = null;
    this.reconnectTimer = null;
    this.seq = null;
    this.generation = 0;
    this.useContentIntent = true;
    this.status = '未启用';
    this.botUser = null;
    this.appId = null;
  }

  get apiBase() {
    return this.hooks.apiBase || 'https://discord.com/api/v10';
  }

  get gatewayUrl() {
    return this.hooks.gatewayUrl || 'wss://gateway.discord.gg/?v=10&encoding=json';
  }

  configure(cfg) {
    const prevToken = this.config.botToken;
    const prevEnabled = this.config.enabled;
    this.config = {
      enabled: Boolean(cfg.enabled),
      webhookUrl: String(cfg.webhookUrl || '').trim(),
      botToken: cfg.botToken !== undefined && cfg.botToken !== '' ? String(cfg.botToken).trim() : this.config.botToken,
      channelId: String(cfg.channelId || '').trim(),
      notifyDeath: cfg.notifyDeath !== false,
      notifyOnline: Boolean(cfg.notifyOnline),
      notifyChat: Boolean(cfg.notifyChat),
      chatBridge: Boolean(cfg.chatBridge)
    };
    if (cfg.clearBotToken) this.config.botToken = '';
    if (this.config.webhookUrl && !/^https?:\/\/(ptb\.|canary\.)?(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+|^http:\/\/127\.0\.0\.1:\d+\/webhook/i.test(this.config.webhookUrl)) {
      throw Error('Discord Webhook 链接格式无效');
    }
    if (this.config.channelId && !/^\d{10,22}$/.test(this.config.channelId)) {
      throw Error('Discord 频道 ID 应为纯数字（右键频道 → 复制频道 ID）');
    }
    if (!this.config.enabled) {
      this.stop();
      this.status = '未启用';
      return;
    }
    if (this.config.botToken) {
      if (this.config.botToken !== prevToken || !prevEnabled || !this.ws) {
        this.useContentIntent = true;
        this.startBot();
      }
    } else {
      this.stop();
      this.status = this.config.webhookUrl ? 'Webhook 已就绪（单向推送）' : '请填写 Webhook 链接或 Bot Token';
    }
  }

  cleanConfig() {
    const {botToken, webhookUrl, ...rest} = this.config;
    return {
      ...rest,
      hasBotToken: !!botToken,
      hasWebhook: !!webhookUrl,
      webhookUrl: webhookUrl ? webhookUrl.replace(/\/([^/]{6})[^/]+$/, '/$1******') : ''
    };
  }

  stop() {
    this.generation++;
    clearInterval(this.heartbeat);
    clearTimeout(this.reconnectTimer);
    this.heartbeat = this.reconnectTimer = null;
    const w = this.ws;
    this.ws = null;
    if (w) {
      try { w.removeAllListeners(); w.terminate(); } catch {}
    }
    this.botUser = null;
  }

  async sendEmbed(embed, channelId = this.config.channelId, imageBuffer = null) {
    if (!this.config.enabled) return false;
    const payload = {
      username: 'Rust+ 队伍助手',
      embeds: [{
        color: embed.color || 0xb1e784,
        title: embed.title,
        description: embed.description,
        fields: embed.fields,
        timestamp: new Date().toISOString(),
        ...(imageBuffer ? {image: {url: 'attachment://map.jpg'}} : {}),
        ...(embed.footer ? {footer: {text: embed.footer}} : {})
      }]
    };

    // Prefer Bot API if botToken + channelId are available
    if (this.config.botToken && channelId) {
      const url = `${this.apiBase}/channels/${channelId}/messages`;
      let res;
      if (imageBuffer) {
        const form = new FormData();
        form.append('payload_json', JSON.stringify({embeds: payload.embeds}));
        form.append('files[0]', new Blob([imageBuffer], {type: 'image/jpeg'}), 'map.jpg');
        res = await fetch(url, {method: 'POST', headers: {Authorization: `Bot ${this.config.botToken}`}, body: form});
      } else {
        res = await fetch(url, {
          method: 'POST',
          headers: {Authorization: `Bot ${this.config.botToken}`, 'Content-Type': 'application/json'},
          body: JSON.stringify({embeds: payload.embeds})
        });
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw Error('Discord 发送失败：' + (err.message || res.status));
      }
      return true;
    }

    // Fallback to Webhook URL
    if (this.config.webhookUrl) {
      let res;
      if (imageBuffer) {
        const form = new FormData();
        form.append('payload_json', JSON.stringify(payload));
        form.append('files[0]', new Blob([imageBuffer], {type: 'image/jpeg'}), 'map.jpg');
        res = await fetch(this.config.webhookUrl + '?wait=true', {method: 'POST', body: form});
      } else {
        res = await fetch(this.config.webhookUrl + '?wait=true', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(payload)
        });
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw Error('Discord Webhook 发送失败：' + (err.message || res.status));
      }
      return true;
    }
    throw Error('请先配置 Discord Webhook 链接，或填写 Bot Token 与频道 ID');
  }

  notifyDeath(member, clockText, serverName) {
    if (!this.config.enabled || !this.config.notifyDeath) return;
    const pos = member.grid ? `坐标 **${member.grid}**` : '未知坐标';
    this.sendEmbed({
      color: 0xff6b6b,
      title: `💀 队友死亡：${member.name}`,
      description: `**${member.name}** 已死亡（${pos}）\n游戏时间：**${clockText}**`,
      footer: serverName || 'Rust+ 队伍助手'
    }).catch(e => this.hooks.onEvent?.(e.message, 'error'));
  }

  notifyPresence(member, isOnline, serverName) {
    if (!this.config.enabled || !this.config.notifyOnline) return;
    this.sendEmbed({
      color: isOnline ? 0xb1e784 : 0x99aa9e,
      title: `${isOnline ? '🟢 队友上线' : '⚪ 队友离线'}：${member.name}`,
      description: `**${member.name}** 已${isOnline ? '进入' : '离开'}服务器${member.grid ? `（最后坐标 **${member.grid}**）` : ''}`,
      footer: serverName || 'Rust+ 队伍助手'
    }).catch(e => this.hooks.onEvent?.(e.message, 'error'));
  }

  notifyTeamChat(chat, serverName) {
    if (!this.config.enabled || !this.config.notifyChat) return;
    if (String(chat.message || '').startsWith('[队伍助手]') || String(chat.message || '').startsWith('[DC:')) return;
    this.sendEmbed({
      color: 0x55aaff,
      title: `💬 队伍聊天 · ${chat.name}`,
      description: String(chat.message || ''),
      footer: serverName || 'Rust+ 队伍助手'
    }).catch(() => {});
  }

  async buildCommandEmbed(cmd, arg) {
    const s = this.hooks.getState();
    const srvName = s.server?.name || s.config?.name || 'Rust 服务器';
    switch (cmd) {
      case 'time':
      case '时间':
        return {
          embed: {
            color: 0xb1e784,
            title: `🕒 游戏时间 · ${s.clock}`,
            description: s.dayNight?.text || '等待连接服务器同步时间',
            footer: srvName
          }
        };
      case 'pop':
      case '人数':
        return {
          embed: {
            color: 0xb1e784,
            title: `👥 服务器人数 · ${srvName}`,
            description: s.server
              ? `当前在线：**${s.server.players} / ${s.server.maxPlayers}**\n当前排队：**${s.server.queuedPlayers || 0}** 人\n地图尺寸：**${s.server.mapSize}**`
              : '当前尚未连接服务器',
            footer: srvName
          }
        };
      case 'pos':
      case '位置':
      case 'team':
        return {
          embed: {
            color: 0xb1e784,
            title: `📍 队伍成员位置（${s.members.filter(m => m.isOnline).length}/${s.members.length} 在线）`,
            description: s.members.length
              ? s.members.map(m => `${m.isLeader ? '👑 ' : ''}**${m.name}** · 坐标 \`${m.grid || '?'}\` · ${m.isOnline ? '🟢在线' : '⚪离线'} / ${m.isAlive ? '存活' : '💀死亡'}`).join('\n')
              : '暂无队伍成员信息',
            footer: srvName
          }
        };
      case 'deaths':
      case '死亡': {
        const list = (s.deaths || []).slice(0, 5);
        return {
          embed: {
            color: 0xff6b6b,
            title: '💀 最近死亡记录',
            description: list.length
              ? list.map(d => `• **${d.name}** · 坐标 \`${d.grid || '?'}\` · 游戏时间 ${d.clock}（${new Date(d.at).toLocaleTimeString('zh-CN')}）`).join('\n')
              : '本次运行期间暂无死亡记录',
            footer: srvName
          }
        };
      }
      case 'map':
      case '地图':
        return {
          embed: {
            color: 0x55aaff,
            title: `🗺️ 服务器地图 · ${srvName}`,
            description: s.members.length
              ? '队友当前坐标：' + s.members.map(m => `**${m.name}**(\`${m.grid || '?'}\`)`).join('、')
              : '服务器高清地图',
            footer: srvName
          },
          imageBuffer: s.mapImage || null
        };
      case 'say':
      case '发送': {
        if (!arg) return {embed: {color: 0xffc38d, title: '⚠️ 请输入要发送的内容', description: '用法：`!发送 消息内容` 或 `/say`' }};
        await this.hooks.sendToGame(arg);
        return {embed: {color: 0xb1e784, title: '✅ 已发送到游戏队伍频道', description: arg, footer: srvName}};
      }
      case 'leader':
      case '队长': {
        if (!arg) return {embed: {color: 0xffc38d, title: '⚠️ 请指定队友名字', description: '用法：`!队长 队友名` 或 `/leader`'}};
        const target = s.members.find(m => m.name.toLowerCase().includes(arg.toLowerCase()) || m.steamId === arg);
        if (!target) return {embed: {color: 0xffc38d, title: '⚠️ 未找到该队友', description: `当前队伍中未找到“${arg}”`}};
        await this.hooks.promoteLeader(target.steamId);
        return {embed: {color: 0xb1e784, title: '👑 已请求移交队长', description: `已请求将队长移交给 **${target.name}**`, footer: srvName}};
      }
      default:
        return {
          embed: {
            color: 0xb1e784,
            title: '🤖 Rust+ 队伍助手 · Discord 命令',
            description: [
              '`!时间` / `/time` · 当前游戏时间与天亮/天黑倒计时',
              '`!人数` / `/pop` · 服务器在线人数与排队人数',
              '`!位置` / `/pos` · 全体队友当前地图网格坐标',
              '`!死亡` / `/deaths` · 最近死亡记录（含坐标）',
              '`!地图` / `/map` · 获取服务器高清地图与队友坐标',
              '`!发送 内容` / `/say` · 发送消息到游戏内队伍频道',
              '`!队长 名字` / `/leader` · 移交游戏内队伍队长'
            ].join('\n'),
            footer: srvName
          }
        };
    }
  }

  async registerGuildCommands(guildId) {
    if (!this.appId || !guildId || !this.config.botToken) return;
    try {
      await fetch(`${this.apiBase}/applications/${this.appId}/guilds/${guildId}/commands`, {
        method: 'PUT',
        headers: {Authorization: `Bot ${this.config.botToken}`, 'Content-Type': 'application/json'},
        body: JSON.stringify(SLASH_COMMANDS)
      });
    } catch {}
  }

  startBot() {
    this.stop();
    if (!this.config.enabled || !this.config.botToken) return;
    const g = this.generation;
    this.status = '正在连接 Discord 网关...';
    let ws;
    try {
      ws = new WebSocket(this.gatewayUrl);
    } catch {
      this.status = '无法连接 Discord 网关';
      return;
    }
    this.ws = ws;

    ws.on('message', async raw => {
      if (g !== this.generation) return;
      let packet;
      try { packet = JSON.parse(raw.toString()); } catch { return; }
      const {op, t, s, d} = packet;
      if (s !== null && s !== undefined) this.seq = s;

      if (op === 10) {
        const interval = Number(d?.heartbeat_interval) || 41250;
        clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => {
          if (g === this.generation && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({op: 1, d: this.seq}));
          }
        }, interval);
        const intents = this.useContentIntent ? 37377 : 4609;
        ws.send(JSON.stringify({
          op: 2,
          d: {
            token: this.config.botToken,
            intents,
            properties: {os: 'windows', browser: 'rustplus-zh-web', device: 'rustplus-zh-web'}
          }
        }));
      } else if (op === 7 || op === 9) {
        this.scheduleReconnect(g, 3000);
      } else if (op === 0) {
        if (t === 'READY') {
          this.botUser = d.user;
          this.appId = d.application?.id;
          const modeNote = this.useContentIntent ? '支持斜杠命令与 !命令' : '仅斜杠命令与 @提及（未开 Message Content 权限）';
          this.status = `机器人在线：@${d.user?.username || 'Bot'}（${modeNote}）`;
          this.hooks.onEvent?.(`Discord 机器人已上线：@${d.user?.username || 'Bot'}`);
          for (const guild of d.guilds || []) {
            this.registerGuildCommands(guild.id);
          }
        } else if (t === 'GUILD_CREATE' && d?.id) {
          this.registerGuildCommands(d.id);
        } else if (t === 'INTERACTION_CREATE' && d?.type === 2) {
          this.handleInteraction(d).catch(() => {});
        } else if (t === 'MESSAGE_CREATE' && d) {
          this.handleMessage(d).catch(() => {});
        }
      }
    });

    ws.on('close', code => {
      if (g !== this.generation) return;
      clearInterval(this.heartbeat);
      if (code === 4004) {
        this.status = 'Discord Bot Token 无效，请检查后重新保存';
        this.hooks.onEvent?.(this.status, 'error');
        return;
      }
      if (code === 4014 && this.useContentIntent) {
        this.useContentIntent = false;
        this.startBot();
        return;
      }
      this.status = 'Discord 连接中断，15 秒后重连';
      this.scheduleReconnect(g, 15000);
    });

    ws.on('error', () => {
      if (g === this.generation) this.status = '无法连接 Discord（请检查网络/代理）';
    });
  }

  scheduleReconnect(g, delay) {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (g === this.generation && this.config.enabled && this.config.botToken) {
        this.startBot();
      }
    }, delay);
  }

  async handleInteraction(interaction) {
    const name = interaction.data?.name;
    const opts = interaction.data?.options || [];
    const arg = opts[0]?.value ? String(opts[0].value).trim() : '';
    const sender = interaction.member?.user?.global_name || interaction.member?.user?.username || interaction.user?.username || 'Discord';
    const actualArg = name === 'say' && arg ? `[DC:${sender}] ${arg}` : arg;
    try {
      const {embed} = await this.buildCommandEmbed(name, actualArg);
      await fetch(`${this.apiBase}/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          type: 4,
          data: {
            embeds: [{
              color: embed.color || 0xb1e784,
              title: embed.title,
              description: embed.description,
              timestamp: new Date().toISOString(),
              ...(embed.footer ? {footer: {text: embed.footer}} : {})
            }]
          }
        })
      });
      if (name === 'map') {
        const s = this.hooks.getState();
        if (s.mapImage && interaction.channel_id) {
          await this.sendEmbed(embed, interaction.channel_id, s.mapImage);
        }
      }
    } catch (e) {
      await fetch(`${this.apiBase}/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({type: 4, data: {content: '操作失败：' + e.message}})
      }).catch(() => {});
    }
  }

  async handleMessage(msg) {
    if (!msg || msg.author?.bot) return;
    const channelId = String(msg.channel_id || '');
    const mentioned = this.botUser && new RegExp(`^<@!?${this.botUser.id}>`).test(String(msg.content || '').trim());
    if (this.config.channelId && channelId !== this.config.channelId && !mentioned) return;

    let text = String(msg.content || '').trim();
    if (this.botUser) {
      text = text.replace(new RegExp(`^<@!?${this.botUser.id}>\\s*`), '').trim();
    }
    if (!text) return;

    if (text.startsWith('!') || text.startsWith('！')) {
      const normalized = text.replace(/^！/, '!');
      const [rawCmd, ...rest] = normalized.slice(1).split(/\s+/);
      const cmd = rawCmd.toLowerCase();
      const arg = rest.join(' ').trim();
      const known = ['time', '时间', 'pop', '人数', 'pos', '位置', 'team', 'deaths', '死亡', 'map', '地图', 'say', '发送', 'leader', '队长', 'help', '帮助'];
      if (!known.includes(cmd)) return;
      const sender = msg.author?.global_name || msg.author?.username || 'DC';
      const actualArg = ['say', '发送'].includes(cmd) && arg ? `[DC:${sender}] ${arg}` : arg;
      const {embed, imageBuffer} = await this.buildCommandEmbed(cmd, actualArg);
      await this.sendEmbed(embed, channelId, imageBuffer);
      return;
    }

    if (this.config.chatBridge && this.config.channelId && channelId === this.config.channelId) {
      const sender = msg.author?.global_name || msg.author?.username || 'DC';
      const line = `[DC:${sender}] ${text}`.slice(0, 128);
      await this.hooks.sendToGame(line);
    }
  }
}

module.exports = {DiscordBridge};
