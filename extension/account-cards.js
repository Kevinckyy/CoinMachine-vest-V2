/* The Active filter on the desktop Accounts page shows all current account cards in one grid. */
(() => {
  'use strict';
  const core = VestBridgeCore;
  const clean = core.normalized;
  const visible = el => el.getClientRects().length > 0 && !el.closest('[hidden],[inert],[aria-hidden="true"]');
  const all = (root, selector) => [...root.querySelectorAll(selector)].filter(visible);
  const busy = '[aria-busy="true"],[data-loading="true"],[data-slot="skeleton"]';
  const money = text => /^[+\-−]?\s*\$?\s*[\d,]+(?:\.\d+)?(?:\s*USD[CT]?)?$/i.test(clean(text)) ?
    core.parseMoney(clean(text).replace('−','-')) : null;
  function cardInfo(card) {
    const names = all(card,'p > span.truncate');
    if (names.length !== 1 || !clean(names[0].innerText)) return null;
    const editId = card.querySelector('[data-testid^="edit-account-name-"]')?.dataset.testid.slice('edit-account-name-'.length);
    const badges = all(card,'[data-slot="badge"]').map(e => clean(e.innerText));
    const phase = core.accountPhase(badges);
    const item = {name:clean(names[0].innerText), id:editId || '', phase, category:core.accountCategory(badges) || 'active'};
    for (const p of all(card,'p')) {
      const label = clean(p.innerText);
      const value = clean(p.nextElementSibling?.innerText);
      const metric = core.parseCapitalMetric(value);
      if (/^(?:drawdown|max\.? drawdown|回撤|最大回撤|最大亏损|最大虧損)$/i.test(label)) {
        if (metric) { item.drawdown = metric.current; item.drawdown_limit = metric.limit; }
        if (item.category === 'active') item.category = 'funded';
      } else if (/^(?:daily loss|max\.? daily loss|每日亏损|每日虧損|最大日亏损)$/i.test(label)) {
        if (metric) { item.daily_loss = metric.current; item.daily_limit = metric.limit; }
      } else if (/^(?:profit target|盈利目标|盈利目標)$/i.test(label) && item.category === 'active') item.category = 'eval';
      else if (/^(?:account value|equity|账户价值|账户净值|净值)$/i.test(label)) item.equity = money(value);
      else if (/^(?:account health|账户健康度|帳戶健康度)$/i.test(label) && metric) item.health = metric.percent;
      const count = label.match(/^([\d,]+)\s*(?:impacting trades?|active positions?|笔影响账户的交易|筆影響帳戶的交易|笔活动持仓|个活动持仓)$/i);
      if (count) item.active_positions = Number(count[1].replaceAll(',',''));
      const pnl = label.match(/^([+\-−]?\s*\$\s*[\d,.]+)\s*\(\s*([+\-−]?[\d,.]+)\s*%\s*\)$/);
      if (pnl) { item.pnl = money(pnl[1]); item.pnl_percent = Number(pnl[2].replace('−','-').replaceAll(',','')); }
    }
    if (phase && item.category === 'active') item.category = phase === 'live' ? 'funded' : 'eval';
    return Number.isSafeInteger(item.active_positions) ? item : null;
  }
  function sample() {
    if (location.pathname.replace(/\/$/,'') !== '/accounts' || all(document,'[role="dialog"],[role="alertdialog"]').length) return null;
    const tabs = all(document,'[role="tab"][id$="-trigger-active"]').filter(el => /^(active|活跃|活躍)$/i.test(clean(el.innerText)));
    if (tabs.length !== 1) return null;
    const tab = tabs[0];
    if (tab.getAttribute('aria-selected') !== 'true') {
      if (!tab.disabled) {
        tab.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));
        if (tab.getAttribute('aria-selected') !== 'true') tab.click();
      }
      return null;
    }
    const grids = all(document,'section > div.grid').filter(el => !el.contains(tab));
    if (grids.length !== 1 || all(grids[0],busy).length || grids[0].closest(busy)) return null;
    const grid = grids[0];
    const links = all(grid,':scope > a');
    if (links.some(el => el.origin !== location.origin || el.pathname !== '/portfolio')) return null;
    const items = links.map(cardInfo);
    if (items.some(x => !x)) return null;
    if (!items.length) {
      const total = all(document,'[data-testid="dashboard-total-value"]');
      const cta = all(grid,'button').some(el => /^(get funded|unlock free account|获得资金|获取资金|获取资助|获取注资|解锁免费账户)$/i.test(clean(el.innerText)));
      const empty = /^(?:no active accounts|暂无活跃账户|没有活跃账户)$/i.test(clean(grid.innerText));
      if (total.length !== 1 || money(total[0].innerText) === null || !(empty || cta)) return null;
    }
    return items;
  }
  const membership = items => JSON.stringify(items.map(x => [x.name,x.id,x.category,x.phase]).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  async function read(full, guard) {
    const deadline = Date.now() + (full ? 12000 : 1500);
    let prior;
    do {
      guard();
      const items = sample();
      if (items) {
        const signature = membership(items);
        if (prior === signature) return {items, observed_at:Date.now()/1000};
        prior = signature;
      } else prior = undefined;
      await new Promise(resolve => setTimeout(resolve,220));
    } while (Date.now() < deadline);
    throw Error('未读到完整的活跃账户卡片，请检查登录状态、筛选和页面加载情况');
  }
  globalThis.VestCards = {read,membership};
})();
