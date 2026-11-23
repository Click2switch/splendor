/* ==================================================================
   璀璨宝石 · 宝可梦  —  客户端
   ================================================================== */

/*
 * 运行配置（可选）。
 *
 * 页面和图片可以放在别的地方（比如国内能直连的 CDN），只有对局服务还在原地址。
 * 那种情况下，在页面里先加载一份 runtime-config.js：
 *
 *   window.__SPLENDOR_CFG = { apiBase: 'https://对局服务器地址', assetBase: 'https://图片前缀' };
 *
 * 两个都留空就是现在这样：一切同源。exe 版和线上主站都不需要这个文件。
 */
const CFG = window.__SPLENDOR_CFG || {};
const API_BASE = String(CFG.apiBase || '').replace(/\/+$/, '');
const ASSET_BASE = String(CFG.assetBase || '').replace(/\/+$/, '');

/** 给静态资源路径加前缀；没配就原样返回 */
function asset(p) {
  const s = String(p || '');
  if (!ASSET_BASE || !s.startsWith('/')) return s;
  return ASSET_BASE + s;
}

/** 对局服务的 HTTP 接口（静态站被搬到别处时要用） */
function api(p) {
  return API_BASE ? API_BASE + p : p;
}

const SESSION_KEY = 'splendor_pkmn_session';
const NAME_KEY = 'splendor_pkmn_name';
const TRAINER_KEY = 'splendor_pkmn_trainer';

const GEM = ['red', 'blue', 'black', 'pink', 'yellow'];

const BALLS = {
  red: { name: '精灵球', img: asset('/assets/balls/red.png') },
  blue: { name: '超级球', img: asset('/assets/balls/blue.png') },
  black: { name: '高级球', img: asset('/assets/balls/black.png') },
  pink: { name: '治愈球', img: asset('/assets/balls/pink.png') },
  yellow: { name: '先机球', img: asset('/assets/balls/yellow.png') },
  purple: { name: '大师球', img: asset('/assets/balls/purple.png') },
};
const ALL_BALLS = [...GEM, 'purple'];

const TRAINERS = [
  { id: 'ash', name: '小智', img: asset('/assets/avatars/ash.png') },
  { id: 'misty', name: '小霞', img: asset('/assets/avatars/misty.png') },
  { id: 'brock', name: '小刚', img: asset('/assets/avatars/brock.png') },
  { id: 'rocket', name: '火箭队', img: asset('/assets/avatars/rocket.png') },
];

/** 人机难度：id 与服务端一致，改这里记得同步 src/bot.js */
const BOT_LEVELS = [
  { id: 'easy', label: '简单', desc: '看到能买就买，很少攒球' },
  { id: 'normal', label: '普通', desc: '会算还差几枚球，懂得凑同色' },
  { id: 'hard', label: '困难', desc: '会规划两三步，抢高分卡' },
];

const botLabel = (id) => BOT_LEVELS.find((l) => l.id === id)?.label || '普通';

const BACKS = {
  1: asset('/assets/backs/stage1.webp'),
  2: asset('/assets/backs/stage2.webp'),
  3: asset('/assets/backs/stage3.webp'),
  rare: asset('/assets/backs/rare.webp'),
  legend: asset('/assets/backs/legend.webp'),
};

/* ------------------------------ 状态 ------------------------------ */

let ws = null;
let state = null;
let selectedColors = [];
let currentModal = null;
let lastActionSig = '';
/** 收到过多少次服务端快照：切回来时用它判断「眼前这份是真的新状态，还是断线前那张旧图」 */
let stateSeq = 0;

let manualClose = false;
let connected = false;
let reconnectAttempt = 0;
let reconnectTimer = null;
let watchdogTimer = null;
let connectStartedAt = 0;
let lastSeenAt = 0;
let lastPingAt = 0;
let pendingAction = false;
let pendingIntent = null;
let actionSeq = 0;
const clientId = Math.random().toString(36).slice(2, 9);

let pickedTrainer = 'ash';
let discardDraft = {};

/** 房主的公网分享链接（由服务端推送；隧道没打通之前是 null） */
let shareLink = null;

/* ---------------------------- WebSocket ---------------------------- */

function connect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (manualClose) return;

  if (ws) {
    if (ws.readyState === WebSocket.OPEN) return;
    if (ws.readyState === WebSocket.CONNECTING && Date.now() - connectStartedAt < 8000) return;
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }

  let sock;
  try {
    /*
     * 页面和图片可能在别的域名（国内能直连的 CDN），对局服务留在原地址。
     * 这时 WS 要连 API_BASE，并且把页面 URL 上的邀请码一并带过去。
     */
    if (API_BASE) {
      const u = new URL(API_BASE);
      const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
      sock = new WebSocket(`${proto}//${u.host}/${location.search}`);
    } else {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      // 保留查询参数（线上分享链接需要 sharecode 才能完成 WS 握手）
      sock = new WebSocket(`${proto}//${location.host}/${location.search}`);
    }
  } catch {
    scheduleReconnect();
    return;
  }
  ws = sock;
  connectStartedAt = Date.now();

  sock.addEventListener('open', () => {
    if (ws !== sock) return;
    connected = true;
    reconnectAttempt = 0;
    lastSeenAt = Date.now();
    renderNet();

    const session = loadSession();
    if (pendingIntent) {
      // 页面刚打开、握手还没走完就点了「创建/加入」：连上后补发，别让这次点击白点
      const intent = pendingIntent;
      pendingIntent = null;
      send(intent);
    } else if (session && session.code && session.playerId) {
      // 带上名字：席位因为离开太久被摘掉时，服务端能在大厅里给你补回一个座
      send({
        type: 'rejoin',
        code: session.code,
        playerId: session.playerId,
        name: session.name,
      });
    }
  });

  sock.addEventListener('message', (ev) => {
    lastSeenAt = Date.now();
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleMessage(msg);
  });

  sock.addEventListener('close', () => {
    if (ws !== sock) return;
    connected = false;
    ws = null;
    if (manualClose) return;
    renderNet();
    scheduleReconnect();
  });

  sock.addEventListener('error', () => { /* close 会接手处理 */ });
}

/** 退避重连：0.6s → 1.2s → 2.4s（封顶 3s）+ 随机抖动 */
function scheduleReconnect() {
  if (manualClose) return;
  if (reconnectTimer) return;
  reconnectAttempt += 1;
  const base = Math.min(600 * 2 ** (reconnectAttempt - 1), 3000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, base + Math.random() * 300);
  renderNet();
}

/**
 * 看门狗：无论处于哪种状态都保证最终能重连
 * - 没有连接 → 安排重连
 * - 卡在 CONNECTING → 8 秒后丢弃重来
 * - 已连接但太久没有任何回包 → 先探一次，探不通就换一条
 *
 * 时钟来自 Worker（见 bg-tick.js）：主线程的定时器在后台会被压到一分钟一次，
 * 用它当心跳时钟会在切走时把「我还醒着」误判成「连接死了」。
 */
let staleProbedAt = 0;

function watchdogStep() {
  if (manualClose) return;
  const now = Date.now();

  if (!ws) {
    if (!reconnectTimer) scheduleReconnect();
    return;
  }
  if (ws.readyState === WebSocket.CONNECTING) {
    if (now - connectStartedAt > 8000) {
      try { ws.close(); } catch { /* ignore */ }
      ws = null;
      connect();
    }
    return;
  }
  if (ws.readyState !== WebSocket.OPEN) return;

  /*
   * 45 秒没收到任何东西：先发一个 sync 探一下（服务端回一份快照，比 ping 更有用），
   * 12 秒后还是没动静才认定这条连接已经烂了，换一条。
   * 后台也照此处理 —— 有了不降频的时钟，就不需要再对后台特殊让步。
   */
  if (now - lastSeenAt > 45000) {
    if (!staleProbedAt || now - staleProbedAt > 12000) {
      staleProbedAt = now;
      send({ type: 'sync' });
      return;
    }
    try { ws.close(); } catch { /* ignore */ }
    return;
  }
  staleProbedAt = 0;

  if (now - lastPingAt > 7000) {
    lastPingAt = now;
    send({ type: 'ping' });
  }
}

/** 心跳时钟：优先 Worker，装不上再退回主线程定时器 */
let tickWorker = null;
let tickCount = 0;

function startWatchdog() {
  clearInterval(watchdogTimer);
  watchdogTimer = null;

  try {
    tickWorker = new Worker('/bg-tick.js');
    tickWorker.onmessage = () => {
      tickCount += 1;
      watchdogStep();
    };
    tickWorker.postMessage({ type: 'start', every: 1000 });
  } catch {
    tickWorker = null;
  }

  // 兜底：Worker 被内容安全策略之类挡住时，至少还有一条 4 秒的主线程心跳
  if (!tickWorker) watchdogTimer = setInterval(watchdogStep, 4000);
}

/*
 * 切回这个标签页时先自检一次。
 *
 * 浏览器会把后台标签页的定时器压到一分钟才跑一次，watchdog 于是完全看不出
 * 链路状态；回到前台立刻探一下：
 *   · 连接还在 —— 只要一份最新状态（sync），比重新入座轻得多，也不会惊动别人
 *   · 连接没了 —— 当场重连，走正常的 hello/rejoin
 * 服务端那边有宽限期，这几十秒里你的席位、房主、牌一样没动。
 */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || manualClose) return;

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    ws = null;
    connect();
    return;
  }

  flushRender();
  send({ type: 'ping' });
  send({ type: 'sync' });
});

/*
 * bfcache：按浏览器「后退」回到这个页面时，DOM 还是离开那一刻的样子，
 * 但 socket 早被浏览器收走了 —— 页面看着在、其实一步不动。
 * pageshow 的 persisted 为真就是这种情况，直接重连。
 */
window.addEventListener('pageshow', (e) => {
  if (!e.persisted || manualClose) return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    send({ type: 'sync' });
    return;
  }
  ws = null;
  connect();
});

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

/** 发送动作：断线拦截 + 幂等 id + 单飞锁 */
function sendAction(action) {
  if (!connected) {
    toast('连接已断开，正在重连…', 'bad');
    connect();
    return false;
  }
  if (pendingAction) return false;
  pendingAction = true;
  const ok = send({ type: 'action', action, cid: `${clientId}-${++actionSeq}` });
  if (!ok) {
    pendingAction = false;
    toast('连接已断开，正在重连…', 'bad');
    return false;
  }
  return true;
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'joined':
      saveSession({ code: msg.code, playerId: msg.playerId, name: msg.name });
      stateSeq += 1;
      state = msg;
      selectedColors = [];
      pendingAction = false;
      lobbyBusyUntil = 0; // 这一手已经有结果了，立刻允许下一次点击
      closeModal();
      requestRender();
      break;

    case 'state': {
      const prev = state;
      stateSeq += 1;
      state = msg;
      pendingAction = false;
      const sig = `${msg.game?.turn}-${msg.game?.round}-${msg.game?.phase}`;
      if (sig !== lastActionSig) {
        lastActionSig = sig;
        if (msg.game && msg.game.phase === 'playing') selectedColors = [];
      }
      if (msg.game) selectedColors = selectedColors.filter((c) => (msg.game.bank[c] || 0) > 0);
      requestRender();
      break;
    }

    case 'left':
      clearSession();
      state = null;
      selectedColors = [];
      lobbyBusyUntil = 0; // 刚退出，马上再建一间是正常操作
      requestRender();
      break;

    case 'pong':
      break;

    // 公网隧道刚打通（页面比隧道先打开），房主的等待区要立刻显示出来
    case 'publicUrl':
      shareLink = msg.shareLink || null;
      if (state?.isHost) renderWait();
      break;

    case 'error':
      pendingAction = false;
      lobbyBusyUntil = 0;
      if (msg.code === 'kicked') {
        // 房主收回了权限：断开重连，回到邀请码页
        clearSession();
        state = null;
        manualClose = true;
        try { ws?.close(); } catch { /* ignore */ }
        render();
        toast(msg.message || '你已不能进入这个牌局', 'bad');
        setTimeout(() => location.reload(), 1600);
        break;
      }
      if (msg.code === 'nosession') {
        // 服务端这边席位/房间已经没了：本地也清干净回大厅。
        // 连接上残留的旧 roomCode 由服务端在 create/join 时自动摘掉，不用这里补 leave
        clearSession();
        state = null;
        selectedColors = [];
        render();
      }
      toast(msg.message || '操作失败', 'bad');
      break;
  }
}

/* ------------------------------ 会话 ------------------------------ */

function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
}
function saveSession(s) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}

/* ------------------------------ 工具 ------------------------------ */

/*
 * 弱网下卡图经常整批「加载失败」：连接被掐断，浏览器只画个破图就完事，
 * 不会自己重试 —— 看起来就是图片永远出不来，其实换一次请求就好了。
 * 这里给每张图两次重试机会，间隔递增；带上 ?r= 是为了绕开那次坏掉的缓存。
 */
document.addEventListener(
  'error',
  (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    if (img.dataset.noRetry === '1') return;
    const n = Number(img.dataset.retry || 0);
    if (n >= 2) return;
    img.dataset.retry = String(n + 1);
    const base = (img.getAttribute('src') || '').split('?')[0];
    if (!base) return;
    setTimeout(() => {
      img.src = `${base}?r=${Date.now()}`;
    }, 700 * (n + 1));
  },
  true
);

/*
 * 被挂住的请求永远不会触发 error —— 弱网下就是这样：图一直转圈，页面不报错，
 * 整屏就这么干等着。这里每 5 秒扫一遍「在视口里、却超过 15 秒还没加载完」的图，
 * 换一个 cache-buster 重发一次。
 *
 * 门槛必须比「慢」更慢：50KB/s 的链路上，一张 12KB 的图要跑 3 秒以上，
 * 阈值太短会把还在正常下载的请求掐掉重来，越重试越慢。所以只给一次机会。
 */
const stallSince = new WeakMap();
setInterval(() => {
  if (document.hidden) return;
  const now = Date.now();
  for (const img of document.images) {
    const src = img.getAttribute('src') || '';
    if (!src.includes('/assets/')) continue;
    if (img.complete) {
      stallSince.delete(img);
      continue;
    }
    if (Number(img.dataset.retry || 0) >= 1) continue;
    if (navigator.onLine === false) continue;
    const r = img.getBoundingClientRect();
    const inView = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    if (!inView) continue;

    const since = stallSince.get(img);
    if (!since) {
      stallSince.set(img, now);
      continue;
    }
    if (now - since < 15000) continue;
    stallSince.delete(img);
    img.dataset.retry = String(Number(img.dataset.retry || 0) + 1);
    img.src = `${src.split('?')[0]}?r=${now}`;
  }
}, 5000);

const $ = (id) => document.getElementById(id);

/*
 * 内容没变就别动 DOM。
 *
 * 每一次状态推送都整块 innerHTML 重写一遍，会有三个后果：图片重新解码闪一下、
 * 里面的 CSS 动画从头播、滚动位置被重置。对局里大半的推送只改一个数字，
 * 肉眼看不出差别，却让整块面板重来一遍 —— 切标签页回来那一下的「闪」就是这么来的。
 */
function setHTML(el, html) {
  if (!el) return false;
  if (el.__html === html) return false;
  el.__html = html;
  el.innerHTML = html;
  return true;
}

function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer = null;
function toast(text, kind = '') {
  const el = $('toast');
  el.textContent = text;
  el.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2400);
}

function renderNet() {
  const pill = $('net-pill');
  if (!state) { pill.classList.add('hidden'); return; }
  if (connected) {
    pill.classList.add('hidden');
  } else {
    pill.textContent = reconnectAttempt > 2 ? '网络不稳定，正在重连…' : '正在连接…';
    pill.classList.remove('hidden');
  }
}

const me = () => state?.game?.players?.find((p) => p.id === state.you) || null;
const myTurn = () => {
  const g = state?.game;
  return !!g && g.players[g.turn] && g.players[g.turn].id === state.you;
};
const canAct = () => !!state?.game && state.game.phase === 'playing' && myTurn() && connected && !pendingAction;

function trainerOf(id) {
  return TRAINERS.find((t) => t.id === id) || TRAINERS[0];
}

function ballStyle(c) {
  return `background-image:url('${BALLS[c].img}')`;
}

/* ------------------------------ 渲染入口 ------------------------------ */

/*
 * 一帧只画一次。
 *
 * 后台标签页里 requestAnimationFrame 是停的，于是「状态到了就画」这件事
 * 自然变成「等我回来再画一次」——切走十分钟攒下的几十次推送，回来只画最后一眼，
 * 既没有中间态闪动，也不白耗 CPU。用户操作仍然走同步的 render()，点一下立刻有反馈。
 */
let renderDirty = false;
let renderCount = 0;

function requestRender() {
  // 后台：只记一笔，等回到前台画一次（后台画面看不见，画了也白耗电）
  if (document.hidden) {
    renderDirty = true;
    return;
  }
  renderDirty = false;
  render();
}

function flushRender() {
  if (!renderDirty) return;
  renderDirty = false;
  render();
}

function render() {
  renderCount += 1;
  const inRoom = !!state;
  const lobby = $('screen-lobby');
  const wait = $('screen-wait');
  const game = $('screen-game');

  if (!inRoom) {
    lobby.classList.remove('hidden');
    wait.classList.add('hidden');
    game.classList.add('hidden');
    closeModal();
    renderLobby();
    renderNet();
    return;
  }

  const g = state.game;
  if (!g) {
    lobby.classList.add('hidden');
    wait.classList.remove('hidden');
    game.classList.add('hidden');
    closeTransientModal();
    renderWait();
    renderNet();
    refreshMembers();
    refreshBots();
    refreshRules();
    return;
  }

  lobby.classList.add('hidden');
  wait.classList.add('hidden');
  game.classList.remove('hidden');
  renderGame();
  renderNet();
  refreshMembers();
  refreshBots();
  refreshRules();
  syncModals();
}

/* ------------------------------ 大厅 ------------------------------ */

function renderLobby() {
  const pick = $('trainer-pick');
  pick.innerHTML = TRAINERS.map(
    (t) => `<button class="trainer-opt ${t.id === pickedTrainer ? 'sel' : ''}" data-trainer="${t.id}">
      <img src="${t.img}" alt="${t.name}" draggable="false">
      <span>${t.name}</span>
    </button>`
  ).join('');

  const nameInput = $('in-name');
  if (!nameInput.value) {
    try { nameInput.value = localStorage.getItem(NAME_KEY) || ''; } catch { /* ignore */ }
  }
  const code = new URL(location.href).searchParams.get('room');
  if (code && !$('in-code').value) $('in-code').value = code.toUpperCase();
}

function currentName() {
  const v = $('in-name').value.trim().slice(0, 12);
  if (v) {
    try { localStorage.setItem(NAME_KEY, v); } catch { /* ignore */ }
  }
  return v || '训练家';
}

/* ------------------------------ 等待区 ------------------------------ */

function renderWait() {
  $('wait-code').textContent = state.code || '·····';
  const host = state.hostId;
  const rows = state.players
    .map((p) => {
      const t = trainerOf(p.trainer);
      const isBot = !!p.isBot;
      return `<div class="wp-row ${isBot ? 'bot' : ''}">
        <img src="${t.img}" alt="" draggable="false">
        <span class="wp-name">${escapeHTML(p.name)}</span>
        ${p.id === host ? '<span class="wp-tag">房主</span>' : ''}
        ${isBot ? `<span class="wp-tag bot">人机 · ${escapeHTML(p.botLabel || botLabel(p.botLevel))}</span>` : ''}
        ${p.connected === false && !isBot ? '<span class="wp-tag off">离线</span>' : ''}
        ${
          isBot && state.isHost
            ? `<button class="wp-del" data-bot-remove="${p.id}" title="移除这个人机">×</button>`
            : ''
        }
      </div>`;
    })
    .join('');

  const emptyRows = Array.from({ length: Math.max(0, 4 - state.players.length) })
    .map(() => '<div class="wp-row wp-empty">等待训练家加入…</div>')
    .join('');

  setHTML($('wait-players'), rows + emptyRows);

  // 公网链接：直接摆在等待区，房主一眼能看到、点一下就复制
  const linkBox = $('wait-link');
  const link = state.isHost ? inviteUrl() : null;
  if (link) {
    linkBox.classList.remove('hidden');
    linkBox.innerHTML = `<span class="wl-label">发给朋友：</span><code>${escapeHTML(link)}</code>`;
    linkBox.title = '点击复制';
  } else if (state.isHost) {
    linkBox.classList.remove('hidden');
    linkBox.innerHTML = '<span class="wl-label">正在打通公网通道…</span>';
  } else {
    linkBox.classList.add('hidden');
    linkBox.innerHTML = '';
  }

  const full = state.players.length >= 4;
  const botBar = $('wait-botbar');
  if (botBar) botBar.classList.toggle('hidden', !state.isHost || full);

  $('btn-start').classList.toggle('hidden', !state.isHost);
  $('btn-start').disabled = state.players.length < 2;
  $('btn-members').classList.toggle('hidden', !state.isHost);
  $('btn-rules').classList.toggle('hidden', !state.isHost);

  // 规则摘要：房主改完立刻能看到，其他人也看得见这局怎么打
  const rulesEl = $('wait-rules');
  if (rulesEl) {
    rulesEl.textContent = rulesSummary(state.rules);
    rulesEl.classList.toggle('dim', !state.isHost);
    rulesEl.title = state.isHost ? '点击「规则设置」可以改' : '房主设定的规则';
  }

  const bots = state.players.filter((p) => p.isBot).length;
  const humans = state.players.length - bots;
  const hint = $('wait-hint');
  if (state.players.length < 2) hint.textContent = '至少需要 2 位玩家才能开始 —— 也可以先加一个人机陪练';
  else if (!state.isHost) hint.textContent = '等房主开始游戏…';
  else if (bots) hint.textContent = `当前 ${state.players.length} 人（真人 ${humans} + 人机 ${bots}），可以开始了`;
  else hint.textContent = `当前 ${state.players.length} 人，可以开始了`;
}

/* ------------------------------ 对局 ------------------------------ */

function renderGame() {
  const g = state.game;
  $('tb-code').textContent = state.code || '·····';
  $('tb-round').textContent = g.round;
  $('tb-target').textContent = g.target;
  // 鼠标停在目标分上就能看到这一局全部规则
  $('tb-target').parentElement.title = rulesSummary(g.rules);

  // 顶栏提示
  const turnEl = $('tb-turn');
  if (g.phase === 'ended') {
    turnEl.textContent = '对局结束';
  } else if (state.game.players[g.turn]?.id === state.you) {
    const extra =
      g.phase === 'discard' ? '请返还超出的精灵球' : g.phase === 'evolve' ? '可以进化宝可梦' : '';
    turnEl.innerHTML = `<span class="my-turn">${extra || '轮到你了'} · 第 ${g.round} 轮</span>`;
  } else {
    const cur = g.players[g.turn];
    turnEl.textContent = cur?.isBot
      ? `${cur.name} 正在思考 · 第 ${g.round} 轮`
      : `等待 ${cur?.name || ''} 行动 · 第 ${g.round} 轮`;
  }

  $('btn-restart').classList.toggle('hidden', !(state.isHost && g.phase === 'ended'));
  $('btn-members2').classList.toggle('hidden', !state.isHost);

  // 开局了：后台补图立刻让路，别和牌桌抢这条烂链路
  if (prefetchSent && !prefetchStopped) {
    prefetchStopped = true;
    stopPrefetch();
  }

  renderMarket();
  renderSpecial();
  renderBank();
  renderPlayers();
  renderLog();
  renderTray();
  fitLayout();
}

/*
 * 牌面按用途取图：桌面上最宽 146 CSS px（2 倍屏 292），用 300 宽的缩略图就够了，
 * 体积只有原图的 1/2.6；只有购买弹层里那块大牌面才去拿 560 宽的原图。
 * 国内链路一卡就是几十秒，少传一倍字节比什么都实在。
 */
function thumbOf(src) {
  const raw = String(src || '').replace(ASSET_BASE, '');
  return asset(raw.replace('/assets/cards/', '/assets/cards/thumb/'));
}

function cardHTML(card, opts = {}) {
  if (!card) return '<div class="card empty"></div>';
  const hot = state.game.affordable?.[card.uid] && myTurn() && state.game.phase === 'playing';
  const cls = ['card', hot ? 'hot' : '', opts.cls || '', opts.clickable === false ? '' : 'clickable']
    .filter(Boolean)
    .join(' ');
  const attrs = opts.clickable === false
    ? ''
    : `data-uid="${card.uid}" data-ui-kind="${opts.kind || 'market'}" data-tier="${opts.tier ?? ''}" data-slot="${
        opts.slot ?? ''
      }" data-index="${opts.index ?? ''}"`;
  return `<div class="${cls}" ${attrs}>
    <img class="face" src="${opts.full ? asset(card.img) : thumbOf(card.img)}" alt="${escapeHTML(card.name)}" draggable="false" decoding="async"${
    opts.full ? '' : ' loading="lazy"'
  }>
  </div>`;
}

function renderMarket() {
  const g = state.game;
  const order = ['3', '2', '1'];

  setHTML($('market'), order
    .map((tier) => {
      const cards = g.market[tier] || [];
      const remain = g.decks[tier] ?? 0;
      const slots = cards
        .map((c, i) => (c ? cardHTML(c, { kind: 'market', tier, slot: i }) : '<div class="card empty"></div>'))
        .join('');

      return `<div class="tier">
        <div class="tier-deck ${remain === 0 ? 'disabled' : ''} has-art" data-deck="${tier}"
             style="--deck-art:url('${BACKS[tier]}')" title="盲抽一张 ${tier} 阶卡保留">
          <span class="tier-lv">${'ⅠⅡⅢ'[Number(tier) - 1]}</span>
          <span class="tier-count">剩 ${remain}</span>
        </div>
        ${slots}
      </div>`;
    })
    .join(''));
}

function renderSpecial() {
  const g = state.game;
  const rail = document.querySelector('.rail-special');
  // 规则里关掉稀有 / 传说时，整条边栏都不占地方，市场能宽出来一张卡
  const enabled = g.rules?.rareCards !== false;
  if (rail) rail.classList.toggle('hidden', !enabled);
  if (!enabled) {
    $('special').innerHTML = '';
    return;
  }

  const zones = [
    { key: 'rare', label: '稀有', cls: 'rare' },
    { key: 'legend', label: '传说', cls: 'legend' },
  ];

  setHTML($('special'), zones
    .map((z) => {
      const card = (g.market[z.key] || [])[0];
      const remain = g.decks[z.key] ?? 0;
      return `<div class="special-slot">
        <div class="special-label"><span class="${z.cls}">${z.label}</span><span>剩 ${remain}</span></div>
        ${card ? cardHTML(card, { kind: 'market', tier: z.key, slot: 0 }) : '<div class="card empty"></div>'}
      </div>`;
    })
    .join(''));
}

function renderBank() {
  const g = state.game;
  const active = canAct();
  const maxTake = Math.min(3, GEM.filter((c) => (g.bank[c] || 0) > 0).length);

  setHTML($('bank'), ALL_BALLS.map((c) => {
    const count = g.bank[c] || 0;
    const isMaster = c === 'purple';
    const sel = selectedColors.includes(c);
    const pickable = active && !isMaster && count > 0;
    const dim = count <= 0 || (!pickable && !sel);
    return `<div class="ball ${sel ? 'sel' : ''} ${dim ? 'dim' : ''} ${pickable ? 'pickable' : ''} ${
      isMaster ? 'master' : ''
    }" data-ball="${c}" style="${ballStyle(c)}" title="${BALLS[c].name} · 剩余 ${count}">
      <span class="ball-count">${count}</span>
    </div>`;
  }).join(''));

  return maxTake;
}

function renderPlayers() {
  const g = state.game;

  /* 四方座位：自己永远在南边，其余按座次顺时针排到东、北、西。
     2 人时对面坐北；3 人时坐东西两边，桌面左右对称。 */
  const layout = g.players.length >= 4
    ? ['south', 'east', 'north', 'west']
    : g.players.length === 3
    ? ['south', 'east', 'west']
    : ['south', 'north'];

  const myIdx = Math.max(0, g.players.findIndex((p) => p.id === state.you));
  const rotated = [...g.players.slice(myIdx), ...g.players.slice(0, myIdx)];
  const bySeat = {};
  layout.forEach((seat, i) => {
    if (rotated[i]) bySeat[seat] = rotated[i];
  });

  // 2 人局没有左右两家：让牌桌占满整幅宽度，别在两边留两条空栏
  $('board')?.classList.toggle('no-side', !layout.includes('east'));

  for (const seat of ['north', 'south', 'east', 'west']) {
    const el = $(`seat-${seat}`);
    if (!el) continue;
    const p = bySeat[seat];
    if (!p) {
      el.classList.add('hidden');
      el.__html = '';
      el.innerHTML = '';
      continue;
    }
    el.classList.remove('hidden');
    const meta = state.players.find((x) => x.id === p.id);
    setHTML(el, playerCardHTML(p, meta, seat));
  }
}

/** 一张玩家面板。seat 决定排版方向（南北横向 / 东西纵向） */
function playerCardHTML(p, meta, seat) {
  const g = state.game;
  const isMe = p.id === state.you;
  const isActive = g.phase !== 'ended' && g.players[g.turn]?.id === p.id;
  const online = meta ? meta.connected !== false : true;
  const t = trainerOf(p.trainer || meta?.trainer);

  /* 牌库里的加成筹码：球面 + 右下角大号数量徽章，数量一眼可读 */
  const bonusChips = GEM.filter((c) => (p.bonuses[c] || 0) > 0)
    .map(
      (c) =>
        `<span class="bonus-chip" title="${BALLS[c].name}加成 ×${p.bonuses[c]}">
           <i style="${ballStyle(c)}"></i><b>${p.bonuses[c]}</b>
         </span>`
    )
    .join('');

  const tokenChips = ALL_BALLS.filter((c) => (p.tokens[c] || 0) > 0)
    .map((c) => `<span class="tok-chip"><i style="${ballStyle(c)}"></i>${p.tokens[c]}</span>`)
    .join('');

  /* 手牌：一个大号数字 + 缩略卡并排。不加「手牌」二字，数字紧挨着卡，
     看见几张卡、数字是几，自然就读出来了（和实体桌游一样只摆卡）。
     一张都没有时整块不显示，免得面板角落挂个孤零零的 0 */
  const reservedCount = p.reservedCount ?? (p.reserved || []).filter(Boolean).length;
  const reserved = (p.reserved || [])
    .map((c, i) =>
      c
        ? cardHTML(c, { kind: 'reserved', index: i, cls: 'mini' })
        : `<div class="card mini reserved-back clickable" data-ui-kind="reserved-back" data-owner="${p.id}" data-index="${i}">
             <img class="face" src="${BACKS[1]}" alt="" draggable="false">
           </div>`
    )
    .join('');
  const hand = reservedCount
    ? `<span class="pc-hand" title="手牌 ${reservedCount} 张">
         <b class="hand-count">${reservedCount}</b>
         ${reserved ? `<span class="hand-cards">${reserved}</span>` : ''}
       </span>`
    : '';

  /* 牌库里已有的卡：按「阶高→分高」排，最好的排前面。
     四方布局下面板宽了不少，正常一局（十来张）基本能全露出来；
     真的多到放不下时由 CSS 收尾，并折成 +N。 */
  const owned = (p.cards || []).filter(Boolean).sort((a, b) => b.level - a.level || b.vp - a.vp);
  const MAX_DECK = 20;
  const shownCards = owned.slice(0, MAX_DECK);
  const hiddenCards = owned.length - shownCards.length;
  const deck = owned.length
    ? shownCards
        .map(
          (c) => `<div class="deck-card" title="${escapeHTML(c.name)} · ${c.level} 阶${
            c.vp ? ` · ${c.vp} 分` : ''
          }">
          <img src="${thumbOf(c.img)}" alt="${escapeHTML(c.name)}" draggable="false" decoding="async">
        </div>`
        )
        .join('') + (hiddenCards > 0 ? `<span class="deck-more">+${hiddenCards}</span>` : '')
    : '';

  return `<div class="pcard seat-${seat} ${isMe ? 'me' : ''} ${isActive ? 'active' : ''} ${online ? '' : 'offline'}">
    <div class="pc-side">
      <div class="pc-head">
        <img class="pc-avatar" src="${t.img}" alt="" draggable="false">
        <div class="pc-id">
          <span class="pc-name">${escapeHTML(p.name)}${isMe ? ' · 你' : ''}</span>
          <span class="pc-tags">
            ${p.isBot ? `<span class="pc-tag">人机·${escapeHTML(botLabel(p.botLevel))}</span>` : ''}
            ${online ? '' : '<span class="pc-tag off">离线</span>'}
          </span>
        </div>
        <span class="pc-score">${p.score}</span>
      </div>
      <div class="pc-foot">
        <div class="pc-tokens">${tokenChips}</div>
        ${hand}
      </div>
    </div>
    <div class="pc-deck" title="牌库 ${owned.length} 张">
      <div class="pc-bonus" title="牌库里这些卡给的永久加成">${bonusChips}</div>
      <div class="deck-strip">${deck}</div>
    </div>
  </div>`;
}

function renderLog() {
  const logs = state.game.log || [];
  const el = $('log');
  const html = logs.length
    ? logs
        .slice(-14)
        .map((l, i, arr) => {
          const recent = i === arr.length - 1 ? 'recent' : '';
          return `<div class="log-line ${recent}">${l.player ? `<b>${escapeHTML(l.player)}</b> ` : ''}${escapeHTML(l.text)}</div>`;
        })
        .join('')
    : '<div class="log-line">对局刚开始</div>';
  if (setHTML(el, html)) el.scrollTop = el.scrollHeight;
}

/* ------------------------------ 选球托盘 ------------------------------ */

function renderTray() {
  const tray = $('tray');
  const g = state.game;

  if (!canAct() || !selectedColors.length) {
    tray.classList.add('hidden');
    if (tray.__html !== '') {
      tray.__html = '';
      tray.innerHTML = '';
    }
    return;
  }

  const maxTake = Math.min(3, GEM.filter((c) => (g.bank[c] || 0) > 0).length);
  const need = maxTake >= 3 ? 3 : maxTake;
  const single = selectedColors.length === 1 ? selectedColors[0] : null;
  const canTake2 = !!single && (g.bank[single] || 0) >= 4;

  const picked = selectedColors
    .map((c) => `<span class="tray-ball" style="${ballStyle(c)}" title="${BALLS[c].name}"></span>`)
    .join('');

  let hint = maxTake >= 3 ? `已选 ${selectedColors.length} / 3 种` : `最多 ${maxTake} 种`;
  if (selectedColors.length === need) hint = '可以拿取了';

  const rebuilt = setHTML(tray, `
    <div class="tray-picked">${picked}</div>
    <div class="tray-hint">${hint}</div>
    <div class="tray-actions">
      ${canTake2 ? `<button class="btn" id="btn-take2">拿 2 枚${BALLS[single].name}</button>` : ''}
      <button class="btn primary" id="btn-take3" ${selectedColors.length === need ? '' : 'disabled'}>
        拿 ${selectedColors.length} 枚
      </button>
    </div>`);

  tray.classList.remove('hidden');

  // 停在南家面板上方：面板高度会随牌库张数变，算一下别压在自己的面板上
  const south = $('seat-south');
  if (window.innerWidth > 900 && south && !south.classList.contains('hidden')) {
    tray.style.bottom = `${Math.round(south.offsetHeight + 14)}px`;
  } else {
    tray.style.removeProperty('bottom');
  }

  // 只在真的重建了 DOM 时才绑事件：内容没变就跳过，否则每帧都会多挂一个监听
  if (!rebuilt) return;

  $('btn-take2')?.addEventListener('click', () => {
    if (!single || !canAct()) return;
    if (sendAction({ type: 'take2', color: single })) {
      selectedColors = [];
      render();
    }
  });

  $('btn-take3')?.addEventListener('click', () => {
    if (!canAct()) return;
    if (selectedColors.length !== need) return;
    if (sendAction({ type: 'take3', colors: selectedColors.slice() })) {
      selectedColors = [];
      render();
    }
  });
}

/* ------------------------------ 布局适配 ------------------------------ */

function fitLayout() {
  if (window.innerWidth <= 900) {
    document.documentElement.style.removeProperty('--cw');
    return;
  }
  const table = $('table');
  if (!table) return;

  const pad = 24;
  const h = table.clientHeight - pad;
  const w = table.clientWidth - pad;

  // 竖向：3 行卡 + 2 个行间距 + 一点余量
  // （余量不能省：--cw 是四舍五入的整数，边框又不算在 clientHeight 里，
  //   不留余量时 1366×768 这类刚好卡住的分辨率会把最下面一排切掉几像素）
  const rowGap = 10;
  const slack = 12;
  const byH = ((h - rowGap * 2 - slack) / 3) * (3 / 4);

  // 横向：特殊区 1 张 + 牌堆 0.62 + 4 张卡 + 间距
  // （关掉稀有传说时特殊区整条隐藏，宽度要把这一张让出来）
  const specialEl = document.querySelector('.rail-special');
  const specialShown = !!specialEl && !specialEl.classList.contains('hidden');
  const sideEl = document.querySelector('.rail-side');
  const sideW = sideEl ? sideEl.offsetWidth : 236;
  const gaps = 14 * 2 + 9 * 4;
  const byW = (w - sideW - gaps) / ((specialShown ? 1 : 0) + 0.62 + 4);

  const cw = Math.max(92, Math.min(byH, byW, 258));
  const next = Math.round(cw);
  if (next !== lastCw) {
    lastCw = next;
    document.documentElement.style.setProperty('--cw', `${next}px`);
  }
}

let lastCw = 0;
let fitRaf = 0;
function queueFit() {
  if (fitRaf) return;
  fitRaf = requestAnimationFrame(() => {
    fitRaf = 0;
    fitLayout();
  });
}

/* ------------------------------ 交互 ------------------------------ */

document.addEventListener('click', (e) => {
  const ball = e.target.closest('.ball[data-ball]');
  if (ball) {
    const c = ball.dataset.ball;
    if (!canAct()) {
      toast(myTurn() ? '现在不能拿取' : '还没轮到你');
      return;
    }
    if (c === 'purple') { toast('大师球只能通过保留获得'); return; }
    if ((state.game.bank[c] || 0) <= 0) return;

    const maxTake = Math.min(3, GEM.filter((x) => (state.game.bank[x] || 0) > 0).length);
    const i = selectedColors.indexOf(c);
    if (i >= 0) selectedColors.splice(i, 1);
    else {
      if (selectedColors.length >= maxTake) {
        if (maxTake >= 3) toast('最多选 3 种颜色');
        return;
      }
      selectedColors.push(c);
    }
    renderTray();
    renderBank();
    return;
  }

  const deck = e.target.closest('.tier-deck');
  if (deck) {
    if (deck.classList.contains('disabled')) { toast('这个牌堆已经空了'); return; }
    if (!canAct()) { toast(myTurn() ? '现在不能保留' : '还没轮到你'); return; }
    const cap = state.game.rules?.maxReserved || 3;
    if ((me()?.reservedCount || 0) >= cap) { toast(`手牌最多 ${cap} 张`); return; }
    const tier = deck.dataset.deck;
    openConfirm(
      '盲抽保留',
      `从 ${tier} 阶牌堆顶抽一张保留（只有你自己能看到），并获得 1 枚大师球。`,
      '确认保留',
      () => sendAction({ type: 'reserve', source: { kind: 'deck', tier: Number(tier) } })
    );
    return;
  }

  const cardEl = e.target.closest('.card[data-uid]');
  if (cardEl) {
    openCardDetail(cardEl.dataset);
    return;
  }

  const reservedBack = e.target.closest('.reserved-back');
  if (reservedBack && reservedBack.dataset.owner !== state?.you) {
    toast('对手保留的卡看不到');
  }
});

/* ------------------------------ 支付方式 ------------------------------ */

/** 打开详情时这张卡的支付草稿：每个颜色主动用几枚大师球顶替 */
let payCtx = null;

function payPlanFor(card, owner, draft) {
  const bonus = owner?.bonuses || {};
  const tokens = owner?.tokens || {};
  const rows = [];
  let master = card.cost.purple || 0;
  let ok = true;

  for (const c of GEM) {
    const need = Math.max(0, (card.cost[c] || 0) - (bonus[c] || 0));
    if (!need) continue;
    const have = tokens[c] || 0;
    const forced = Math.max(0, need - have); // 本色不够，这几枚只能用大师球
    const use = Math.max(forced, Math.min(need, draft[c] ?? forced));
    const color = need - use;
    if (color > have) ok = false;
    master += use;
    rows.push({ c, need, have, forced, use, color });
  }

  const haveMaster = tokens.purple || 0;
  if (master > haveMaster) ok = false;
  return { rows, master, haveMaster, ok, base: card.cost.purple || 0 };
}

function payRowsHTML(plan) {
  if (!plan.rows.length) {
    return '<div class="pay-row pay-free" title="这张卡不需要精灵球">—</div>';
  }
  const canMore = plan.master < plan.haveMaster;
  return plan.rows
    .map(
      (r) => `<div class="pay-row">
        <span class="pay-cost" title="这张卡要 ${r.need} 个${BALLS[r.c].name}">
          <i class="pay-ball" style="${ballStyle(r.c)}"></i><b>${r.need}</b>
        </span>
        <span class="pay-div"></span>
        <span class="pay-color" title="用本色付 ${r.color} 个">
          <i class="pay-ball" style="${ballStyle(r.c)}"></i><b>${r.color}</b>
        </span>
        <span class="pay-step">
          <button class="pay-btn" data-pay-step="-1" data-c="${r.c}" title="少用一枚大师球" ${
            r.use <= r.forced ? 'disabled' : ''
          }>−</button>
          <span class="pay-master" title="大师球顶替 ${r.use} 个">
            <i class="pay-ball" style="${ballStyle('purple')}"></i><b>${r.use}</b>
          </span>
          <button class="pay-btn" data-pay-step="1" data-c="${r.c}" title="用一枚大师球顶替这个颜色" ${
            r.use >= r.need || !canMore ? 'disabled' : ''
          }>+</button>
        </span>
      </div>`
    )
    .join('');
}

function renderPaySection() {
  if (!payCtx) return;
  const plan = payPlanFor(payCtx.card, me(), payCtx.draft);
  payCtx.plan = plan;

  const area = $('pay-area');
  if (area) {
    area.innerHTML = `${payRowsHTML(plan)}
      <div class="pay-total ${plan.ok ? '' : 'bad'}" title="大师球：用 ${plan.master} 枚 / 手里 ${plan.haveMaster} 枚${
        plan.base ? `（含卡面固定 ${plan.base} 枚）` : ''
      }">
        <i class="pay-ball" style="${ballStyle('purple')}"></i>
        <b class="pay-total-num">${plan.master}</b>
        <span class="pay-total-sep">/</span>
        <span class="pay-have">${plan.haveMaster}</span>
        ${plan.ok ? '' : '<b class="pay-warn">不够</b>'}
      </div>`;
  }

  const btn = $('btn-catch');
  if (btn) btn.disabled = !(canAct() && plan.ok);

  /* 只在真的有问题时才出提示，付款顺利就不占地方 */
  const note = $('pay-note');
  if (note) {
    const prefix = payCtx.kind === 'reserved' ? '这张卡在你的手牌里。' : '';
    if (!plan.ok) {
      note.className = 'detail-note bad';
      note.textContent = `${prefix}大师球不够：少顶替几个颜色，或先攒几枚大师球。`;
    } else if (!canAct()) {
      note.className = 'detail-note';
      note.textContent = '等轮到你时才能捕捉。';
    } else {
      note.className = 'detail-note hidden';
      note.textContent = '';
    }
  }
}

/* ------------------------------ 卡牌详情 ------------------------------ */

function openCardDetail(ds) {
  const g = state.game;
  const uid = ds.uid;
  if (!uid) return;

  const kind = ds.uiKind || 'market';
  const tier = ds.tier;
  const slot = Number(ds.slot);
  const index = Number(ds.index);

  let card = null;
  let source = null;

  if (kind === 'market') {
    card = (g.market[tier] || [])[slot] || null;
    source = { kind: 'market', tier: tier === 'rare' || tier === 'legend' ? tier : Number(tier), slot };
  } else if (kind === 'reserved') {
    card = me()?.reserved?.[index] || null;
    source = { kind: 'reserved', index };
  } else {
    return;
  }
  if (!card) return;

  const isMine = kind === 'reserved';
  const canReserve = !isMine && kind === 'market' && tier !== 'rare' && tier !== 'legend' &&
    (me()?.reservedCount || 0) < (g.rules?.maxReserved || 3);

  const lvlText = card.level === 'rare' ? '稀有' : card.level === 'legend' ? '传说' : `${card.level} 阶`;

  const evoText = card.evolvesTo
    ? `<div class="tag evo">可进化为 ${escapeHTML(card.evolvesTo)} · 需 ${card.evoCost.count} 个${BALLS[card.evoCost.color].name}加成</div>`
    : '';

  payCtx = { card, owner: me(), kind, source, draft: {}, plan: null };

  const actions = [];
  actions.push('<button class="btn primary" id="btn-catch">捕捉</button>');
  if (canReserve) actions.push('<button class="btn" id="btn-reserve">保留（+1 大师球）</button>');
  actions.push('<button class="btn ghost" data-close>关闭</button>');

  openSheet(
    'detail',
    `<div class="detail">
      <div class="detail-card">${cardHTML(card, { clickable: false, full: true })}</div>
      <div class="detail-info">
        <div class="detail-name">${escapeHTML(card.name)}</div>
        <div class="detail-tags">
          <span class="tag gold">${card.vp} 分</span>
          <span class="tag">${lvlText}</span>
          ${evoText}
        </div>
        <div class="pay-list" id="pay-area"></div>
        <p class="detail-note hidden" id="pay-note"></p>
      </div>
    </div>
    <div class="sheet-actions">${actions.join('')}</div>`,
    true
  );
  $('modal').querySelector('.sheet')?.classList.add('detail-sheet');

  renderPaySection();

  $('btn-catch')?.addEventListener('click', () => {
    if (!canAct() || !payCtx?.plan?.ok) return;
    if (sendAction({ type: 'catch', source, useMaster: pickUseMaster() })) closeModal();
  });

  $('btn-reserve')?.addEventListener('click', () => {
    if (!canAct()) return;
    if (sendAction({ type: 'reserve', source })) closeModal();
  });
}

/** 把当前草稿整理成引擎要的 useMaster：只保留真正要用大师球的颜色 */
function pickUseMaster() {
  if (!payCtx?.plan) return undefined;
  const out = {};
  for (const r of payCtx.plan.rows) if (r.use > 0) out[r.c] = r.use;
  return Object.keys(out).length ? out : undefined;
}

/* ------------------------------ 弹层 ------------------------------ */

function openSheet(key, html, closable = true, wide = false) {
  const layer = $('modal');
  layer.innerHTML = `<div class="sheet ${wide ? 'wide' : ''}">${
    closable ? '<button class="sheet-close" data-close>×</button>' : ''
  }${html}</div>`;
  layer.classList.remove('hidden');
  currentModal = { key, closable, stateSeq };
}

function closeModal() {
  const layer = $('modal');
  layer.classList.add('hidden');
  layer.innerHTML = '';
  currentModal = null;
}

/** 换画面时关掉「这一手必须处理」的弹层，但别把房主正在看的面板刷掉 */
function closeTransientModal() {
  const keep = ['members', 'bots', 'rules'];
  if (keep.includes(currentModal?.key)) return;
  closeModal();
}

$('modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal' && currentModal?.closable) closeModal();
  if (e.target.closest('[data-close]') && currentModal?.closable) closeModal();
});

/** 详情里的「大师球顶替 ± 步进」——纯本地草稿，不发给服务器 */
$('modal').addEventListener('click', (e) => {
  const step = e.target.closest('[data-pay-step]');
  if (!step || !payCtx) return;
  const row = payCtx.plan?.rows.find((r) => r.c === step.dataset.c);
  if (!row) return;
  const delta = Number(step.dataset.payStep) || 0;
  payCtx.draft[row.c] = Math.max(row.forced, Math.min(row.need, row.use + delta));
  renderPaySection();
});

function openConfirm(title, text, okLabel, onOk) {
  openSheet(
    'confirm',
    `<h3>${escapeHTML(title)}</h3>
     <p class="sub">${escapeHTML(text)}</p>
     <div class="sheet-actions">
       <button class="btn" data-close>取消</button>
       <button class="btn primary" id="btn-ok">${escapeHTML(okLabel)}</button>
     </div>`,
    true
  );
  $('btn-ok').addEventListener('click', () => {
    if (onOk()) closeModal();
  });
}

/** 根据服务器阶段强制弹出对应面板 */
function syncModals() {
  const g = state?.game;
  if (!g) return;

  if (g.phase === 'ended') {
    if (currentModal?.key !== 'ended' && currentModal?.key !== 'bots') openResult();
    return;
  }

  if (g.phase === 'discard') {
    if (currentModal?.key !== 'discard') openDiscard();
    return;
  }

  if (g.phase === 'evolve') {
    if (currentModal?.key !== 'evolve') openEvolve();
    return;
  }

  /*
   * 详情/确认这类弹层是玩家正看着的，只在「牌局确实往前走了」时才关。
   * 以前是每次渲染都关：一边开着自己那半屏、一边被别人一次广播关掉，
   * 切标签页回来正好撞上一条补发状态，弹层就莫名消失了。
   */
  if (['detail', 'confirm'].includes(currentModal?.key) && currentModal.stateSeq === stateSeq) return;

  if (['discard', 'evolve', 'ended', 'detail', 'confirm'].includes(currentModal?.key)) {
    closeModal();
  }
}

function openDiscard() {
  const g = state.game;
  const need = g.pending?.need || 0;
  const p = me();
  discardDraft = {};

  const cells = ALL_BALLS.filter((c) => (p.tokens[c] || 0) > 0)
    .map(
      (c) => `<div class="discard-cell" data-cell="${c}">
        <span class="ball" style="${ballStyle(c)}"></span>
        <div class="stepper">
          <button data-step="-1" data-c="${c}">−</button>
          <span class="val" data-val="${c}">0</span>
          <button data-step="1" data-c="${c}">+</button>
        </div>
        <span class="have">持有 ${p.tokens[c]}</span>
      </div>`
    )
    .join('');

  openSheet(
    'discard',
    `<h3>返还精灵球</h3>
     <p class="sub">回合结束最多保留 ${state.game.rules?.maxTokens || 10} 枚，请正好返还 <b>${need}</b> 枚。</p>
     <div class="discard-grid">${cells}</div>
     <div class="sheet-actions">
       <button class="btn primary" id="btn-discard" disabled>确认返还</button>
     </div>`,
    false
  );

  const refresh = () => {
    const sum = Object.values(discardDraft).reduce((s, v) => s + v, 0);
    ALL_BALLS.forEach((c) => {
      const el = document.querySelector(`[data-val="${c}"]`);
      if (el) el.textContent = discardDraft[c] || 0;
    });
    const btn = $('btn-discard');
    btn.disabled = sum !== need;
    btn.textContent = sum === need ? '确认返还' : `还需返还 ${need - sum} 枚`;
  };

  $('modal').querySelectorAll('.discard-cell button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const c = btn.dataset.c;
      const d = Number(btn.dataset.step);
      const cur = discardDraft[c] || 0;
      const max = me().tokens[c] || 0;
      const next = Math.max(0, Math.min(max, cur + d));
      if (next === cur) return;
      discardDraft[c] = next;
      refresh();
    });
  });

  $('btn-discard').addEventListener('click', () => {
    const ret = {};
    for (const [c, v] of Object.entries(discardDraft)) if (v > 0) ret[c] = v;
    if (sendAction({ type: 'discard', return: ret })) closeModal();
  });

  refresh();
}

function openEvolve() {
  const g = state.game;
  const options = g.pending?.options || [];
  if (!options.length) { closeModal(); return; }

  const rows = options
    .map(
      (o, i) => `<button class="evo-row" data-evo="${i}">
        <span class="evo-thumb"><img src="${o.fromImg}" alt="" draggable="false"></span>
        <span class="evo-arrow">→</span>
        <span class="evo-thumb"><img src="${o.toImg}" alt="" draggable="false"></span>
        <span class="evo-text">
          <span class="t1">${escapeHTML(o.fromName)} → ${escapeHTML(o.toName)}</span>
          <span class="t2">需要 ${o.evoCost.count} 个${BALLS[o.evoCost.color].name}加成 · ${
        o.where.kind === 'market' ? '目标在市场中' : '目标在你的手牌里'
      }</span>
        </span>
        <span class="evo-plus">+${o.toVp - o.fromVp} 分</span>
      </button>`
    )
    .join('');

  openSheet(
    'evolve',
    `<h3>进化宝可梦</h3>
     <p class="sub">回合结束可以进化 1 只，不消耗行动。进化后旧卡压到训练家面板下，不计分也不提供加成。</p>
     <div class="evo-list">${rows}</div>
     <div class="sheet-actions">
       <button class="btn ghost" id="btn-skip-evo">跳过</button>
     </div>`,
    false
  );

  $('modal').querySelectorAll('[data-evo]').forEach((el) => {
    el.addEventListener('click', () => {
      const o = options[Number(el.dataset.evo)];
      if (sendAction({ type: 'evolve', fromUid: o.fromUid, toUid: o.toUid, where: o.where })) closeModal();
    });
  });

  $('btn-skip-evo').addEventListener('click', () => {
    if (sendAction({ type: 'skipEvolve' })) closeModal();
  });
}

function openResult() {
  const g = state.game;
  const res = g.results;
  if (!res) return;

  const rows = res.ranked
    .map((r, i) => {
      const t = trainerOf(state.players.find((p) => p.id === r.id)?.trainer);
      const win = res.winners.includes(r.id);
      return `<div class="result-row ${win ? 'win' : ''}">
        <span class="result-rank">${i + 1}</span>
        <img class="pc-avatar" src="${t.img}" alt="" draggable="false">
        <span class="result-name">${escapeHTML(r.name)}</span>
        <span class="result-meta"><span>进化 ${r.evolved}</span><span>场上 ${r.cardCount}</span></span>
        <span class="result-score">${r.score}</span>
      </div>`;
    })
    .join('');

  const winners = res.ranked.filter((r) => res.winners.includes(r.id)).map((r) => r.name);

  openSheet(
    'ended',
    `<h3>对局结束</h3>
     <p class="sub">${winners.map(escapeHTML).join('、')} 获胜 · 平局依次比进化数与场上卡数</p>
     <div class="result-list">${rows}</div>
     <div class="sheet-actions">
       ${
         state.isHost
           ? '<button class="btn primary" id="btn-again">再来一局</button><button class="btn" id="btn-bots-ended">调整人机</button>'
           : '<button class="btn" data-close>关闭</button>'
       }
     </div>`,
    !state.isHost
  );

  $('btn-again')?.addEventListener('click', () => {
    send({ type: 'restart' });
    closeModal();
  });

  $('btn-bots-ended')?.addEventListener('click', openBots);
}

/* ------------------------------ 大厅 / 顶栏交互 ------------------------------ */

/** 大厅按钮防连点：发出创建/加入后 1.2 秒内忽略重复点击，免得一瞬间开出两个房间 */
let lobbyBusyUntil = 0;
function lobbyBusy() {
  const now = Date.now();
  if (now < lobbyBusyUntil) return true;
  lobbyBusyUntil = now + 1200;
  return false;
}

/**
 * 大厅的「创建 / 加入」统一出口。
 *
 * - 连点保护：1.2 秒内只发一次（收到结果后会立刻解锁）
 * - 连接还没建好就点了：存成 pendingIntent，握手完成后补发（那次点击不白点）
 */
function lobbySend(intent) {
  if (lobbyBusy()) return;
  if (send(intent)) return;
  pendingIntent = intent;
  toast('正在连接服务器…', 'bad');
  connect();
}

function initLobby() {
  $('trainer-pick').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-trainer]');
    if (!btn) return;
    pickedTrainer = btn.dataset.trainer;
    try { localStorage.setItem(TRAINER_KEY, pickedTrainer); } catch { /* ignore */ }
    renderLobby();
  });

  try {
    const saved = localStorage.getItem(TRAINER_KEY);
    if (saved && TRAINERS.some((t) => t.id === saved)) pickedTrainer = saved;
  } catch { /* ignore */ }

  $('btn-create').addEventListener('click', () => {
    // 明确要开新桌：先丢掉「上次那局」的会话，别让重连把人塞回旧房间
    clearSession();
    $('lobby-hint').textContent = '';
    lobbySend({ type: 'create', name: currentName(), trainer: pickedTrainer });
  });

  const join = () => {
    const code = $('in-code').value.trim().toUpperCase();
    if (code.length < 4) { $('lobby-hint').textContent = '请输入 5 位房间码'; return; }
    clearSession();
    $('lobby-hint').textContent = '';
    lobbySend({ type: 'join', code, name: currentName(), trainer: pickedTrainer });
  };
  $('btn-join').addEventListener('click', join);
  $('in-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

  $('in-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
}

/*
 * 分享出去的域名要跟着「页面」走，不能跟着对局服务走。
 *
 * 静态站搬到 GitHub Pages 之后，服务端推下来的 shareLink 仍然是它自己的域名，
 * 照抄发出去朋友就得重新过一次那条慢链路 —— 页面明明能从快的地址打开。
 * 所以这里只从服务端那份链接里取邀请码，域名换成当前页面。
 */
function pageBaseUrl(src) {
  const u = new URL(`${location.origin}${location.pathname}`);
  const k = src?.searchParams?.get('k');
  if (k) u.searchParams.set('k', k);
  return u;
}

function inviteUrl() {
  // 房主的公网地址由服务端推下来（exe 没有控制台窗口，链接只能显示在页面上）
  const base = state?.shareLink || shareLink;
  if (base) {
    const u = pageBaseUrl(new URL(base));
    if (state?.code) u.searchParams.set('room', state.code);
    return u.toString();
  }

  // 已经在公网/局域网地址上打开的（朋友自己转发），当前地址就能直接用
  if (!isLocalWindow()) {
    const u = new URL(location.href);
    if (state?.code) u.searchParams.set('room', state.code);
    return u.toString();
  }

  // 房主本机窗口，但隧道还没打通：此时复制出去的是 localhost，朋友打不开
  return null;
}

/** 页面是不是跑在房主本机的客户端窗口里 */
function isLocalWindow() {
  /*
   * 页面已经不在对局服务上了（静态站搬去 CDN），那 location 是本机地址
   * 只说明「我在这台机器上打开了页面」，不代表朋友打不开这个地址。
   * 这种情况交给后面的 API_BASE 分支处理，这里直接判否。
   */
  if (API_BASE) return false;
  const h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg, 'ok');
    return true;
  } catch {
    // http 页面或旧浏览器没有 clipboard API
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      toast(ok ? okMsg : '复制失败，请手动选择文字复制', ok ? 'ok' : 'bad');
      return ok;
    } catch {
      toast('复制失败，请手动复制地址栏链接', 'bad');
      return false;
    }
  }
}

async function copyInvite() {
  const link = inviteUrl();
  if (!link) {
    toast('公网通道还在打通，十几秒后再点一次');
    return;
  }
  await copyText(link, '邀请链接已复制');
}

/* ------------------------------ 成员 ------------------------------ */

/** 某位成员自己的进入链接：域名换了也能用，认的是码不是 Cookie */
function memberLink(code) {
  // 房主的窗口是 localhost，直接拿 location.href 拼出来的是本机地址，朋友打不开
  const base = state?.shareLink || shareLink;
  const u = base ? pageBaseUrl(new URL(base)) : new URL(location.href);
  u.searchParams.delete('k');
  u.searchParams.delete('room');
  u.searchParams.set('m', code);
  return u.toString();
}

function timeAgo(ts) {
  if (!ts) return '还没进来过';
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function membersHTML() {
  const list = state?.members || [];
  if (!list.length) {
    return '<p class="sub mem-empty">还没有成员。朋友第一次进来玩过之后，会自动出现在这里。</p>';
  }
  return list
    .map(
      (g) => `<div class="mem-row ${g.revoked ? 'off' : ''}">
      <div class="mem-main">
        <span class="mem-name">${escapeHTML(g.name)}</span>
        <span class="mem-meta">${
          g.revoked ? '已收回权限' : `进入码 <b>${g.code}</b>`
        } · ${timeAgo(g.lastSeen)}${g.devices > 1 ? ` · ${g.devices} 台设备` : ''}</span>
      </div>
      <div class="mem-acts">
        <button class="btn tiny" data-copy="${g.code}">复制链接</button>
        <button class="btn tiny ${g.revoked ? '' : 'danger'}" data-perm="${
          g.revoked ? 'allow' : 'revoke'
        }" data-id="${g.id}">${g.revoked ? '恢复' : '收回'}</button>
      </div>
    </div>`
    )
    .join('');
}

function openMembers() {
  if (!state?.isHost) return;
  openSheet(
    'members',
    `<h3>成员 <span class="mem-count">${(state.members || []).length}</span></h3>
     <p class="sub">第一次进来玩过的人会自动记在这里。凭他自己的进入码或链接就能再回来，
     不用再找你要团队邀请码。</p>
     <div class="mem-list" id="mem-list">${membersHTML()}</div>
     <div class="sheet-actions">
       ${
         isLocalWindow()
           ? '<button class="btn ghost quit" data-quit>关闭牌桌</button>'
           : ''
       }
       <button class="btn" data-close>关闭</button>
     </div>`,
    true,
    true
  );
}

/** 名单变了只重画列表，不整块重建（避免滚动位置跳走） */
function refreshMembers() {
  if (currentModal?.key !== 'members') return;
  const box = $('mem-list');
  if (box) box.innerHTML = membersHTML();
}

/* ------------------------------ 人机 ------------------------------ */

function botsListHTML() {
  const list = state?.players || [];
  if (!list.length) return '<p class="sub mem-empty">还没有玩家</p>';
  return list
    .map((p) => {
      const t = trainerOf(p.trainer);
      return `<div class="bot-row">
        <img src="${t.img}" alt="" draggable="false">
        <span class="bot-name">${escapeHTML(p.name)}</span>
        ${
          p.isBot
            ? `<span class="wp-tag bot">人机 · ${escapeHTML(p.botLabel || botLabel(p.botLevel))}</span>
               <button class="btn tiny danger" data-bot-remove="${p.id}">移除</button>`
            : `<span class="wp-tag">真人${p.id === state.hostId ? ' · 房主' : ''}</span>`
        }
      </div>`;
    })
    .join('');
}

function botsAddHTML() {
  const full = (state?.players?.length || 0) >= 4;
  return BOT_LEVELS.map(
    (l) => `<button class="bot-opt" data-bot-add="${l.id}" ${full ? 'disabled' : ''}>
      <span class="bo-label">＋ ${l.label}</span>
      <span class="bo-desc">${l.desc}</span>
    </button>`
  ).join('');
}

function openBots() {
  if (!state?.isHost) return;
  const n = state.players.length;
  const ended = state.game?.phase === 'ended';
  openSheet(
    'bots',
    `<h3>人机玩家</h3>
     <p class="sub">人机不用联网，会自己把牌打完。房间最多 4 人，现在 ${n} 人${
      n >= 4 ? '（已满）' : ''
    }。</p>
     <div class="bot-list" id="bot-list">${botsListHTML()}</div>
     <div class="bot-add">${botsAddHTML()}</div>
     <div class="sheet-actions">
       ${
         ended
           ? '<button class="btn" id="btn-back-result">返回结算</button>'
           : '<button class="btn" data-close>关闭</button>'
       }
     </div>`,
    true,
    true
  );

  $('btn-back-result')?.addEventListener('click', () => {
    openResult();
  });
}

/** 人数变了就整块重画这张面板：内容很短，重建比局部改更不容易出错 */
function refreshBots() {
  if (currentModal?.key !== 'bots') return;
  openBots();
}

/* ------------------------------ 规则设置 ------------------------------ */

const RULE_GROUPS = [
  {
    key: 'winPoints',
    label: '目标分数',
    hint: '有人到这个分数后，本轮打完结算',
    opts: [[12, '12 分'], [15, '15 分'], [18, '18 分 · 标准'], [21, '21 分']],
  },
  {
    key: 'maxReserved',
    label: '手牌上限',
    hint: '每人最多保留几张卡',
    opts: [[2, '2 张'], [3, '3 张 · 标准'], [4, '4 张']],
  },
  {
    key: 'maxTokens',
    label: '持球上限',
    hint: '回合结束时超过上限要返还',
    opts: [[8, '8 枚'], [10, '10 枚 · 标准'], [12, '12 枚']],
  },
  {
    key: 'tokensPerBall',
    label: '供应区球数',
    hint: '每种颜色开局放几枚（大师球固定 5 枚）',
    opts: [[0, '随人数'], [5, '5 枚'], [7, '7 枚']],
  },
  {
    key: 'rareCards',
    label: '稀有 / 传说卡',
    hint: '5 张稀有 + 5 张传说是否进场',
    opts: [[true, '开启'], [false, '关闭']],
  },
  {
    key: 'evolve',
    label: '进化规则',
    hint: '回合末可以免费进化 1 只',
    opts: [[true, '开启'], [false, '关闭']],
  },
];

/** 一行字概括这局怎么打（等待区、顶栏都用它） */
function rulesSummary(r) {
  const v = r || {};
  const per = v.tokensPerBall ? `每色 ${v.tokensPerBall} 枚` : '球数随人数';
  return `${v.winPoints || 18} 分获胜 · 手牌 ${v.maxReserved || 3} 张 · 最多持球 ${
    v.maxTokens || 10
  } 枚 · ${per} · ${v.rareCards === false ? '无稀有传说' : '含稀有传说'} · ${
    v.evolve === false ? '关闭进化' : '可进化'
  }`;
}

function openRules() {
  if (!state?.isHost) return;
  const cur = state.rules || {};

  const rows = RULE_GROUPS.map((grp) => {
    const opts = grp.opts
      .map(([v, label]) => {
        const sel = String(cur[grp.key]) === String(v);
        return `<button class="rule-opt ${sel ? 'sel' : ''}" data-rule="${grp.key}" data-value="${v}">${label}</button>`;
      })
      .join('');
    return `<div class="rule-row">
      <div class="rule-label"><b>${grp.label}</b><small>${grp.hint}</small></div>
      <div class="rule-opts">${opts}</div>
    </div>`;
  }).join('');

  openSheet(
    'rules',
    `<h3>规则设置</h3>
     <p class="sub">改动会立刻同步给房间里所有人，开局时生效；对局进行中修改只影响下一局。</p>
     <div class="rule-list">${rows}</div>
     <div class="sheet-actions">
       <button class="btn" data-close>完成</button>
     </div>`,
    true,
    true
  );
}

/** 房主点了一下选项：乐观等回包，服务端校验后会广播整份规则回来 */
function setRule(key, raw) {
  if (!state?.isHost) return;
  const value = raw === 'true' ? true : raw === 'false' ? false : Number(raw);
  const next = { ...(state.rules || {}), [key]: value };
  send({ type: 'setRules', rules: next });
}

/** 规则面板开着的时候，收到新状态就整块重画一遍（内容短，不会闪） */
function refreshRules() {
  if (currentModal?.key !== 'rules') return;
  openRules();
}

/* ------------------------------ 关掉整个牌桌 ------------------------------ */

/**
 * 关掉整个牌桌。
 *
 * exe 版没有黑窗口可以关，所以留了这个出口：服务端收到就退出，
 * 页面立刻切到「已关闭」，不然这里会一直转圈重连。
 */
async function quitTable() {
  try {
    await fetch(api('/api/quit'), { method: 'POST' });
  } catch {
    /* 服务已经退了也算成功 */
  }
  manualClose = true;
  clearSession();
  try { ws?.close(); } catch { /* ignore */ }
  closeModal();
  const cover = document.createElement('section');
  cover.className = 'goodbye';
  cover.innerHTML =
    '<h2>牌桌已关闭</h2>' +
    '<p>公网链接已经失效，可以把这个窗口关掉了。</p>' +
    '<p class="sub">下次双击「启动牌局」重新开局，链接会是新的一条。</p>';
  document.body.appendChild(cover);
}

function initTopbar() {
  $('btn-invite').addEventListener('click', copyInvite);
  $('btn-invite2').addEventListener('click', copyInvite);
  $('btn-members').addEventListener('click', openMembers);
  $('btn-members2').addEventListener('click', openMembers);
  $('btn-bots')?.addEventListener('click', openBots);
  $('btn-rules')?.addEventListener('click', openRules);

  // 人机的加/减：等待区的人机行、人机面板里都能点
  document.addEventListener('click', (e) => {
    const add = e.target.closest('[data-bot-add]');
    if (add) {
      if (add.disabled) return;
      send({ type: 'addBot', level: add.dataset.botAdd });
      return;
    }
    const del = e.target.closest('[data-bot-remove]');
    if (del) send({ type: 'removeBot', id: del.dataset.botRemove });
  });

  // 成员面板里的按钮
  $('modal').addEventListener('click', (e) => {
    const ruleBtn = e.target.closest('[data-rule]');
    if (ruleBtn) {
      setRule(ruleBtn.dataset.rule, ruleBtn.dataset.value);
      return;
    }
    const quitBtn = e.target.closest('[data-quit]');
    if (quitBtn) {
      openConfirm(
        '关闭牌桌',
        '公网链接会立刻失效，房间里的朋友会全部断开。下次玩要重新双击程序，链接也会换成新的一条。',
        '确认关闭',
        quitTable
      );
      return;
    }
    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) {
      copyText(memberLink(copyBtn.dataset.copy), '他的专属链接已复制');
      return;
    }
    const permBtn = e.target.closest('[data-perm]');
    if (permBtn) {
      const allow = permBtn.dataset.perm === 'allow';
      send({ type: allow ? 'allowGuest' : 'revokeGuest', id: permBtn.dataset.id });
      toast(allow ? '已恢复他的进入权限' : '已收回权限，他下次进不来了', allow ? 'ok' : '');
    }
  });

  $('btn-start').addEventListener('click', () => send({ type: 'start' }));
  $('wait-link').addEventListener('click', copyInvite);
  $('btn-restart').addEventListener('click', () => {
    openConfirm('重开一局', '所有人会回到新的一局，当前进度不会保留。', '确认重开', () => {
      send({ type: 'restart' });
    });
  });

  const leave = () => {
    manualClose = true;
    clearSession();
    send({ type: 'leave' });
    state = null;
    selectedColors = [];
    manualClose = false;
    render();
  };
  $('btn-exit').addEventListener('click', () => {
    openConfirm('退出房间', '退出后可以由邀请链接重新加入。', '确认退出', () => { leave(); });
  });
  $('btn-leave-wait').addEventListener('click', leave);
}

/* ------------------------------ 网络事件 ------------------------------ */

function initNetworkEvents() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (manualClose || !state?.code) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reconnectAttempt = 0;
      connect();
    } else {
      connected = true;
      lastSeenAt = Date.now();
      renderNet();
      flushRender();
      send({ type: 'ping' });
      send({ type: 'sync' });
    }
  });

  window.addEventListener('online', () => {
    if (manualClose) return;
    reconnectAttempt = 0;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;

    if (ws && ws.readyState === WebSocket.OPEN) {
      connected = true;
      lastSeenAt = Date.now();
      renderNet();
      send({ type: 'ping' });
      send({ type: 'sync' });
    } else {
      connect();
    }
  });

  window.addEventListener('offline', () => {
    connected = false;
    renderNet();
    if (ws) {
      try { ws.close(); } catch { /* ignore */ }
    }
  });

  window.addEventListener('resize', () => queueFit());

  // 牌桌尺寸会随玩家面板变高变矮，观察它并重新计算卡牌尺寸
  const table = $('table');
  if (table && 'ResizeObserver' in window) {
    const ro = new ResizeObserver(() => queueFit());
    ro.observe(table);
  }
}

/* ------------------------------ 启动 ------------------------------ */

window.__splendor = {
  get ws() { return ws; },
  get connected() { return connected; },
  get state() { return state; },
  get seq() { return stateSeq; },
  get attempt() { return reconnectAttempt; },
  get ticks() { return tickCount; },
  get renders() { return renderCount; },
};

/* ------------------------------ 离线缓存与安装 ------------------------------ */

/*
 * 国内到 Cloudflare 这一段时通时断，一张卡图能挂几十秒。
 * 把壳子和卡图交给 Service Worker 之后就再也不用为此等：
 * 第一次访问正常下完，之后全都从本地读，断网也能把牌桌开出来。
 */
let swReg = null;

function initOfflineCache() {
  if (!('serviceWorker' in navigator)) return;
  // 静态站挂在别处（CDN 自带长缓存和边缘节点）时不需要 SW：那层缓存反而会挡更新
  if (CFG.noSW) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;

  navigator.serviceWorker
    .register('sw.js', { scope: './', updateViaCache: 'none' })
    .then((reg) => {
      swReg = reg;
      schedulePrefetch();
      // 新版本装上后自动接替，不用玩家自己刷新
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        if (!w) return;
        w.addEventListener('statechange', () => {
          if (w.state === 'activated') schedulePrefetch();
        });
      });
    })
    .catch(() => { /* 装不上就当没有，页面照常 */ });

  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'prefetched') prefetched = true;
  });
}

let prefetchSent = false;
let prefetched = false;
let prefetchStopped = false;

/*
 * 空闲时把 140 张缩略图在后台补齐。
 * 首局只会用到十几张，剩下的慢慢搬到本地 —— 第二局就没有一次网络等待。
 */
/** 慢网、省流量模式、或者已经开局了，都不做后台预取 —— 抢带宽只会让牌桌更慢 */
function prefetchWorthIt() {
  const c = navigator.connection;
  if (c?.saveData) return false;
  if (c?.effectiveType && /(^|-)2g$|3g/.test(c.effectiveType)) return false;
  if (state?.game) return false;
  return true;
}

function schedulePrefetch() {
  setTimeout(() => {
    if (prefetchWorthIt()) prefetchCardArt();
  }, 8000);
}

function stopPrefetch() {
  const worker = swReg?.active || navigator.serviceWorker?.controller;
  worker?.postMessage({ type: 'prefetch-stop' });
}

function prefetchCardArt() {
  if (prefetchSent || prefetched) return;
  if (!prefetchWorthIt()) return;
  const worker = swReg?.active || navigator.serviceWorker?.controller;
  if (!worker) return;
  prefetchSent = true;

  const urls = [];
  for (const tier of ['s1', 's2', 's3', 'mg', 'lg']) {
    for (let i = 1; i <= 40; i++) {
      const n = String(i).padStart(2, '0');
      urls.push(asset(`/assets/cards/thumb/${tier}_${n}.webp`));
    }
  }

  const go = () => worker.postMessage({ type: 'prefetch', urls });
  if ('requestIdleCallback' in window) requestIdleCallback(go, { timeout: 4000 });
  else setTimeout(go, 3000);
}

/* 装到桌面：装完就是独立窗口，和浏览器标签页彻底分开 */
function initInstall() {
  const btn = $('btn-install');
  if (!btn) return;
  let deferred = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    btn.classList.remove('hidden');
  });

  btn.addEventListener('click', async () => {
    if (!deferred) {
      toast('浏览器菜单里选「安装应用 / 添加到主屏幕」');
      return;
    }
    deferred.prompt();
    const res = await deferred.userChoice.catch(() => null);
    deferred = null;
    btn.classList.add('hidden');
    if (res?.outcome === 'accepted') toast('已装到桌面', 'ok');
  });

  window.addEventListener('appinstalled', () => btn.classList.add('hidden'));
  if (window.matchMedia('(display-mode: standalone)').matches) btn.classList.add('hidden');
}

function boot() {
  initLobby();
  initTopbar();
  initNetworkEvents();
  startWatchdog();
  initOfflineCache();
  initInstall();
  render();
  connect();
}

boot();
