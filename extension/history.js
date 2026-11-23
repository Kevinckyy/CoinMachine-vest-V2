/* Read the two Vest desktop history tables through their selected, visible tab panels. */
(() => {
  'use strict';
  const core = globalThis.VestBridgeCore;
  const text = el => core.normalized(el?.textContent);
  const money = el => core.parseMoney(text(el));
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const tabs = {position: '[data-testid="account-tab-positions-history"]', order: '[data-testid="account-tab-order-history"]'};
  const payoutTab = '[role="tab"][id$="-withdrawals"]:not([id$="-onchain-withdrawals"])';
  const payoutStates = {completed: 'completed', '已完成': 'completed', processing: 'processing', '处理中': 'processing',
    refunded: 'refunded', '已退款': 'refunded', failed: 'failed', '失败': 'failed'};

  function timestamp(cell) {
    const iso = cell?.querySelector('time[datetime]')?.dateTime || text(cell);
    if (/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/i.test(iso)) {
      const at = Date.parse(iso) / 1000;
      return Number.isFinite(at) ? at : null;
    }
    // Vest's date formatter uses en-US and the browser's local timezone.
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d\d?):(\d\d):(\d\d)$/.exec(iso);
    if (!match) return null;
    const [, month, day, year, rawHour, mins, secs] = match.map(Number);
    const hour = rawHour === 24 ? 0 : rawHour;
    const dt = new Date(year, month-1, day, hour, mins, secs);
    if (dt.getFullYear() !== year || dt.getMonth()+1 !== month || dt.getDate() !== day ||
        dt.getHours() !== hour || dt.getMinutes() !== mins || dt.getSeconds() !== secs) return null;
    // A repeated wall-clock time during the autumn DST transition has two possible instants.
    const next = new Date(dt.getTime() + 86400000);
    const shift = next.getTimezoneOffset() - dt.getTimezoneOffset();
    if (shift > 0) {
      const other = new Date(dt.getTime() + shift * 60000);
      if (other.getDate() === day && other.getHours() === hour && other.getMinutes() === mins) return null;
    }
    return dt.getTime() / 1000;
  }

  function phaseOf(header) {
    const label = text(header.querySelector('span') || header);
    const match = /^(?:Step\s+([12])\s+Evaluation|第\s*([12])\s*[阶階]段[评評]估)$/i.exec(label);
    return match ? (match[1] || match[2]) + '/2' : core.accountPhase([label]);
  }
  function parseRow(row, kind, phase) {
    const cell = key => row.querySelector(':scope > [data-testid="td-' + key + '"]');
    if (kind === 'payout') {
      const display_id = text(cell('id')), created_at = timestamp(cell('createdAt'));
      const status = payoutStates[text(cell('status')).toLowerCase()];
      if (!display_id || !/^[\w:.…-]+$/.test(display_id) || !created_at || !status) return null;
      const ref = /…|\.\.\./.test(display_id) ? ['display',display_id,created_at].join('|') : display_id;
      return {kind, ref, display_id, status, created_at, phase: 'live', updated_at: timestamp(cell('updatedAt')),
        executed_at: timestamp(cell('executedAt')), gross_amount: money(cell('requestedAmount')), net_amount: money(cell('traderAmount'))};
    }
    const symbolCell = cell('symbol');
    const anchor = symbolCell?.querySelector('a[href*="/trade/"]');
    const symbol = anchor?.pathname.match(/^\/trade\/([A-Za-z0-9_.-]+)\/?$/)?.[1] || null;
    const sideLabel = text(symbolCell?.querySelector('p:last-child:not(:first-child)')) || text(symbolCell?.querySelector('.text-long,.text-short'));
    const side = core.parseSide(sideLabel) || (sideLabel || null);
    if (kind === 'position') {
      const pnl = cell('pnl')?.querySelector('[data-testid^="position-history-pnl-"]');
      const ref = pnl?.dataset.testid.slice('position-history-pnl-'.length);
      const closed_at = timestamp(cell('closeDate')), opened_at = timestamp(cell('openDate'));
      if (!ref || !closed_at || (opened_at && opened_at > closed_at)) return null;
      return {kind, ref, phase, symbol, side, opened_at, closed_at, pnl: money(pnl),
        entry_price: money(cell('openPrice')), exit_price: money(cell('closePrice')), quantity: money(cell('quantity'))};
    }
    const display_id = text(cell('id')), created_at = timestamp(cell('createdAt'));
    if (!display_id || !created_at || !symbol || !/^[\w:.…-]+$/.test(display_id)) return null;
    // Desktop abbreviates most IDs. Include the immutable timestamp and symbol, never mutable fill fields.
    const ref = /…|\.\.\./.test(display_id) ? ['display', display_id, created_at, symbol].join('|') : display_id;
    return {kind, ref, phase, symbol, side, display_id, created_at, updated_at: timestamp(cell('updatedAt')),
      size_text: text(cell('size')) || null, execution_price: money(cell('executedPrice')),
      status: text(cell('status')) || null, order_type: text(cell('type')) || null};
  }

  function rows(panel, kind, name, ownerPhase, phaseByRef) {
    const table = [...panel.querySelectorAll('table')].find(el => el.getClientRects().length && !el.parentElement.closest('table'));
    const items = new Map(), ambiguous = new Set();
    const first = table?.querySelector('tr[data-index]');
    // Vest groups prior evaluation accounts under step headings. At index zero an ungrouped
    // position table belongs to the selected platform account. Order history is account-scoped.
    const single = first?.dataset.index === '0' && !table.querySelector('[data-testid^="positions-history-step-"]');
    let phase = kind === 'order' || single || ownerPhase === '1/2' ? ownerPhase : null;
    let source = null, skipped = 0, dataRows = 0;
    for (const row of table?.rows || []) {
      const header = row.querySelector('[data-testid^="positions-history-step-"]');
      if (header) {
        phase = phaseOf(header);
        source = header.dataset.testid.slice('positions-history-step-'.length) || null;
        continue;
      }
      if (kind === 'payout') {
        // The portfolio lists payouts for the entire login. Require a complete source account name on this row.
        const source = row.querySelector(':scope > [data-testid="td-accountId"]');
        if (!source) continue;
        dataRows++;
        const fullName = text(source.querySelector('span.truncate'));
        if (!fullName) { skipped++; continue; }
        if (fullName !== name) continue;
      } else {
        if (!row.querySelector(':scope > [data-testid="td-symbol"]')) continue;
        dataRows++;
      }
      const item = parseRow(row, kind, phase);
      if (!item) { skipped++; continue; }
      if (kind === 'position') {
        const known = phaseByRef.get(item.ref);
        if (!source && known) { source = known.source; phase = known.phase; }
        item.source_account_id = source;
        item.phase = phase;
        if (source || phase) phaseByRef.set(item.ref, {source,phase});
      }
      if (items.has(item.ref)) ambiguous.add(item.ref);
      items.set(item.ref, item);
    }
    for (const ref of ambiguous) items.delete(ref);
    return {items, skipped: skipped + ambiguous.size, table, dataRows};
  }
  function scroller(table, panel) {
    for (let p = table?.parentElement; p && panel.contains(p); p = p.parentElement) {
      if (p.clientHeight && p.scrollHeight > p.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(p).overflowY)) return p;
    }
    return null;
  }
  function create({guard, identity, query, selected, select, report}) {
    const offsets = new Map();
    return async function readHistory(name, deep = false, portfolio = false) {
      const owner = identity();
      const check = () => {
        guard();
        if (portfolio ? location.pathname.replace(/\/$/, '') !== '/portfolio' : !core.isNqTradePath(location.pathname)) throw Error('历史读取页面已变化');
        const current = identity();
        if (owner.name !== name || current.name !== name || current.signature !== owner.signature) throw Error('历史读取期间账户发生变化');
      };
      const active = '[data-testid="account-tab-active-positions"]';
      const summary = {};
      check();
      if (!portfolio && !selected(query(active, document, true))) throw Error('读取历史前需选中活动持仓');
      let touched = false;
      try {
        for (const [kind, selector] of Object.entries(portfolio ? {payout:payoutTab} : tabs)) {
          if (!query(selector)) { summary[kind] = {available: false}; continue; }
          check();
          touched = true;
          await select(selector, () => document, check);
          const key = JSON.stringify([name, kind]), deadline = Date.now() + (deep ? 23000 : 3200);
          const seen = new Map(), phaseByRef = new Map();
          let skipped = 0, atBottom = false, resume = deep ? offsets.get(key) || 0 : 0, ready = false;
          let lastOffset = 0, stableEnd = 0, startedAtTop = false;
          do {
            await wait(220);
            check();
            const tab = query(selector, document, true);
            const panel = document.getElementById(tab.getAttribute('aria-controls'));
            if (!selected(tab) || !panel?.getClientRects().length) throw Error('历史表格已切换或不可见');
            if (panel.querySelector('[aria-busy="true"],[data-loading="true"],.opacity-50 table')) continue;
            const sample = rows(panel, kind, name, owner.phase, phaseByRef);
            if (sample.table?.closest('.opacity-50,[aria-busy="true"],[data-loading="true"]')) continue;
            const scroll = scroller(sample.table, panel);
            if (scroll && !startedAtTop) {
              startedAtTop = true;
              if (scroll.scrollTop > 2) { scroll.scrollTop = 0; phaseByRef.clear(); continue; }
            }
            const loading = !!panel.querySelector('[data-loader],.animate-pulse');
            const empty = panel.querySelector('[data-testid="order-history-empty"],[data-testid="positions-history-empty"]') ||
              /no (?:positions?|orders?) history|no withdrawals|暂无提现记录|暂无(?:持仓|订单)历史|未找到(?:历史订单|订单历史)/i.test(text(panel));
            if (!sample.dataRows && !empty) continue;
            if (!sample.items.size && loading) continue;
            ready = true;
            skipped = Math.max(skipped, sample.skipped);
            const batch = [];
            for (const item of sample.items.values()) {
              const encoded = JSON.stringify(item);
              if (seen.get(item.ref) !== encoded) { batch.push(item); seen.set(item.ref, encoded); }
            }
            for (let i = 0; i < batch.length; i += 100) {
              check();
              await report({history: {name, items: batch.slice(i, i+100)}});
            }
            if (!deep) break;
            if (scroll) {
              const max = scroll.scrollHeight - scroll.clientHeight;
              if (scroll.scrollTop < max - 2) {
                const target = Math.min(max, Math.max(resume, scroll.scrollTop + Math.max(100, scroll.clientHeight * .7)));
                scroll.scrollTop = target;
                lastOffset = target;
                resume = 0;
                stableEnd = 0;
                continue;
              }
            }
            // Infinite tables may append another page shortly after reaching their bottom.
            stableEnd = loading || batch.length ? 0 : stableEnd + 1;
            if (stableEnd >= 5) { atBottom = true; break; }
          } while (Date.now() < deadline);
          if (deep) offsets.set(key, atBottom ? 0 : lastOffset);
          summary[kind] = {available: true, ready, rows_read: seen.size, skipped, bottom_seen: atBottom};
        }
      } finally {
        if (touched && !portfolio) { check(); await select(active, () => document, check); }
      }
      return summary;
    };
  }
  globalThis.VestHistory = {create};
})();
