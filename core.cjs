const clock = time => {
  if (!Number.isFinite(time)) return '未知';
  const minutes = ((Math.floor(time * 60) % 1440) + 1440) % 1440;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};

function realDuration(totalSeconds, lang = 'zh-CN') {
  const sec = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(sec / 60), s = sec % 60;
  if (lang === 'en') return m > 0 ? (s > 0 ? `${m}m ${s}s IRL` : `${m}m IRL`) : `${s}s IRL`;
  if (lang === 'zh-TW') return m > 0 ? (s > 0 ? `現實 ${m}分${s}秒` : `現實 ${m}分鐘`) : `現實 ${s}秒`;
  return m > 0 ? (s > 0 ? `现实 ${m}分${s}秒` : `现实 ${m}分钟`) : `现实 ${s}秒`;
}

function dayNight(t, lang = 'zh-CN') {
  if (!t || !Number.isFinite(t.time)) {
    const waitMsg = lang === 'en' ? 'Waiting for sync' : '等待同步';
    return {phase: lang === 'en' ? 'Unknown' : '未知', nextLabel: '', minutesLeft: null, secondsLeft: null, text: waitMsg};
  }
  const sunrise = Number.isFinite(t.sunrise) && t.sunrise > 0 ? t.sunrise : 7.5;
  const sunset = Number.isFinite(t.sunset) && t.sunset > sunrise ? t.sunset : 19.5;
  const dayLen = Number.isFinite(t.dayLengthMinutes) && t.dayLengthMinutes > 0 ? t.dayLengthMinutes : 60;
  const scale = Number.isFinite(t.timeScale) && t.timeScale > 0 ? t.timeScale : 1;
  const isDay = t.time >= sunrise && t.time < sunset;
  const hoursLeft = isDay ? (sunset - t.time) : (t.time < sunrise ? sunrise - t.time : 24 - t.time + sunrise);
  const secondsLeft = Math.max(0, Math.round((hoursLeft / 24) * (dayLen / scale) * 60));
  const minutesLeft = Math.max(0, Math.round(secondsLeft / 60));
  const dur = realDuration(secondsLeft, lang);
  if (lang === 'en') {
    const phase = isDay ? 'Day' : 'Night';
    const nextLabel = isDay ? 'nightfall' : 'sunrise';
    const waitText = secondsLeft < 10 ? `${nextLabel} soon` : `${dur} to ${nextLabel}`;
    return {phase, nextLabel, minutesLeft, secondsLeft, sunrise: clock(sunrise), sunset: clock(sunset), text: `${phase} · ${waitText}`};
  }
  if (lang === 'zh-TW') {
    const phase = isDay ? '白天' : '夜晚';
    const nextLabel = isDay ? '天黑' : '天亮';
    const waitText = secondsLeft < 10 ? `即將${nextLabel}` : `距${nextLabel}還有${dur}`;
    return {phase, nextLabel, minutesLeft, secondsLeft, sunrise: clock(sunrise), sunset: clock(sunset), text: `${phase} · ${waitText}`};
  }
  const phase = isDay ? '白天' : '夜晚';
  const nextLabel = isDay ? '天黑' : '天亮';
  const waitText = secondsLeft < 10 ? `即将${nextLabel}` : `距${nextLabel}还有${dur}`;
  return {phase, nextLabel, minutesLeft, secondsLeft, sunrise: clock(sunrise), sunset: clock(sunset), text: `${phase} · ${waitText}`};
}

function timeSummary(t, lang = 'zh-CN') {
  const c = clock(t?.time);
  if (c === '未知') return lang === 'en' ? 'In-game time: Unknown' : (lang === 'zh-TW' ? '當前遊戲時間 未知' : '当前游戏时间 未知');
  const dn = dayNight(t, lang);
  if (lang === 'en') return dn.minutesLeft === null ? `In-game time ${c}` : `In-game time ${c} (${dn.text.replace(' · ', ', ')})`;
  if (lang === 'zh-TW') return dn.minutesLeft === null ? `當前遊戲時間 ${c}` : `當前遊戲時間 ${c}（${dn.text.replace(' · ', '，')}）`;
  return dn.minutesLeft === null ? `当前游戏时间 ${c}` : `当前游戏时间 ${c}（${dn.text.replace(' · ', '，')}）`;
}

function grid(x, y, mapSize) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(mapSize) || mapSize <= 0) return '';
  const cell = 146.28571428571428;
  const maxIdx = Math.max(0, Math.floor(mapSize / cell) - 1);
  const col = Math.min(maxIdx, Math.max(0, Math.floor(x / cell)));
  const row = Math.min(maxIdx, Math.max(0, Math.floor((mapSize - y) / cell)));
  const letters = col < 26
    ? String.fromCharCode(65 + col)
    : String.fromCharCode(64 + Math.floor(col / 26)) + String.fromCharCode(65 + (col % 26));
  return `${letters}${row}`;
}

function deaths(previous, members) {
  return members.filter(m => {
    const p = previous.get(String(m.steamId));
    return p && ((p.isAlive === true && m.isAlive === false) || (m.deathTime > 0 && m.deathTime > p.deathTime));
  });
}

function presenceChanges(previous, members) {
  if (!previous || previous.size === 0) return [];
  const changes = [];
  for (const m of members) {
    const p = previous.get(String(m.steamId));
    if (p && Boolean(p.isOnline) !== Boolean(m.isOnline)) {
      changes.push({member: m, isOnline: Boolean(m.isOnline)});
    }
  }
  return changes;
}

const MONUMENTS = {
  ferryterminal: ['渡轮码头', '渡輪碼頭', 'Ferry Terminal'],
  harbor_display_name: ['港口', '港口', 'Harbor'],
  harbor_2_display_name: ['小港口', '小港口', 'Small Harbor'],
  large_fishing_village_display_name: ['大渔村', '大漁村', 'Large Fishing Village'],
  fishing_village_display_name: ['渔村', '漁村', 'Fishing Village'],
  AbandonedMilitaryBase: ['废弃军事基地', '廢棄軍事基地', 'Abandoned Military Base'],
  abandoned_military_base: ['废弃军事基地', '廢棄軍事基地', 'Abandoned Military Base'],
  arctic_base_a: ['北极基地', '北極基地', 'Arctic Base'],
  arctic_research_base_a: ['北极科研基地', '北極科研基地', 'Arctic Research Base'],
  excavator: ['巨型挖掘机', '巨型挖掘機', 'Giant Excavator'],
  water_treatment_plant_display_name: ['污水处理厂', '污水處理廠', 'Water Treatment'],
  dome_monument_name: ['大铁球', '大鐵球', 'The Dome'],
  satellite_dish_display_name: ['雷达残骸', '雷達殘骸', 'Satellite Dish'],
  outpost: ['前哨站', '前哨站', 'Outpost'],
  bandit_camp: ['强盗营地', '強盜營地', 'Bandit Camp'],
  bandit_town: ['强盗营地', '強盜營地', 'Bandit Camp'],
  launchsite: ['火箭发射场', '火箭發射場', 'Launch Site'],
  launch_site_1: ['火箭发射场', '火箭發射場', 'Launch Site'],
  junkyard_display_name: ['垃圾场', '垃圾場', 'Junkyard'],
  stables_a: ['马场', '馬場', 'Ranch'],
  stables_b: ['马场', '馬場', 'Large Barn'],
  airfield_display_name: ['机场', '機場', 'Airfield'],
  missile_silo_monument: ['导弹发射井', '導彈發射井', 'Missile Silo'],
  train_yard_display_name: ['火车站', '火車站', 'Train Yard'],
  military_tunnels_display_name: ['军事隧道', '軍事隧道', 'Military Tunnels'],
  power_plant_display_name: ['发电厂', '發電廠', 'Power Plant'],
  mining_quarry_stone_display_name: ['采石场', '採石場', 'Stone Quarry'],
  mining_quarry_hqm_display_name: ['高金矿场', '高金礦場', 'HQM Quarry'],
  mining_quarry_sulfur_display_name: ['硫磺矿场', '硫磺礦場', 'Sulfur Quarry'],
  sewer_display_name: ['下水道', '下水道', 'Sewer Branch'],
  sewer_branch_display_name: ['下水道', '下水道', 'Sewer Branch'],
  jungle_ziggurat: ['丛林神庙', '叢林神廟', 'Jungle Ziggurat'],
  supermarket: ['废弃超市', '廢棄超市', 'Supermarket'],
  radtown: ['辐射镇', '輻射鎮', 'Radtown'],
  gas_station: ['加油站', '加油站', "Oxum's Gas Station"],
  mining_outpost_display_name: ['仓库', '倉庫', 'Mining Outpost'],
  underwater_lab: ['水下实验室', '水下實驗室', 'Underwater Lab'],
  oil_rig_small: ['小石油钻井', '小石油鑽井', 'Small Oil Rig'],
  large_oil_rig: ['大石油钻井', '大石油鑽井', 'Large Oil Rig'],
  lighthouse_display_name: ['灯塔', '燈塔', 'Lighthouse'],
  swamp_a: ['沼泽', '沼澤', 'Swamp'],
  swamp_b: ['沼泽', '沼澤', 'Swamp'],
  swamp_c: ['沼泽', '沼澤', 'Swamp'],
};

function monumentLabels(token) {
  if (!token) return null;
  if (MONUMENTS[token]) {
    const [cn, tw, en] = MONUMENTS[token];
    return {'zh-CN': cn, 'zh-TW': tw, en};
  }
  if (/train_tunnel|DungeonBase|^Monument$|apartmentcomplex/i.test(token)) return null;
  const fallback = token.replace(/_display_name$|_monument_name$|_monument$/i, '').replace(/_/g, ' ');
  return {'zh-CN': fallback, 'zh-TW': fallback, en: fallback};
}

function monumentName(token, lang = 'zh-CN') {
  const labels = monumentLabels(token);
  if (!labels) return null;
  return labels[lang] || labels['zh-CN'];
}

function validate(input, old) {
  const c = {...old};
  for (const k of ['host', 'playerId', 'name']) if (k in input) c[k] = String(input[k]).trim();
  if (input.playerToken !== undefined && input.playerToken !== '') c.playerToken = String(input.playerToken).trim();
  if ('port' in input) c.port = Number(input.port);
  if (!c.host || !/^[a-zA-Z0-9.:-]+$/.test(c.host)) throw Error('请填写有效的服务器 IP 或域名');
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) throw Error('Rust+ 端口须为 1–65535');
  if (!/^\d{17}$/.test(c.playerId)) throw Error('SteamID64 应为 17 位数字');
  if (!/^-?\d+$/.test(c.playerToken || '') || Number(c.playerToken) < -2147483648 || Number(c.playerToken) > 2147483647) throw Error('请填写有效的配对令牌');
  return c;
}

module.exports = {clock, realDuration, dayNight, timeSummary, grid, deaths, presenceChanges, monumentName, monumentLabels, validate};
