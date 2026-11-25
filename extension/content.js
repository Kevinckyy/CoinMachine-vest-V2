(() => {
  'use strict';

  // Both the manifest and a manual bind can attach this bundle to the same document.
  const prior = globalThis.vestFleetPage;
  if (prior && chrome.runtime.onMessage.hasListener(prior.listener)) return prior.pageId;
  const pageId = crypto.randomUUID();
  let session = null,
    cycleSession = null,
    job = null,
    lastContact = 0,
    diagnostic = '';
  let nextCards = 0, directory = null, monitoring = false,
    working = false,
    heartbeatBusy = false;
  let runUntil = 0;
  let archivePending = true, archiveEnabled = false, archiveBusy = false;
  window.addEventListener('vest-fleet-archive-ready',()=>{archivePending=true; stageArchive();});
  async function stageArchive() {
    if (!session || !archiveEnabled || !archivePending || archiveBusy) return;
    archiveBusy=true;
    archivePending=false;
    try {
      const value=await ipc('archive.stage',{},session);
      if (value?.more) archivePending=true;
    } catch { archivePending=true; }
    finally {archiveBusy=false;}
  }
  const brief = err => String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 500);
  function invalidate() {
    session = null;
    lastContact = 0;
    nextCards = 0;
    directory = null;
    monitoring = false;
    archivePending = true;
    archiveEnabled = false;
  }
  function onFleetMessage(message, sender, reply) {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === 'fleet.identify') reply({
      pageId, plugin_version: chrome.runtime.getManifest().version
    });
    if (message.type === 'fleet.revoke') {
      if (!session || message.session_id === session.session_id) invalidate();
      reply({
        ok: true
      });
    }
  }
  async function ipc(type, data = {}, owner = cycleSession) {
    const response = await chrome.runtime.sendMessage({
      type,
      data,
      diagnostic,
      pageId,
      documentStartedAt:performance.timeOrigin,
      session_id: owner?.session_id
    });
    if (!response?.ok) throw Error(response?.error || '本机桥无响应');
    return response.value;
  }
  function guard(write = false) {
    if (!chrome.runtime.id || !session || cycleSession?.session_id !== session.session_id || Date.now() - lastContact > 16000 || write && session.mode !== 'execute') throw Error('页面连接或执行授权失效');
    if (job && Date.now() >= runUntil) throw Error('本次指令的执行时间窗已结束');
  }
  async function report(data) {
    guard();
    const value = await ipc('report', data);
    if (!value.bound) throw Error('标签页已解除绑定');
    lastContact = Date.now();
    guard();
    return value.data;
  }
  const page = globalThis.VestPage.create({
    guard,
    report,
    nativeAccounts,
    preflight: async (observation,quantity) => {
      guard(true);
      const value = await ipc('preflight',{id:job.id,observation,quantity});
      if (!value.data.approved) throw Object.assign(Error(value.data.reason || '候选账户需重新决策'),{reselect:value.data.reselect});
      return value.data;
    },
    intent: async (stage, proof, observation, allowRefill = false) => {
      guard(true);
      const value = await ipc('intent', {
        id: job.id,
        stage,
        proof, observation, allow_refill: allowRefill
      });
      guard(true);
      if (stage === 'open' && allowRefill && value.data?.refill && !value.data.authorize_click) return value.data;
      if (value.data?.authorize_click !== true) throw Object.assign(Error(value.data?.reason || '该操作未获许可或已提交'),{reselect:value.data?.reselect});
      return value.data;
    }
  });
  async function nativeAccounts(scope='directory',platformId) {
    const reply=await ipc('native.accounts',{scope,platform_id:platformId});
    guard();
    return reply.bound ? reply.data : null;
  }
  async function readBulk(since) {
    const until=Date.now()+10000;
    let reading;
    do {
      const source=await nativeAccounts('bulk'), now=Date.now()/1000;
      if (source?.at>=since && now-source.at<=330 && Array.isArray(source.rows)) {
        const details=source.rows.map(row=>({id:row.id,values:VestBridgeCore.bulkCapitalValues(row,source.at,now)}));
        const items=source.rows.map(({id,name,phase,category,active_positions},index)=>{
          const card={id,name,phase,category,active_positions}, v=details[index].values;
          if (now-v.observed_at<=90) {
            for (const field of ['equity','health','daily_loss','daily_limit','drawdown','drawdown_limit'])
              if (v[field]!=null) card[field]=v[field];
          }
          return card;
        });
        reading={source,items,observed_at:now,source_at:source.at,details};
        if (source.rows.every(row=>row.equity!=null) || Date.now()+350>=until) return reading;
      } else reading=null;
      await new Promise(resolve=>setTimeout(resolve,300));
    } while(Date.now()<until);
    if (reading) return reading;
    throw Error('没有可核验的完整活动账户响应');
  }
  async function observe(data, force = false, scanId) {
    if (location.pathname.replace(/\/$/,'') !== '/accounts' || data.moving) return;
    const generation = data.refresh_cards ?? data.card_generation ?? 0;
    if (!force && data.refresh_cards===undefined && document.querySelector(
      '[role="tab"][id$="-trigger-history"][aria-selected="true"],[role="tab"][id$="-trigger-closed"][aria-selected="true"]')) return;
    const full = force || data.refresh_cards !== undefined || !directory || directory.generation !== generation;
    const directoryDue = full || Date.now() >= nextCards;
    if (!directoryDue && !monitoring) return;
    let reading;
    try {
      if (scanId) {
        reading=await readBulk(data.directory_since);
      } else {
        // A single sample suffices for prices. Confirm directory changes on two stable DOM samples.
        const cards = !full && VestCards.sample(false);
        const source = !full && directoryDue ? await nativeAccounts() : null;
        const cached = directoryDue ? source : directory?.source;
        const sample = cards && cached && VestCards.nativeItems(cached,cards,directory?.byId);
        if (sample && Date.now()/1000-cached.at<=330 && VestCards.membership(sample) === directory.signature) {
          reading = {items:sample,observed_at:Date.now()/1000,source_at:cached.at,source:cached};
          if (source) directory.source=source;
        } else if (sample || directoryDue) {
          reading = await VestCards.read(full,guard,nativeAccounts,directory?.byId,data.directory_since || 0,force && !!job && job.action==='accounts.list');
        } else return;
      }
    } catch (err) {
      if (scanId) await ipc('result',{id:scanId,ok:false,result:{},error:'拉取账户列表失败：'+brief(err).slice(0,460)});
      throw err;
    }
    const signature = VestCards.membership(reading.items);
    const changedList = signature !== directory?.signature;
    const positionAt=reading.source?.position_at;
    const positionSample=positionAt>0 && Number.isSafeInteger(reading.source.position_count) && Date.now()/1000-positionAt<=90 &&
      (full || changedList || directory?.supportsPositionTotals && positionAt!==directory.positionAt)
      ? {at:positionAt,count:reading.source.position_count} : null;
    const positions=positionSample ? {positions:positionSample} : {};
    if (full || changedList || !directory.supportsMetrics) {
      const {source,details,...cardReading}=reading;
      const ack = await report({cards:{...cardReading,...positions,generation,full:full || changedList,
        purchase_request:data.purchase_request,...(scanId ? {scan_id:scanId,details,sources:source.sources} : {})}});
      directory = {signature,generation,source,byId:new Map(reading.items.map(x=>[x.id,x])),
        baseline:VestCards.index(reading.items),supportsMetrics:ack?.supports_metrics===true,
        supportsPositionTotals:ack?.supports_position_totals===true};
    } else {
      const items = VestCards.changes(reading.items,directory.baseline,directoryDue);
      await report({metrics:{items,...positions,base_at:directory.observedAt,observed_at:reading.observed_at,generation,directory:directoryDue},
        ...(directoryDue ? {localItems:reading.items} : {})});
      for (const patch of items) Object.assign(directory.baseline.get(patch.name),patch);
    }
    directory.observedAt = reading.observed_at;
    if (positionSample) directory.positionAt=positionAt;
    monitoring = directory.supportsMetrics && reading.items.some(a=>a.active_positions>0);
    if (directoryDue || changedList) nextCards = Date.now()+8000;
    diagnostic = '';
    if (!force) return;
    const counts = new Map();
    for (const item of reading.items) counts.set(item.name,(counts.get(item.name) || 0)+1);
    const inventory = reading.items.map(({id,name,category,phase})=>({id,name,category,phase,ambiguous:counts.get(name)>1}));
    return {source:'accounts',source_at:reading.source_at,full:true,count:inventory.length,inventory};
  }
  async function cycle() {
    const started = performance.now();
    let cadence = 1500;
    try {
      const noticeKind = VestAccountNotices.inspect()?.kind;
      const value = await ipc('poll', {history_pending:archivePending,notice_kind:noticeKind}, null);
      if (!value.bound) {
        invalidate();
        cadence = 3500;
        return;
      }
      if (session?.session_id !== value.session.session_id) invalidate();
      session = cycleSession = value.session;
      if (value.data.archive_version===1) archiveEnabled=true;
      await stageArchive();
      lastContact = Date.now();
      working = true;
      job = value.data.command;
      runUntil = (value.data.run_until || 0) * 1000;
      if (value.data.notice) {
        diagnostic = await VestAccountNotices.handle(value.data.notice,{guard,native:nativeAccounts,
          send:async (op,data) => (await ipc(op,data)).data});
        return;
      }
      if (!job) {
        await observe(value.data);
        if (monitoring && location.pathname.replace(/\/$/,'') === '/accounts') cadence = 1000;
        return;
      }
      if (job.session_id !== cycleSession.session_id || job.worker_id !== cycleSession.worker_id) throw Error('指令目标与当前浏览器不一致');
      if (job.action === 'accounts.read_all') {
        const step = value.data.scan;
        if (step?.stage === 'list') {
          await observe(value.data,true,job.id);
        } else if (step?.stage === 'portfolio' && step.target) {
          await ipc('result',{id:job.id,ok:false,result:{},error:'节点桥需要更新才能批量读取账户响应'});
        } else throw Error('无法识别全量读取步骤');
        return;
      }
      let result = {},
        error = '';
      try {
        result = job.action==='accounts.list' ? await observe(value.data,true) : await page.execute(job,value.data.continuation);
        if (result?.continuation) {
          guard(job.action==='profit.withdraw');
          await ipc('continue',{id:job.id,continuation:result.continuation});
          return;
        }
      } catch (err) {
        error = brief(err);
        if (job.action==='account.read' && err.readRetry==='balance') result.read_retry='balance';
        if (err.noticeKind && job.action==='order.open' && job.source?.startsWith('strategy-'))
          result.notice_kind = err.noticeKind;
        if (err.snapshot) result = {
          observation: {
            name: job.account,
            phase: job.phase,
            snapshot: err.snapshot
          }
        };
      }
      diagnostic = error;
      await ipc('result', {
        id: job.id,
        ok: !error,
        result,
        error
      });
    } catch (err) {
      diagnostic = brief(err);
      invalidate();
      cadence = 3000;
    } finally {
      working = false;
      job = cycleSession = null;
      if (chrome.runtime.id) setTimeout(cycle, cadence === 1000 ? Math.max(0,cadence-(performance.now()-started)) : cadence);
    }
  }
  setInterval(async () => {
    if (!working || !session || heartbeatBusy) return;
    heartbeatBusy = true;
    try {
      const value = await ipc('heartbeat');
      if (!value.bound || value.session.session_id !== session?.session_id) invalidate();else lastContact = Date.now();
    } catch {
      invalidate();
    } finally {
      heartbeatBusy = false;
    }
  }, 5000);
  // A confirmed purchase can appear in another Vest tab in this browser profile.
  let announced = null;
  const ready = /^(?:Your (?:\d+ )?Funded Accounts? (?:is|are) ready to trade|Your new account is ready\. You can start trading now|您的新账户已准备就绪，现在可以开始交易|您的\s*(?:\d+\s*个\s*)?Funded Account\s*已可交易|账户购买成功|Account purchased successfully)[.!。]?$/i;
  const successText = /ready to trade|start trading now|开始交易|已可交易|购买成功|purchased successfully/i;
  const notice = '[role="dialog"] p,[role="alert"],[role="status"],[data-sonner-toast] p,main p';
  function checkPurchase(node) {
    if (!successText.test(node.textContent || '')) return;
    const root = node.nodeType===Node.ELEMENT_NODE ? node : node.parentElement;
    if (!root) return;
    const found = [root.closest(notice),...root.querySelectorAll(notice)].filter(Boolean).find(el =>
      el.getClientRects().length && ready.test(VestBridgeCore.normalized(el.innerText)));
    if (found && found!==announced) {
      announced=found;
      chrome.runtime.sendMessage({type:'purchase.ready'}).catch(()=>{});
    }
  }
  const purchases = new MutationObserver(changes => {
    if (!chrome.runtime.id) return;
    if (announced && (!announced.isConnected || !ready.test(VestBridgeCore.normalized(announced.textContent)))) announced=null;
    for (const change of changes) {
      if (change.type==='characterData') checkPurchase(change.target);
      else for (const node of change.addedNodes) checkPurchase(node);
    }
  });
  function start() {
    purchases.observe(document,{childList:true,subtree:true,characterData:true});
    if (document.body) checkPurchase(document.body);
    cycle();
  }
  chrome.runtime.onMessage.addListener(onFleetMessage);
  globalThis.vestFleetPage = {pageId, listener: onFleetMessage};
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',start,{once:true});
  else start();
  return pageId;
})();
