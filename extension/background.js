'use strict';

const VEST = 'https://next.vestmarkets.com';
const BASE = 'http://127.0.0.1:8877/v1/plugin/';
const BUILD = /^git\.([0-9a-f]{40})$/.exec(chrome.runtime.getManifest().version_name || '')?.[1] || '';
const UPDATE_ALARM = 'node-release';
const DESTINATIONS = {
  trade: '/trade/NQ-PERP',
  portfolio: '/portfolio'
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Serialize binding changes and reload detection even when multiple tabs wake the MV3 worker.
let settingsQueue = Promise.resolve();
function exclusive(fn) {
  const result = settingsQueue.then(fn);
  settingsQueue = result.catch(() => {});
  return result;
}
async function settings() {
  return (await chrome.storage.local.get('settings')).settings || {};
}
async function binding() {
  return (await chrome.storage.session.get('binding')).binding;
}
function publicBinding({
  session_id,
  worker_id,
  mode,
  label,
  generation
}) {
  return {
    release: BUILD,
    session_id,
    worker_id,
    mode,
    label,
    generation
  };
}
async function revoke(previous) {
  if (previous) {
    await chrome.tabs.sendMessage(previous.tabId, {
      type: 'fleet.revoke',
      session_id: previous.session_id
    }).catch(() => {});
  }
}
async function rotate(old, cfg, tabId, pageId, mode) {
  await revoke(old);
  const generation = Math.max((cfg.generation || 0) + 1, Date.now());
  const next = {
    tabId,
    pageId,
    worker_id: cfg.worker_id || crypto.randomUUID(),
    session_id: crypto.randomUUID(),
    generation,
    label: cfg.label,
    mode
  };
  await chrome.storage.local.set({
    settings: {
      ...cfg,
      worker_id: next.worker_id,
      generation
    }
  });
  await chrome.storage.session.set({
    binding: next
  });
  return next;
}
async function post(op, payload, cfg) {
  const response = await fetch(BASE + op, {
    method: 'POST',
    redirect: 'error',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + cfg.token
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000)
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(Error(data.error || '桥接口 HTTP ' + response.status), {
    status: response.status
  });
  return data;
}
async function setBinding(message) {
  let cfg = await settings();
  const previous = await binding();
  if (message.type === 'ui.state') {
    const saved = await chrome.storage.session.get(['diagnostic', 'receiptError']);
    return {
      label: cfg.label || '',
      paired: !!cfg.token,
      mode: previous?.mode || 'unbound',
      worker_id: cfg.worker_id || '',
      diagnostic: saved.receiptError || saved.diagnostic || ''
    };
  }
  if (message.type === 'ui.disconnect') {
    await chrome.storage.local.remove('updateResume');
    await revoke(previous);
    await chrome.storage.session.remove('binding');
    if (previous && cfg.token) {
      // A new read-only generation invalidates queued writes at the bridge immediately.
      const generation = Math.max(cfg.generation + 1, Date.now());
      await chrome.storage.local.set({
        settings: {
          ...cfg,
          generation
        }
      });
      await post('heartbeat', {
        ...publicBinding(previous),
        session_id: crypto.randomUUID(),
        generation,
        mode: 'readonly',
        error: '插件已断开绑定'
      }, cfg).catch(() => {});
    }
    return {
      ok: true
    };
  }
  if (message.type !== 'ui.bind') throw Error('未知设置');
  if (!['readonly', 'execute'].includes(message.mode)) throw Error('模式无效');
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  if (!tab?.url || new URL(tab.url).origin !== VEST) throw Error('请在已登录的 Vest 标签页打开插件');
  const page = await chrome.tabs.sendMessage(tab.id, {
    type: 'fleet.identify'
  });
  if (!page?.pageId) throw Error('请刷新 Vest 页面后重新绑定');
  const token = message.token || cfg.token;
  const label = String(message.label || '').trim();
  if (!token || token.length < 24 || !label || label.length > 80) throw Error('请填写浏览器名称和插件密钥');
  cfg = {
    ...cfg,
    token,
    label
  };
  const next = await rotate(previous, cfg, tab.id, page.pageId, message.mode);
  try {
    await post('heartbeat', {
      ...publicBinding(next),
      page: new URL(tab.url).pathname
    }, cfg);
    await chrome.storage.session.set({
      diagnostic: '已连接本机桥'
    });
  } catch (err) {
    await chrome.storage.session.remove('binding');
    await chrome.storage.session.set({
      diagnostic: err.message
    });
    throw err;
  }
  return publicBinding(next);
}
async function context(message, sender) {
  const current = await binding();
  if (!current || current.tabId !== sender.tab.id) return null;
  let owner = current;
  const cfg = await settings();
  if (current.pageId !== message.pageId) {
    const page = await chrome.tabs.sendMessage(sender.tab.id, {
      type: 'fleet.identify'
    });
    if (page?.pageId !== message.pageId) throw Error('旧页面已退出');
    owner = await rotate(current, cfg, sender.tab.id, message.pageId, 'readonly');
  }
  if (message.session_id && message.session_id !== owner.session_id) throw Error('浏览器授权已变化');
  return {
    owner,
    cfg
  };
}
async function persistReceipt(payload, cfg) {
  const key = 'receipt.' + payload.id;
  // Save the evidence before the network request, including the original worker and session.
  await chrome.storage.local.set({
    [key]: payload
  });
  await post('result', payload, cfg);
  await chrome.storage.local.remove(key);
  await chrome.storage.session.remove('lease.' + payload.id);
}
async function reserveClick(owner, id, stage) {
  if ((await binding())?.session_id !== owner.session_id) throw Error('执行授权已变化');
  const cutoff = Date.now() - 48 * 3600 * 1000;
  const journal = (await chrome.storage.local.get('clickJournal')).clickJournal || {};
  for (const [key, time] of Object.entries(journal)) if (time < cutoff) delete journal[key];
  const key = id + ':' + stage;
  if (Object.hasOwn(journal, key)) throw Error('本浏览器已记录该指令的操作许可，禁止重复点击');
  journal[key] = Date.now();
  await chrome.storage.local.set({
    clickJournal: journal
  });
}
let draining;
async function drain(cfg) {
  if (draining) return draining;
  draining = (async () => {
    const stored = await chrome.storage.local.get(null);
    let receiptError = '';
    for (const [key, payload] of Object.entries(stored)) {
      if (!key.startsWith('receipt.')) continue;
      try {
        await post('result', payload, cfg);
      } catch (err) {
        if (![400, 404, 409, 413].includes(err.status)) throw err;
        // Preserve the original evidence if a different or restored bridge cannot accept it yet.
        receiptError = '回执 ' + payload.id + ' 等待核验：' + err.message;
        continue;
      }
      await chrome.storage.local.remove(key);
      await chrome.storage.session.remove('lease.' + payload.id);
    }
    await chrome.storage.session.set({
      receiptError
    });
  })().finally(() => {
    draining = null;
  });
  return draining;
}

async function checkRelease(target) {
  // Only managed unpacked installations have a stamped manifest and a local release marker.
  if (!BUILD) return;
  if (!target) {
    const res = await fetch(new URL('/healthz', BASE), {
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(4000)
    });
    if (!res.ok) return;
    const health = await res.json();
    if (health.service !== 'bridge') return;
    target = health.release;
  }
  if (BUILD === target || !/^[0-9a-f]{40}$/.test(target)) return;
  const marker = await fetch(chrome.runtime.getURL('fleet-release.json'), {cache: 'no-store'});
  if (!marker.ok || (await marker.json()).revision !== target) return;
  const current = await binding();
  if (current) {
    await drain(await settings());
    await chrome.storage.local.set({updateResume: {
      target, tabId: current.tabId, worker: current.worker_id, generation: current.generation, savedAt: Date.now()
    }});
  }
  chrome.runtime.reload();
}

async function resumeUpdatedTab() {
  const {updateResume: saved} = await chrome.storage.local.get('updateResume');
  if (!saved || saved.target !== BUILD) return;
  const cfg = await settings();
  const tab = await chrome.tabs.get(saved.tabId).catch(() => null);
  if (Date.now() - saved.savedAt < 300000 && cfg.worker_id === saved.worker &&
      cfg.generation === saved.generation && tab?.url && new URL(tab.url).origin === VEST) {
    await rotate(null, cfg, saved.tabId, 'await-updated-document', 'readonly');
    await chrome.tabs.reload(saved.tabId);
  }
  await chrome.storage.local.remove('updateResume');
}

function checkOnWake() {
  if (BUILD) exclusive(async () => {
    await resumeUpdatedTab();
    if (!await chrome.alarms.get(UPDATE_ALARM))
      await chrome.alarms.create(UPDATE_ALARM, {periodInMinutes: 1});
    await checkRelease();
  }).catch(() => {});
}
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === UPDATE_ALARM) exclusive(() => checkRelease()).catch(() => {});
});
chrome.runtime.onInstalled.addListener(checkOnWake);
chrome.runtime.onStartup.addListener(checkOnWake);
checkOnWake();
async function navigate(cmd, owner, cfg) {
  const dest = DESTINATIONS[cmd.params.destination];
  const confirmedPath = value => {
    if (!value) return null;
    const url = new URL(value),
      path = url.pathname.replace(/\/$/, '');
    if (url.origin !== VEST || url.username || url.password || url.search || url.hash) return null;
    return path === dest || dest === DESTINATIONS.trade && path === '/trade/NDX-USD-PERP' ? path : null;
  };
  let result = {},
    error = '';
  try {
    if (!dest || (await binding())?.session_id !== owner.session_id) throw Error('目标页面或会话失效');
    const tab = await chrome.tabs.get(owner.tabId);
    if (new URL(tab.url).origin !== VEST) throw Error('执行窗口已离开 Vest');
    if (!confirmedPath(tab.url)) await chrome.tabs.update(owner.tabId, {
      url: VEST + dest
    });
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      const target = await chrome.tabs.get(owner.tabId);
      const path = confirmedPath(target.url);
      if (target.status === 'complete' && path) {
        result = {
          path
        };
        break;
      }
      await delay(250);
    }
    if (!result.path) throw Error('目标页面未在时限内完成加载');
  } catch (err) {
    error = err.message;
  }
  await persistReceipt({
    ...publicBinding(owner),
    id: cmd.id,
    ok: !error,
    error,
    result
  }, cfg);
}
async function handle(message, sender) {
  if (sender.id !== chrome.runtime.id) throw Error('无效的消息来源');
  if (message.type?.startsWith('ui.') && sender.url === chrome.runtime.getURL('popup.html')) {
    return exclusive(() => setBinding(message));
  }
  if (!sender.tab || sender.frameId !== 0 || new URL(sender.url).origin !== VEST) throw Error('无效的执行页面');
  // Revoking execution prevents new clicks. Its original document can still return a receipt.
  if (message.type === 'result') {
    const key = 'lease.' + message.data.id;
    const owner = (await chrome.storage.session.get(key))[key];
    if (!owner || owner.tabId !== sender.tab.id || owner.pageId !== message.pageId || owner.session_id !== message.session_id) throw Error('没有属于该页面的指令租约');
    await persistReceipt({
      ...message.data,
      ...publicBinding(owner)
    }, await settings());
    return {
      bound: true
    };
  }
  const ctx = await exclusive(() => context(message, sender));
  if (!ctx) return {
    bound: false
  };
  const {
    owner,
    cfg
  } = ctx;
  const meta = {
    ...publicBinding(owner),
    page: new URL(sender.url).pathname,
    error: String(message.diagnostic || '').replace(/\s+/g, ' ').slice(0, 500)
  };
  const op = message.type;
  if (!['intent', 'poll', 'report', 'heartbeat'].includes(op)) throw Error('未知插件接口');
  if (op === 'intent' && (!message.session_id || owner.mode !== 'execute')) throw Error('执行授权已撤销');
  if (op === 'poll') await drain(cfg);
  const data = await post(op, {
    ...message.data,
    ...meta
  }, cfg);
  if (op === 'intent' && data.authorize_click === true) {
    await exclusive(() => reserveClick(owner, message.data.id, message.data.stage));
  }
  if (op === 'poll' && data.update_release) {
    await exclusive(() => checkRelease(data.update_release)).catch(() => {});
  }
  if (op === 'poll' && data.command?.action === 'page.navigate') {
    await navigate(data.command, owner, cfg);
    data.command = null;
  } else if (op === 'poll' && data.command) {
    await chrome.storage.session.set({
      ['lease.' + data.command.id]: owner
    });
  }
  if (op === 'poll' || op === 'heartbeat') await chrome.storage.session.set({
    diagnostic: meta.error || '已连接本机桥'
  });
  return {
    bound: true,
    session: publicBinding(owner),
    data
  };
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handle(message, sender).then(value => respond({
    ok: true,
    value
  }), error => respond({
    ok: false,
    error: error.message
  }));
  return true;
});
