(() => {
  'use strict';

  const pageId = crypto.randomUUID();
  let session = null,
    cycleSession = null,
    job = null,
    lastContact = 0,
    diagnostic = '';
  let inventory = [],
    nextInventory = 0,
    nextAccount = 0,
    working = false,
    heartbeatBusy = false;
  let runUntil = 0;
  const historyDue = new Map(), payoutDue = new Map();
  let nextPortfolio = 0;
  const brief = err => String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 500);
  function invalidate() {
    session = null;
    lastContact = 0;
    nextInventory = 0;
    inventory = [];
    historyDue.clear();
    payoutDue.clear();
    nextPortfolio = 0;
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
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
  });
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
    intent: async (stage, proof) => {
      guard(true);
      const value = await ipc('intent', {
        id: job.id,
        stage,
        proof
      });
      guard(true);
      if (value.data?.authorize_click !== true) throw Error('该操作未获许可或已提交');
    }
  });
  async function observe() {
    if (!VestBridgeCore.isNqTradePath(location.pathname)) {
      diagnostic = '当前位于持仓或其他页面，可下达跳转交易页指令';
      return;
    }
    if (Date.now() >= nextInventory) {
      inventory = await page.list();
      await report({
        inventory
      });
      nextInventory = Date.now() + 45000;
    }
    const usable = inventory.filter(item => !item.ambiguous);
    if (!usable.length) return;
    const account = usable[nextAccount++ % usable.length];
    let observation;
    try {
      observation = await page.read(account.name, account.category);
      await report({
        observation
      });
      diagnostic = '';
    } catch (err) {
      diagnostic = brief(err);
      await report({
        observation: {
          name: account.name,
          error: diagnostic
        }
      });
      return;
    }
    if (Date.now() >= (historyDue.get(account.name) || 0)) {
      historyDue.set(account.name, Date.now() + 60000);
      try {
        await page.history(account.name);
      } catch (err) {
        diagnostic = '历史读取 · ' + brief(err);
      }
    }
    if (observation.phase === 'live' && Date.now() >= nextPortfolio && Date.now() >= (payoutDue.get(account.name) || 0)) {
      nextPortfolio = Date.now() + 30000;
      payoutDue.set(account.name, Date.now() + 15 * 60000);
      try {
        await page.payoutHistory(account.name, false);
      } catch (err) {
        diagnostic = '出金历史读取 · ' + brief(err);
      }
    }
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
        await observe();
        return;
      }
      let result = {},
        error = '';
      try {
        if (job.session_id !== cycleSession.session_id || job.worker_id !== cycleSession.worker_id) throw Error('指令目标与当前浏览器不一致');
        result = await page.execute(job);
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
  cycle();
})();
