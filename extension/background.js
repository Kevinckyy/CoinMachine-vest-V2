'use strict';

const VEST = 'https://next.vestmarkets.com';
const BASE = 'http://127.0.0.1:8877/v1/plugin/';
const BUILD = /^git\.([0-9a-f]{40})$/.exec(chrome.runtime.getManifest().version_name || '')?.[1] || '';
const UPDATE_ALARM = 'node-release';
const DESTINATIONS = {
  accounts: '/accounts',
  trade: '/trade/NQ-PERP',
  portfolio: '/portfolio'
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const ROUTE_START_WINDOW = 22000;
const READ_ROUTES = new Set(['accounts.list','accounts.read_all','account.read','positions.read','history.read','profit.available']);

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
  mode_ticket,
  label,
  generation
}) {
  return {
    release: BUILD,
    plugin_version: chrome.runtime.getManifest().version,
    cards_version: 1,
    portfolio_version: 1,
    strategy_version: 1,
    session_id,
    worker_id,
    mode,
    ...(mode_ticket ? {mode_ticket} : {}),
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
async function rotate(old, cfg, tabId, pageId, mode, ticket) {
  await revoke(old);
  const generation = Math.max((cfg.generation || 0) + 1, (old?.generation || 0) + 1, Date.now());
  const next = {
    tabId,
    pageId,
    worker_id: cfg.worker_id || crypto.randomUUID(),
    session_id: crypto.randomUUID(),
    generation,
    label: cfg.label,
    ...(ticket ? {mode_ticket:ticket} : {}),
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

async function confirmRemoteMode(owner, cfg, page) {
  try {
    await post('heartbeat',{...publicBinding(owner),page},cfg);
  } catch (err) {
    const safe = await rotate(owner,cfg,owner.tabId,owner.pageId,'readonly');
    await post('heartbeat',{...publicBinding(safe),page},cfg).catch(()=>{});
    throw err;
  }
  const confirmed = {...owner};
  delete confirmed.mode_ticket;
  await chrome.storage.session.set({binding:confirmed});
  return confirmed;
}

// Called under the binding lock. A delayed reply can apply only to its original document and session.
async function applyRemoteMode(owner,cfg,offer) {
  const current = await binding();
  if (current?.session_id !== owner.session_id || current.pageId !== owner.pageId)
    throw Error('浏览器授权已变化');
  const tab = await chrome.tabs.get(owner.tabId);
  if (!tab.url || new URL(tab.url).origin !== VEST || (await identifyPage(owner.tabId))?.pageId !== owner.pageId)
    throw Error('绑定页面已变化');
  if (!['readonly','execute'].includes(offer.mode) || !offer.ticket) throw Error('远程权限请求无效');
  await chrome.storage.session.remove('manualView');
  const next = await rotate(owner,cfg,owner.tabId,owner.pageId,offer.mode,offer.ticket);
  return confirmRemoteMode(next,cfg,new URL(tab.url).pathname);
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
async function identifyPage(tabId, target = {frameId: 0}) {
  try {
    const page = await chrome.tabs.sendMessage(tabId, {type: 'fleet.identify'}, target);
    return page?.pageId ? page : null;
  } catch (err) {
    if (/receiving end does not exist/i.test(err.message)) return null;
    throw err;
  }
}
async function pageForBinding(tabId) {
  const existing = await identifyPage(tabId);
  if (existing) return existing;
  if (!chrome.scripting?.executeScript) throw Error('请在扩展管理页重新加载 Vest Fleet，再绑定当前页面');

  // Tabs opened before an extension load may have no content script for this version.
  try {
    const [frame] = await chrome.scripting.executeScript({
      target: {tabId, frameIds: [0]}, injectImmediately: true, func: () => location.origin
    });
    if (frame?.result !== VEST) throw Error('标签页已离开 Vest，请在目标账户页面重新绑定');
    if (!frame.documentId) throw Error('请刷新当前 Vest 页面，再点击绑定');
    const groups = chrome.runtime.getManifest().content_scripts;
    const target = {tabId, documentIds:[frame.documentId]};
    await chrome.scripting.executeScript({target,world:'MAIN',files:groups.find(group=>group.world==='MAIN').js});
    const files = groups.find(group=>group.world!=='MAIN' && group.matches.includes(VEST+'/*')).js;
    const [attached] = await chrome.scripting.executeScript({
      target: {tabId, documentIds: [frame.documentId]}, injectImmediately: true, files
    });
    const page = await identifyPage(tabId, {documentId: frame.documentId});
    if (page && page.pageId === attached?.result) return page;
  } catch (err) {
    if (/cannot access|host permission|not allowed to access/i.test(err.message))
      throw Error('请在扩展的网站访问权限中允许 next.vestmarkets.com，再点击绑定');
    if (/no (?:tab|document|frame) with|frame .*removed|tab was closed/i.test(err.message))
      throw Error('绑定期间页面已切换，请在目标 Vest 标签页重新绑定');
    throw err;
  }
  throw Error('当前 Vest 页的插件脚本尚未就绪，请刷新页面后重新绑定');
}
async function setBinding(message) {
  let cfg = await settings();
  const previous = await binding();
  if (message.type === 'ui.state') {
    const saved = await chrome.storage.session.get(['diagnostic', 'receiptError','archiveError']);
    const {cardCache} = await chrome.storage.local.get('cardCache');
    return {
      plugin_version: chrome.runtime.getManifest().version,
      label: cfg.label || '',
      paired: !!cfg.token,
      mode: previous?.mode || 'unbound',
      worker_id: cfg.worker_id || '',
      diagnostic: saved.receiptError || saved.archiveError || saved.diagnostic || '',
      cacheCount: cardCache && cardCache.worker_id === cfg.worker_id ? cardCache.items.length : null
    };
  }
  if (message.type === 'ui.refresh') {
    if (!previous) throw Error('请先绑定浏览器');
    await chrome.storage.local.set({cardRequest:crypto.randomUUID()});
    return {ok:true};
  }
  if (message.type === 'ui.readAll') {
    if (!previous || !cfg.token) throw Error('请先绑定浏览器');
    const tab = await chrome.tabs.get(previous.tabId);
    if (!tab.url || new URL(tab.url).origin !== VEST) throw Error('绑定的标签页已离开 Vest');
    return post('read-all',{...publicBinding(previous),page:new URL(tab.url).pathname,id:crypto.randomUUID()},cfg);
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
  const token = message.token || cfg.token;
  const label = String(message.label || '').trim();
  if (!token || token.length < 24 || !label || label.length > 80) throw Error('请填写浏览器名称和插件密钥');
  const page = await pageForBinding(tab.id);
  const current = await chrome.tabs.get(tab.id);
  if (!current.active || !current.url || new URL(current.url).origin !== VEST ||
      (await identifyPage(tab.id))?.pageId !== page.pageId)
    throw Error('绑定期间标签页已切换，请在目标 Vest 标签页重新绑定');
  await chrome.storage.session.remove('manualView');
  cfg = {
    ...cfg,
    token,
    label
  };
  const next = await rotate(previous, cfg, tab.id, page.pageId, message.mode);
  try {
    await post('heartbeat', {
      ...publicBinding(next),
      page: new URL(current.url).pathname
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
    const page = await identifyPage(sender.tab.id);
    if (page?.pageId !== message.pageId) throw Error('旧页面已退出');
    const {cardRoute,noticeRedirect} = await chrome.storage.session.get(['cardRoute','noticeRedirect']);
    const liveReturn = noticeRedirect?.sid === current.session_id && noticeRedirect.from === current.pageId &&
      Date.now() < noticeRedirect.expires && onPath(sender.url,DESTINATIONS.portfolio);
    const expectedDocument = cardRoute?.sid === current.session_id && cardRoute.from === current.pageId &&
      Date.now() < cardRoute.expires && onPath(sender.url,cardRoute.path) &&
      (!cardRoute.startBy || Date.now() < cardRoute.startBy ||
        message.documentStartedAt >= cardRoute.started && message.documentStartedAt <= cardRoute.startBy);
    if (liveReturn || expectedDocument) {
      owner = {...current,pageId:message.pageId};
      await chrome.storage.session.set({binding:owner});
      if (liveReturn) await chrome.storage.session.remove('noticeRedirect');
    } else {
      owner = await rotate(current, cfg, sender.tab.id, message.pageId, 'readonly');
    }
  }
  if (message.session_id && message.session_id !== owner.session_id) throw Error('浏览器授权已变化');
  if (owner.mode_ticket) owner = await confirmRemoteMode(owner,cfg,new URL(sender.url).pathname);
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
  const ack = await post('result', payload, cfg);
  await cacheObservation(payload,payload.result?.observation,ack);
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
    const keys = chrome.storage.local.getKeys ? await chrome.storage.local.getKeys() : Object.keys(await chrome.storage.local.get(null));
    if (archiveSupported) deliverArchive(keys.filter(key=>key.startsWith('archive.')),cfg)
      .catch(err=>chrome.storage.session.set({archiveError:'历史归档等待重传：'+err.message}));
    const pending = keys.filter(key=>key.startsWith('receipt.'));
    const stored = pending.length ? await chrome.storage.local.get(pending) : {};
    let receiptError = '';
    for (const [key, payload] of Object.entries(stored)) {
      if (!key.startsWith('receipt.')) continue;
      try {
        const ack = await post('result', payload, cfg);
        await cacheObservation(payload,payload.result?.observation,ack);
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
    if (!confirmedPath(tab.url)) {
      await chrome.storage.session.set({manualView:{tabId:owner.tabId,path:dest}});
      await chrome.tabs.update(owner.tabId,{url:VEST+dest});
    }
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
function onPath(value,path) {
  const url = new URL(value);
  const actual = url.pathname.replace(/\/$/,'');
  return url.origin === VEST && !url.search && !url.hash && (actual === path ||
    path === DESTINATIONS.trade && actual === '/trade/NDX-USD-PERP');
}
async function startRoute(owner,url,path,work) {
  // A Vest SPA navigation can leave MessageSender.url pointing to the original route.
  const tab=await chrome.tabs.get(owner.tabId);
  if (!tab.url || new URL(tab.url).origin!==VEST) throw Error('绑定标签页已离开 Vest');
  const started=Date.now(), startBy=started+ROUTE_START_WINDOW;
  // A document that started on time may load slowly. Read-only work can still use its original lease.
  const expires=READ_ROUTES.has(work.command?.action) && Number.isFinite(work.run_until) ? work.run_until*1000 : startBy;
  const route = {sid:owner.session_id,from:owner.pageId,path,started,startBy,expires,work};
  await chrome.storage.session.set({cardRoute:route});
  try {
    if (!tab.pendingUrl && onPath(tab.url,path) && onPath(url,path)) await chrome.tabs.reload(owner.tabId);
    else await chrome.tabs.update(owner.tabId,{url:VEST+path});
  } catch (err) {
    await chrome.storage.session.remove('cardRoute');
    throw err;
  }
  return {moving:true};
}
async function nativeDirectory(tabId,documentId,scope,priorId='') {
  const target=documentId ? {tabId,documentIds:[documentId]} : {tabId,frameIds:[0]};
  const [frame]=await chrome.scripting.executeScript({world:'MAIN',target,
    func:(view,id)=>window.vestFleetSnapshotsV2?.(view,id) ?? null,args:[scope,priorId]});
  return frame?.result ?? null;
}
const stagedArchive = new Map();
async function stageArchive(owner,documentId) {
  const target={tabId:owner.tabId,documentIds:[documentId]};
  for (let i=0;i<8;i++) {
    const [frame]=await chrome.scripting.executeScript({world:'MAIN',target,
      func:()=>window.vestFleetReadArchiveV1?.() ?? null});
    const batch=frame?.result;
    if (!batch) return {more:false};
    if (!Number.isSafeInteger(batch.seq) || !Array.isArray(batch.items) || batch.items.length>50) throw Error('历史归档批次无效');
    const changes=[];
    for (const item of batch.items) {
      const id=JSON.stringify([owner.worker_id,item.kind,item.source_account_id,item.ref]);
      const signature=JSON.stringify(item);
      if (stagedArchive.get(id)!==signature) changes.push({id,signature,item});
    }
    if (changes.length) {
      const key='archive.'+owner.pageId+'.'+batch.seq;
      await chrome.storage.local.set({[key]:{worker_id:owner.worker_id,session_id:owner.session_id,generation:owner.generation,items:changes.map(c=>c.item)}});
      for (const {id,signature} of changes) {
        stagedArchive.set(id,signature);
        if (stagedArchive.size>5000) stagedArchive.delete(stagedArchive.keys().next().value);
      }
    }
    const [ack]=await chrome.scripting.executeScript({world:'MAIN',target,
      func:seq=>window.vestFleetReadArchiveV1?.(seq),args:[batch.seq]});
    if (!ack?.result) return {more:false};
  }
  return {more:true};
}
let archiveDelivery, archiveSupported=false;
async function deliverArchive(keys,cfg) {
  if (archiveDelivery || !keys.length) return;
  archiveDelivery=true;
  try {
    for (const key of keys.slice(0,8)) {
      const payload=(await chrome.storage.local.get(key))[key];
      if (payload?.worker_id!==cfg.worker_id) continue;
      if ((await post('archive',payload,cfg)).accepted) await chrome.storage.local.remove(key);
    }
    await chrome.storage.session.remove('archiveError');
  } finally {archiveDelivery=false;}
}
async function directoryRoute(owner,url,work,since) {
  if (onPath(url,DESTINATIONS.accounts)) {
    for (let i=0;i<4;i++) {
      const timing=await nativeDirectory(owner.tabId,undefined,true);
      if (work.command?.action==='accounts.read_all' && timing && timing.bulk_version!==1) break;
      const now=Date.now()/1000;
      const action=work.command?.action;
      const positionsReady=action==='accounts.list' ? timing?.position_at>=since && now-timing.position_at<=30 :
        action!=='accounts.read_all' || timing?.position_at>=since && now-timing.position_at<=90;
      if (timing?.at!=null && timing.at>=since && now-timing.at<=330 && positionsReady ||
          timing?.pending_at!=null && timing.pending_at>=since && now-timing.pending_at<=12) return null;
      if (i<3) await new Promise(resolve=>setTimeout(resolve,250));
    }
  }
  return startRoute(owner,url,DESTINATIONS.accounts,{...work,arrived:true,directory_since:since});
}
async function pollWork(owner,cfg,meta,url,documentId,historyPending,noticeKind) {
  if ((await binding())?.session_id !== owner.session_id) throw Error('绑定已变化');
  await drain(cfg);
  const saved = await chrome.storage.session.get(['cardRoute','cardVisit','returnCards','portfolioUntil','cachedScan']);
  const route = saved.cardRoute;
  let data;
  if (route) {
    if (route.sid === owner.session_id && Date.now() < route.expires) {
      if (route.from === owner.pageId || !onPath(url,route.path)) return {moving:true};
      data = route.work;
    } else if (route.work.command) {
      await persistReceipt({...route.work.owner,id:route.work.command.id,ok:false,error:'页面跳转未完成或授权已变化',
        result:READ_ROUTES.has(route.work.command.action) ? {read_retry:'navigation'} : {}},cfg);
    }
    await chrome.storage.session.remove('cardRoute');
  }
  if (!data) {
    const {manualView} = await chrome.storage.session.get('manualView');
    const manual = owner.mode==='readonly' && manualView?.tabId===owner.tabId && onPath(url,manualView.path);
    data = await post('poll',{...meta,notice_kind:noticeKind,manual_view:manual,cached_scan:saved.cachedScan?.sid===owner.session_id ? saved.cachedScan.id : null},cfg);
    archiveSupported=data.archive_version===1;
  }
  if (data.mode_request) return data;
  if (archiveSupported && documentId && historyPending) {
    try {await stageArchive(owner,documentId);}
    catch (err) {await chrome.storage.session.set({archiveError:'历史归档等待保存：'+err.message});}
  }
  if (data.update_release) return data;
  const cmd = data.command;
  if (data.notice) return data;
  if (cmd?.action === 'page.navigate') return data;
  if (cmd) {
    const scan = cmd.action === 'accounts.read_all';
    const directory = cmd.action === 'accounts.list' || scan && data.scan?.stage === 'list';
    const payout = cmd.action==='profit.available' || cmd.action==='profit.withdraw';
    const path = directory || scan ? DESTINATIONS.accounts : payout ? DESTINATIONS.portfolio : DESTINATIONS.trade;
    if (cmd.action==='account.read' && cmd.read_card_id && data.arrived && !data.renewedBalance &&
        Date.now()-route?.started>15000 && data.run_until*1000-Date.now()>15000) {
      const timing=await nativeDirectory(owner.tabId,documentId,true);
      if (timing?.trade_at>0 && Date.now()/1000-timing.trade_at>15)
        return startRoute(owner,url,path,{...data,renewedBalance:true,owner:publicBinding(owner)});
    }
    if (scan) await chrome.storage.session.set({returnCards:owner.session_id});
    if (directory && !data.arrived) {
      data.directory_since=Math.max(data.directory_since || 0, cmd.created_at-(scan ? 320 : 0));
      const moving=await directoryRoute(owner,url,{...data,owner:publicBinding(owner)},data.directory_since);
      if (moving) return moving;
    } else if (!data.arrived) {
      let move=!onPath(url,path);
      if (!move && (cmd.action==='order.open' || cmd.action==='account.read' && cmd.read_card_id)) {
        const timing=await nativeDirectory(owner.tabId,documentId,true), now=Date.now()/1000;
        move=!(timing?.trade_at>=now-6 && timing.at>=now-315);
      }
      if (move) return startRoute(owner,url,path,{...data,arrived:true,owner:publicBinding(owner)});
    }
    const lease = {...owner,action:cmd.action};
    if (cmd.action==='history.read') {
      Object.assign(lease,{command:cmd,run_until:data.run_until,stage:data.continuation?.stage || 'trade'});
    }
    await chrome.storage.session.set({['lease.'+cmd.id]:lease});
    return data;
  }
  const {cardRequest} = await chrome.storage.local.get('cardRequest');
  const generation = data.refresh_cards ?? data.card_generation ?? 0;
  if (data.refresh_cards !== undefined || cardRequest || data.forceCards) {
    const key = JSON.stringify([owner.session_id,generation,cardRequest || '']);
    const since=Math.max(generation/1e6,Number(cardRequest) || 0,data.directory_since || 0);
    if (!data.arrived && (saved.cardVisit !== key || !onPath(url,DESTINATIONS.accounts))) {
      const moving=await directoryRoute(owner,url,{forceCards:true,refresh_cards:generation},since);
      if (moving) {
        await chrome.storage.session.set({cardVisit:key});
        return moving;
      }
    }
    await chrome.storage.session.set({cardVisit:key});
    return {refresh_cards:generation,purchase_request:cardRequest,directory_since:since};
  }
  if (saved.returnCards === owner.session_id) {
    if (onPath(url,DESTINATIONS.portfolio) && Date.now()<saved.portfolioUntil) return data;
    await chrome.storage.session.remove(['returnCards','portfolioUntil']);
    if (!onPath(url,DESTINATIONS.accounts))
      return startRoute(owner,url,DESTINATIONS.accounts,{arrived:true,card_generation:generation});
  }
  return data;
}
async function continueCommand(owner, url, {id,continuation}) {
  const lease = (await chrome.storage.session.get('lease.'+id))['lease.'+id];
  if (lease?.session_id !== owner.session_id || lease.pageId !== owner.pageId || lease.tabId !== owner.tabId ||
      !lease.command || Date.now() >= lease.run_until*1000 || (await binding())?.session_id !== owner.session_id)
    throw Error('跨页指令租约已失效');
  const toPortfolio = lease.stage==='trade' && continuation?.stage==='portfolio' && onPath(url,DESTINATIONS.trade);
  if (lease.action!=='history.read' || !toPortfolio) throw Error('不允许此指令跳转步骤');
  return startRoute(owner,url,DESTINATIONS.portfolio,
    {command:lease.command,owner:publicBinding(owner),run_until:lease.run_until,arrived:true,continuation});
}
let pendingMetricRisks = new Map();
async function cacheObservation(owner, item, data) {
  if (!item || !data.risk || (await binding())?.session_id!==owner.session_id) return;
  const {cardCache} = await chrome.storage.local.get('cardCache');
  if (cardCache?.worker_id!==owner.worker_id) return;
  pendingMetricRisks.delete(item.name);
  (cardCache.risks ??= {})[item.name] = data.risk;
  if ('daily_floor' in data) (cardCache.floors ??= {})[item.name] = data.daily_floor;
  if ('open_lock' in data) (cardCache.open_locks ??= {})[item.name] = data.open_lock;
  if (data.portfolio) (cardCache.portfolios ??= {})[item.name] = data.portfolio;
  await chrome.storage.local.set({cardCache});
}
async function reportCards(owner,cfg,payload) {
  const bound = await binding();
  if (bound?.session_id !== owner.session_id || bound.pageId !== owner.pageId) throw Error('提交清单的页面已更换');
  const cards = payload.cards;
  const data = await post('report',payload,cfg);
  if (data.retained_counts) {
    for (const item of cards.items) {
      if (Object.hasOwn(data.retained_counts,item.id)) item.active_positions=data.retained_counts[item.id];
    }
  }
  pendingMetricRisks.clear();
  try {
    await chrome.storage.local.set({cardCache:{worker_id:owner.worker_id,items:cards.items,risks:data.risks,
      portfolios:data.portfolios || {},floors:data.floors || {},open_locks:data.open_locks || {},observed_at:cards.observed_at}});
    if (cards.scan_id) await chrome.storage.session.set({cachedScan:{sid:owner.session_id,id:cards.scan_id}});
  } catch (err) {
    if (cards.scan_id) {
      await post('result',{...publicBinding(owner),id:cards.scan_id,ok:false,result:{},error:'无法写入本次账户列表缓存'},cfg);
    }
    throw err;
  }
  if (cards.scan_id) await chrome.storage.session.remove('lease.'+cards.scan_id);
  if (cards.full && cards.purchase_request && (await chrome.storage.local.get('cardRequest')).cardRequest===cards.purchase_request)
    await chrome.storage.local.remove('cardRequest');
  return {supports_metrics:data.supports_metrics,supports_position_totals:data.supports_position_totals,retained_counts:data.retained_counts};
}
async function reportMetrics(owner,cfg,payload) {
  // The complete DOM sample stays in the browser. Only the numeric changes cross the bridge.
  const {localItems, ...wire} = payload;
  const current = await binding();
  if (current?.session_id !== owner.session_id || current.pageId !== owner.pageId) throw Error('监控页面已更换');
  const ack = await post('report',wire,cfg);
  for (const [name,risk] of Object.entries(ack.risks || {})) pendingMetricRisks.set(name,risk);
  if (localItems) {
    const {cardCache} = await chrome.storage.local.get('cardCache');
    if (cardCache?.worker_id === owner.worker_id) {
      Object.assign(cardCache.risks, Object.fromEntries(pendingMetricRisks));
      await chrome.storage.local.set({cardCache:{...cardCache,items:localItems,observed_at:ack.observed_at}});
    }
    pendingMetricRisks.clear();
  }
  return {observed_at:ack.observed_at};
}
async function handle(message, sender) {
  if (sender.id !== chrome.runtime.id) throw Error('无效的消息来源');
  if (message.type?.startsWith('ui.') && sender.url === chrome.runtime.getURL('popup.html')) {
    return exclusive(() => setBinding(message));
  }
  if (!sender.tab || sender.frameId !== 0 || new URL(sender.url).origin !== VEST) throw Error('无效的执行页面');
  if (message.type === 'purchase.ready') {
    await exclusive(()=>chrome.storage.local.set({cardRequest:Date.now()/1000}));
    return {ok:true};
  }
  // Revoking execution prevents new clicks. Its original document can still return a receipt.
  if (message.type === 'result') {
    const key = 'lease.' + message.data.id;
    const owner = (await chrome.storage.session.get(key))[key];
    if (!owner || owner.tabId !== sender.tab.id || owner.pageId !== message.pageId || owner.session_id !== message.session_id) throw Error('没有属于该页面的指令租约');
    if (owner.action !== 'accounts.list') {
      // Allow the center to consume a positive quote and send the claim on this same document.
      const hold=owner.mode==='execute' && owner.action==='profit.available' && message.data.ok && message.data.result?.available>0;
      await chrome.storage.session.set({returnCards:owner.session_id,portfolioUntil:hold ? Date.now()+180000 : 0});
    }
    const cfg = await settings();
    await exclusive(()=>persistReceipt({
      ...message.data,
      ...publicBinding(owner)
    }, cfg));
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
  const op = message.type;
  if (op==='native.accounts') {
    if (message.session_id!==owner.session_id || !sender.documentId) throw Error('账户快照会话已变化');
    const scope=message.data?.scope;
    const view = ['selected','bulk','inventory','notice','payout'].includes(scope) ? scope : 'directory';
    const data=await nativeDirectory(owner.tabId,sender.documentId,view,message.data.platform_id || '');
    if ((scope==='bulk' || scope==='inventory') && data?.rows) {
      const {cardCache}=await chrome.storage.local.get('cardCache');
      if (cardCache?.worker_id===owner.worker_id) {
        const names=new Map(cardCache.items.map(item=>[item.id,item.name]));
        for (const row of data.rows) row.name=names.get(row.id) || row.name;
      }
    }
    return {bound:true,data};
  }
  if (op==='archive.stage') {
    if (message.session_id!==owner.session_id || !sender.documentId) throw Error('历史采集会话已变化');
    return exclusive(()=>stageArchive(owner,sender.documentId));
  }
  if (!['intent', 'preflight', 'poll', 'report', 'heartbeat','continue','notice.reserve','notice.complete','notice.recheck'].includes(op)) throw Error('未知插件接口');
  if (['intent','preflight','notice.reserve','notice.complete','notice.recheck'].includes(op) && (!message.session_id || owner.mode !== 'execute')) throw Error('执行授权已撤销');
  const pageUrl=(await chrome.tabs.get(owner.tabId)).url;
  if (!pageUrl || new URL(pageUrl).origin!==VEST) throw Error('绑定标签页已离开 Vest');
  const meta = {...publicBinding(owner),page:new URL(pageUrl).pathname,
    error:String(message.diagnostic || '').replace(/\s+/g,' ').slice(0,500)};
  const payload = {
    ...message.data,
    ...meta
  };
  let data;
  if (op==='notice.recheck') return exclusive(async()=>{
    const key=JSON.stringify([owner.session_id,message.data.platform_id,message.data.started]);
    if ((await chrome.storage.session.get('noticeRecheck')).noticeRecheck!==key &&
        (await binding())?.session_id===owner.session_id) {
      await chrome.storage.session.set({noticeRecheck:key});
      await startRoute(owner,pageUrl,DESTINATIONS.accounts,{});
    }
    return {bound:true};
  });
  if (op === 'poll') data = await exclusive(() => pollWork(owner,cfg,meta,pageUrl,sender.documentId,message.data.history_pending,message.data.notice_kind));
  else if (op === 'continue') data = await exclusive(() => continueCommand(owner,pageUrl,message.data));
  else if (op === 'report' && payload.cards) data = await exclusive(() => reportCards(owner,cfg,payload));
  else if (op === 'report' && payload.metrics) data = await exclusive(() => reportMetrics(owner,cfg,payload));
  else data = await post(op,payload,cfg);
  if ((op === 'poll' || op === 'heartbeat') && data.mode_request) {
    const next = await exclusive(()=>applyRemoteMode(owner,cfg,data.mode_request));
    return {bound:true,session:publicBinding(next),data:{command:null}};
  }
  if (op==='notice.reserve' && data.authorize && payload.kind==='live')
    await chrome.storage.session.set({noticeRedirect:{sid:owner.session_id,from:owner.pageId,expires:Date.now()+20000}});
  if (op==='notice.complete') {
    await chrome.storage.session.remove('noticeRedirect');
    await chrome.storage.local.set({cardRequest:Date.now()/1000});
  }
  if (data.risk && (payload.observation || payload.portfolio)) {
    await exclusive(()=>cacheObservation(owner,payload.observation || payload.portfolio,data));
  }
  if (payload.portfolio && data.status !== 'running')
    await chrome.storage.session.remove('lease.'+payload.portfolio.id);
  if (op === 'intent' && data.authorize_click === true) {
    await exclusive(() => reserveClick(owner, message.data.id, message.data.stage));
  }
  if (op === 'poll' && data.update_release) {
    await exclusive(() => checkRelease(data.update_release)).catch(() => {});
  }
  if (op === 'poll' && data.command?.action === 'page.navigate') {
    await navigate(data.command, owner, cfg);
    data.command = null;
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
