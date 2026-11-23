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
  let nextCards = 0, membership,
    working = false,
    heartbeatBusy = false;
  let runUntil = 0;
  const brief = err => String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 500);
  function invalidate() {
    session = null;
    lastContact = 0;
    nextCards = 0;
  }
  function onFleetMessage(message, sender, reply) {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === 'fleet.identify') reply({
      pageId
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
  }
  const page = globalThis.VestPage.create({
    guard,
    report,
    preflight: async (observation,quantity) => {
      guard(true);
      const value = await ipc('preflight',{id:job.id,observation,quantity});
      if (!value.data.approved) throw Error(value.data.reason || '候选账户需重新决策');
      return value.data;
    },
    intent: async (stage, proof, observation) => {
      guard(true);
      const value = await ipc('intent', {
        id: job.id,
        stage,
        proof, observation
      });
      guard(true);
      if (value.data?.authorize_click !== true) throw Error('该操作未获许可或已提交');
    }
  });
  async function observe(data, force = false) {
    if (location.pathname.replace(/\/$/,'') !== '/accounts' || data.moving) return;
    const full = force || data.refresh_cards !== undefined;
    if (!full && Date.now() < nextCards) return;
    nextCards = Date.now()+8000;
    if (membership === undefined) {
      const {cardCache} = await chrome.storage.local.get('cardCache');
      membership = cardCache?.worker_id===session.worker_id ? VestCards.membership(cardCache.items) : null;
    }
    const reading = await VestCards.read(full,guard);
    const signature = VestCards.membership(reading.items);
    await report({cards:{...reading,generation:data.refresh_cards ?? data.card_generation ?? 0,
      full:full || membership!==signature,purchase_request:data.purchase_request}});
    membership = signature;
    diagnostic = '';
    if (!force) return;
    const counts = new Map();
    for (const item of reading.items) counts.set(item.name,(counts.get(item.name) || 0)+1);
    const inventory = reading.items.map(({name,category,phase})=>({name,category,phase,ambiguous:counts.get(name)>1}));
    return {source:'accounts',full:true,count:inventory.length,inventory};
  }
  async function cycle() {
    let cadence = 1500;
    try {
      const value = await ipc('poll', {}, null);
      if (!value.bound) {
        invalidate();
        cadence = 3500;
        return;
      }
      if (session?.session_id !== value.session.session_id) invalidate();
      session = cycleSession = value.session;
      lastContact = Date.now();
      working = true;
      job = value.data.command;
      runUntil = (value.data.run_until || 0) * 1000;
      if (!job) {
        await observe(value.data);
        return;
      }
      let result = {},
        error = '';
      try {
        if (job.session_id !== cycleSession.session_id || job.worker_id !== cycleSession.worker_id) throw Error('指令目标与当前浏览器不一致');
        result = job.action==='accounts.list' ? await observe(value.data,true) : await page.execute(job);
      } catch (err) {
        error = brief(err);
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
      if (chrome.runtime.id) setTimeout(cycle, cadence);
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
