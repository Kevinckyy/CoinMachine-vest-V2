/* Vest desktop DOM adapter. The bridge owns command leases and click permissions. */
(() => {
  'use strict';

  function create(hooks) {
    const core = globalThis.VestBridgeCore;
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const elementText = el => el instanceof HTMLInputElement ? el.value : core.normalized(el?.textContent);
    const assertLive = () => hooks.guard();
    let config = null;
    function assertArmed() {
      hooks.guard(true);
      if (!config) throw Error('执行账户未绑定');
      const page = observerIdentity();
      core.assertExecutionAllowed({
        name: config.accountName,
        category: config.accountCategory
      });
      core.assertExecutionAllowed(page);
      if (page.name !== config.accountName || page.signature !== config.identityText || config.phase && page.phase !== config.phase) throw Error('当前账户或阶段已变化');
    }
    const assertExecutableAccount = assertArmed;
    function queryOne(selector, scope = document, required = false) {
      const matches = [...scope.querySelectorAll(selector)].filter(visible);
      if (matches.length > 1) throw new Error('页面控件不唯一: ' + selector);
      if (required && matches.length !== 1) throw new Error('页面控件不可见: ' + selector);
      return matches[0] || null;
    }
    function mainForm(required = false) {
      const forms = [...document.querySelectorAll('[data-testid="order-form"]')].filter(el => visible(el) && !el.closest('[role="dialog"],[role="alertdialog"]'));
      if (forms.length > 1) throw new Error('存在多个可见主下单表单');
      if (required && forms.length !== 1) throw new Error('主下单表单不可见');
      return forms[0] || null;
    }
    function positionPanel(required = false) {
      const tab = queryOne('[data-testid="account-tab-active-positions"]');
      const panelId = tab?.getAttribute('aria-controls');
      const panel = panelId ? document.getElementById(panelId) : null;
      if (tab && isSelected(tab) && panel && visible(panel)) return panel;
      if (required) throw new Error('请保持活动持仓标签选中并等待数据加载');
      return null;
    }
    async function ensurePositionPanelLayout(guard = () => {}) {
      const pane = document.getElementById('trade-account-tabs');
      const tab = queryOne('[data-testid="account-tab-active-positions"]');
      if (!pane || !tab || !pane.contains(tab) || pane.getBoundingClientRect().height >= 200) return;
      const identity = observerIdentity().signature;
      const separator = pane.previousElementSibling;
      const chart = separator?.previousElementSibling;
      if (!separator?.matches('[data-slot="resizable-handle"][role="separator"][aria-orientation="horizontal"]') || chart?.id !== 'trade-chart-activity') {
        const error = new Error('持仓面板高度不足，无法定位其展开控件，请展开持仓区域');
        error.code = 'OBSERVATION_PENDING';
        throw error;
      }
      // The native virtual table omits its rows when the pane is nearly collapsed.
      // Resize only the verified chart/account separator, before any order lease.
      for (let step = 0; step < 8 && pane.getBoundingClientRect().height < 200; step++) {
        guard();
        assertNoDialogs();
        if (observerIdentity().signature !== identity) throw new Error('展开持仓区域时账号或阶段发生变化');
        separator.focus({
          preventScroll: true
        });
        separator.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'ArrowUp',
          code: 'ArrowUp',
          bubbles: true,
          cancelable: true
        }));
        separator.dispatchEvent(new KeyboardEvent('keyup', {
          key: 'ArrowUp',
          code: 'ArrowUp',
          bubbles: true,
          cancelable: true
        }));
        await delay(100);
      }
      guard();
      if (pane.getBoundingClientRect().height < 200) {
        const error = new Error('持仓表仍未展开，等待可读取持仓行后再继续');
        error.code = 'OBSERVATION_PENDING';
        throw error;
      }
    }
    function assertNoDialogs(allowed = null) {
      const dialogs = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].filter(visible);
      if (dialogs.some(el => el !== allowed) || allowed && (!visible(allowed) || dialogs.length !== 1)) {
        throw Object.assign(Error('页面存在额外确认或风险弹窗；已暂停，请人工处理'),
          {noticeKind:!allowed && VestAccountNotices.inspect()?.kind});
      }
      if (field('submit')) throw new Error('页面存在成本或风险警告；禁止自动代为确认');
    }
    function findAll(selector, key) {
      if (!selector) return [];
      const formFields = ['quantity', 'unit', 'takeProfit', 'stopLoss', 'buy', 'sell'];
      const positionFields = ['positionOpen', 'positionEmpty', 'entryPrice', 'positionSymbol', 'positionSide', 'positionValue', 'close'];
      const scope = formFields.includes(key) ? mainForm() : positionFields.includes(key) ? positionPanel() : document;
      if (!scope) return [];
      if (selector.startsWith('text:')) {
        const values = selector.slice(5).split('||').map(core.normalized);
        return [...scope.querySelectorAll('h1,h2,h3,h4,p,span,div')].filter(el => values.includes(core.normalized(el.textContent)) && ![...el.children].some(child => values.includes(core.normalized(child.textContent))) && visible(el));
      }
      return [...scope.querySelectorAll(selector)].filter(visible);
    }
    function field(key, required = false) {
      const matches = findAll(config?.selectors?.[key] || core.defaults[key], key);
      if (matches.length > 1) throw new Error(`控件不唯一: ${key} (${matches.length})`);
      if (required && matches.length !== 1) throw new Error(`控件不可见: ${key}`);
      return matches[0] || null;
    }
    function numeric(key) {
      if (key === 'unrealized') {
        const banner = bannerUnrealized();
        if (banner.found) return banner.value;
      }
      const el = field(key);
      return el ? core.parseMoney(elementText(el)) : null;
    }
    function positionDetails(source) {
      const symbolEl = field('positionSymbol', true);
      const id = symbolEl.getAttribute('data-testid')?.match(/^position-symbol-(.+)$/)?.[1];
      const row = symbolEl.closest('tr');
      if (!id || !row) throw new Error('需要可识别持仓 ID 的桌面持仓表，不能按品种猜测控件');
      const native = source?.position?.position_id===id ? source.position : null;
      const age = Date.now()/1000-source?.position_at;
      const recent = native && age>=0 && age<=15;
      const requireSame = (key, prefix) => {
        const el = field(key, !recent);
        if (!el) return null;
        if (el.getAttribute('data-testid') !== prefix + id || el.closest('tr') !== row) throw new Error('持仓数据不属于同一持仓 ID: ' + key);
        return el;
      };
      const link = symbolEl.closest('a[href]');
      const symbolText = core.normalized(elementText(symbolEl));
      core.canonicalNqPosition(symbolText, link?.getAttribute('href'), location.href);
      const sideEl = requireSame('positionSide','position-side-');
      const entryEl = requireSame('entryPrice','position-entry-');
      const side = sideEl ? core.parseSide(elementText(sideEl)) : native?.side;
      const entry = entryEl ? core.parseMoney(elementText(entryEl)) : native?.entry_price;
      const valueEl = requireSame('positionValue', 'position-value-');
      // Public Vest desktop markup: value is in the first p, quantity + market unit in the next p.
      const sizeEl = valueEl?.closest('p')?.nextElementSibling;
      if ((!sizeEl && !recent) || (sizeEl && (sizeEl.tagName !== 'P' || !visible(sizeEl) || sizeEl.closest('tr') !== row))) throw new Error('无法定位同持仓的真实数量');
      const sizeText = core.normalized(elementText(sizeEl));
      const quantity = sizeEl ? core.parseMoney(sizeText) : native?.quantity;
      if (!side || !(entry > 0) || !(quantity > 0) || (sizeEl && !sizeText.endsWith(' ' + symbolText))) throw new Error('持仓方向、数量或数量单位无法确认');
      const filledFromResponse = !sideEl || !entryEl || !sizeEl;
      if (filledFromResponse && (!recent || side!==native.side || entry!==native.entry_price || quantity!==native.quantity))
        throw Error('活动持仓响应与页面读数不一致');
      const protection = queryOne('[data-testid="td-tpsl"]', row);
      const tp = protection ? queryOne('span.text-long', protection) : null;
      const sl = protection ? queryOne('span.text-short', protection) : null;
      const tpPrice = tp ? core.parseMoney(elementText(tp)) : null;
      const slPrice = sl ? core.parseMoney(elementText(sl)) : null;
      return {
        position_id: id,
        symbol: 'NQ-PERP',
        side,
        quantity,
        entry_price: entry,
        ...(native?.opened_at && age>=0 && age<=90 ? {opened_at:native.opened_at} : {}),
        ...(filledFromResponse ? {position_reference_at:source.position_at} : {}),
        native_tp_price: tpPrice,
        native_sl_price: slPrice,
        native_sl_absent: !!protection && (!sl || /^(?:-|—|–)$/.test(core.normalized(elementText(sl)))),
        native_tp_absent: !!protection && (!tp || /^(?:-|—|–)$/.test(core.normalized(elementText(tp))))
      };
    }
    function snapshot(source) {
      positionPanel(true);
      const equity = numeric('balance');
      const pnl = numeric('unrealized');
      const isOpen = core.positionState(!!field('positionOpen'), !!field('positionEmpty'));
      const details = isOpen ? positionDetails(source) : {};
      let phase = null;
      try {
        phase = observerIdentity().phase;
      } catch {}
      return {
        ...(phase ? {
          phase
        } : {}),
        equity,
        balance: equity !== null && pnl !== null ? Math.round((equity - pnl) * 100) / 100 : null,
        unrealized_pnl: pnl,
        price: numeric('price'),
        ...details,
        position_open: isOpen,
        observed_at: Date.now() / 1000
      };
    }
    function assertAccount(opening = true) {
      assertArmed();
      if (!core.isNqTradePath(location.pathname)) throw Error('当前页面不是 NQ 交易页');
      if (opening && field('unit', true).dataset.unit !== 'micro') throw Error('请核对 Micro 数量单位');
      const current = snapshot();
      if ([current.equity, current.balance, current.unrealized_pnl, current.price].some(v => !Number.isFinite(v)) || current.position_open === null) throw Error('资金、行情或持仓状态无法确认');
      return current;
    }
    function readyCheck() {
      assertNoDialogs();
      checkOpenFormAccount();
      const form = mainForm(true);
      for (const key of ['quantity', 'takeProfit', 'stopLoss', 'buy', 'sell']) field(key, true);
      if (field('buy') === field('sell')) throw new Error('做多与做空控件不能相同');
      const usd = queryOne('[data-testid="tpsl-unit-usd"]', form, true);
      if (!isSelected(usd)) throw new Error('请将页面止盈止损单位切到 USD，并确认选中状态');
      const limit = queryOne('[data-testid="tpsl-limit-switch"]', form, true);
      if (limit.getAttribute('aria-checked') !== 'false' && limit.dataset.state !== 'unchecked') throw new Error('止盈止损必须确认使用市场触发，请关闭 Limit');
      const market = queryOne('[data-testid="ordertype-tab-market"]', form, true);
      if (!isSelected(market)) throw new Error('必须先切换并校准市价订单');
    }
    function checkOpenFormAccount() {
      assertArmed();
      if (!core.isNqTradePath(location.pathname) || field('unit',true).dataset.unit!=='micro' || !(numeric('price')>0))
        throw Error('请核对 NQ 交易页、行情和 Micro 单位');
      if (findAll(core.defaults.positionOpen,'positionOpen').length) throw Error('交易表单已显示活动持仓');
    }
    function isSelected(el) {
      return el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-pressed') === 'true' || el.getAttribute('data-state') === 'active' || el.getAttribute('data-state') === 'on' || el.getAttribute('data-active') === 'true' || el.getAttribute('data-selected') === 'true';
    }
    function click(el) {
      assertLive();
      if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') throw new Error('按钮不可操作，已取消后续动作');
      el.click();
    }
    async function selectTab(selector, scope, guard, dialog = null) {
      guard();
      assertNoDialogs(dialog);
      let tab = queryOne(selector, scope(), true);
      if (isSelected(tab)) return;
      // Radix Tabs changes selection on mousedown/keyboard, not click alone.
      tab.focus();
      tab.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1,
        ctrlKey: false
      }));
      tab.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 0,
        ctrlKey: false
      }));
      tab.click();
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        await delay(100);
        guard();
        assertNoDialogs(dialog);
        tab = queryOne(selector, scope(), true);
        if (isSelected(tab)) return;
      }
      throw new Error('无法确认页面标签已选中：' + selector + '；未提交订单');
    }
    async function ensureQuantityUnit(wanted, scope, guard, dialog = null) {
      guard();
      assertNoDialogs(dialog);
      const selector = '[data-testid="size-unit-select"]';
      let unit = queryOne(selector, scope(), true);
      if (unit.dataset.unit === wanted) return;
      unit.focus();
      unit.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        code: 'ArrowDown',
        bubbles: true,
        cancelable: true
      }));
      const optionSelector = `[data-testid="size-unit-option-${wanted}"]`;
      const deadline = Date.now() + 4000;
      let chosen = false;
      while (Date.now() < deadline) {
        await delay(100);
        guard();
        assertNoDialogs(dialog);
        unit = queryOne(selector, scope(), true);
        const option = queryOne(optionSelector);
        if (unit.dataset.unit === wanted && !option) return;
        if (option && !chosen) {
          option.focus();
          option.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            bubbles: true,
            cancelable: true
          }));
          if (option.isConnected) option.click();
          chosen = true;
        }
      }
      throw new Error('无法确认数量单位已切换为 ' + wanted + '；未提交订单');
    }
    async function setInput(key, value) {
      assertArmed();
      assertNoDialogs();
      const el = field(key, true);
      if (!(el instanceof HTMLInputElement) || el.disabled || el.readOnly) throw new Error('输入控件不可编辑: ' + key);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, String(value));
      el.dispatchEvent(new Event('input', {
        bubbles: true
      }));
      el.dispatchEvent(new Event('change', {
        bubbles: true
      }));
      await delay(150);
      if (value === '') {
        if (field(key, true).value.trim() !== '') throw new Error('无法清空' + (key === 'stopLoss' ? '止损' : '止盈') + '，禁止带入旧金额');
        return;
      }
      const actual = core.parseMoney(field(key, true).value);
      if (actual === null || Math.abs(actual - value) > 0.000001) throw new Error('页面输入值未被接受: ' + key);
    }
    async function prepare(guard = () => {}) {
      assertExecutableAccount();
      guard();
      const prepareClick = el => {
        guard();
        assertExecutableAccount();
        click(el);
      };
      assertNoDialogs();
      const form = mainForm(true);
      const protectedGuard = () => {
        guard();
        assertExecutableAccount();
      };
      await selectTab('[data-testid="ordertype-tab-market"]', () => mainForm(true), protectedGuard);
      await selectTab('[data-testid="account-tab-active-positions"]', () => document, protectedGuard);
      assertNoDialogs();
      await ensureQuantityUnit(config.inputUnit || 'token', () => mainForm(true), protectedGuard);
      if (!field('takeProfit') || !field('stopLoss')) {
        const toggle = queryOne('[data-testid="tpsl-toggle"]', form, true);
        if (toggle.getAttribute('aria-checked') === 'true' || toggle.dataset.state === 'checked') throw new Error('TP/SL 已开启但输入不可见，请人工核对');
        assertNoDialogs();
        prepareClick(toggle);
        await delay(200);
      }
      await selectTab('[data-testid="tpsl-unit-usd"]', () => mainForm(true), protectedGuard);
      const limit = queryOne('[data-testid="tpsl-limit-switch"]', form, true);
      if (limit.getAttribute('aria-checked') === 'true' || limit.dataset.state === 'checked') {
        assertNoDialogs();
        prepareClick(limit);
      }
      await delay(300);
      assertNoDialogs();
      guard();
    }
    async function awaitPosition(job, oldIds, expectedPosition) {
      const until = Date.now() + 12000;
      let filled = null;
      const missingProtection = current => {
        const missing = {};
        if (!(job.stop_loss == null ? current.native_sl_absent : current.native_sl_price > 0)) {
          missing.stop_check = {
            status: 'failed',
            error: '成交已确认，但止损状态未及时显示'
          };
        }
        if (!(job.take_profit == null ? current.native_tp_absent : current.native_tp_price > 0)) {
          missing.take_profit_check = {
            status: 'failed',
            error: '成交已确认，但止盈状态未及时显示'
          };
        }
        return missing;
      };
      while (Date.now() < until) {
        await delay(350);
        await ensurePositionPanelLayout(() => assertArmed(job));
        const closeDialog = job.type === 'close' ? queryOne('[data-testid="close-dialog"]') : null;
        assertNoDialogs(closeDialog);
        const current = assertAccount(job.type === 'open');
        if (job.type === 'open' && current.position_open) {
          if (oldIds.has(current.position_id) || !core.matchesPosition(current, job)) throw new Error('页面持仓 ID、方向或数量不符合本次订单，禁止认作成交');
          filled = current;
          // The entry request and native protection can be accepted separately. Wait for both visible legs.
          if (!Object.keys(missingProtection(current)).length) return current;
        } else if (job.type === 'close') {
          if (current.position_open && !core.matchesPosition(current, expectedPosition)) throw new Error('等待平仓时持仓 ID、方向或数量变化，停止执行');
          if (current.position_open === false && !closeDialog) return withFlatAccountHealth(current);
        }
      }
      if (job.type === 'open' && filled) return {
        ...filled,
        ...missingProtection(filled)
      };
      throw new Error('12 秒内未观察到明确成交及保护状态；不得自动重试，请手工核对');
    }
    async function selectPositionSize(job) {
      assertArmed(job);
      assertNoDialogs();
      checkOpenFormAccount();
      const form = mainForm(true);
      const button = queryOne(`[data-testid="size-pct-${job.size_percent}"]`, form, true);
      if (core.normalized(elementText(button)) !== job.size_percent + '%') throw new Error('页面仓位比例按钮文案不匹配');
      click(button);
      const deadline = Date.now() + 4000;
      let stable = 0,
        previous = null;
      while (Date.now() < deadline) {
        await delay(150);
        assertArmed(job);
        assertNoDialogs();
        checkOpenFormAccount();
        const slider = queryOne('[role="slider"]', mainForm(true), true);
        const quantity = numeric('quantity');
        if (Number(slider.getAttribute('aria-valuenow')) === job.size_percent && quantity > 0) {
          stable = core.sameQuantity(quantity, previous) ? stable + 1 : 1;
          previous = quantity;
          if (stable >= 3) return core.nqInputToVest(quantity, config.inputUnit || 'token');
        } else {
          stable = 0;
          previous = null;
        }
      }
      throw new Error('无法确认页面仓位比例或计算数量，未提交订单');
    }
    function observerAssertPage() {
      assertLive();
      if (!core.isNqTradePath(location.pathname)) throw new Error('请打开已登录的 Vest NQ-PERP 交易页面');
      if ([...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].some(visible))
        throw Object.assign(Error('页面存在弹窗，请先关闭后再读取账户'),{noticeKind:VestAccountNotices.inspect()?.kind});
    }
    function observerTrigger(required = true) {
      return queryOne(core.defaults.identity, document, required);
    }
    function observerIdentity(allowLoading = false, trigger = observerTrigger(!allowLoading)) {
      if (!trigger) return null;
      const names = [...trigger.querySelectorAll('span.truncate')].filter(visible);
      if (allowLoading && !names.length) return null;
      if (names.length !== 1) throw new Error('无法唯一读取当前账户名称，请使用桌面布局');
      const name = core.normalized(names[0].textContent);
      if (!name) {
        if (allowLoading) return null;
        throw new Error('账户名称为空，请确认已登录');
      }
      const labels = [...trigger.querySelectorAll('span')].filter(el => visible(el) && el !== names[0] && !el.contains(names[0])).map(el => core.normalized(el.textContent));
      // Vest replaces the 2/2 badge with "Evaluation Passed" while its native
      // result modal is open. The exact stage Profit Target label in the same
      // account banner remains explicit phase evidence; the modal text alone is
      // insufficient. Conflicting badge/goal phases still resolve to unknown.
      const phaseLabels = [...document.querySelectorAll('div.sticky.top-14 [data-slot="badge"],div.sticky.top-14 p')].filter(el => visible(el) && !el.closest('[role="dialog"],[role="menu"]')).map(el => core.normalized(el.textContent));
      const phase = core.accountPhase([...labels, ...phaseLabels]);
      return {
        name,
        signature: core.normalized(trigger.textContent) + (phase ? '|' + phase : ''),
        phase,
        category: core.accountCategory(labels) || (phase === 'live' ? 'funded' : phase ? 'eval' : null)
      };
    }
    async function waitForAccountIdentity(assertPage, rootSelector) {
      const deadline = Date.now() + 10000;
      while (true) {
        assertPage();
        const rootReady = !rootSelector || queryOne(rootSelector);
        const trigger = rootReady && observerTrigger(false);
        if (trigger && !trigger.closest(':disabled,[aria-disabled="true"],[aria-busy="true"],[data-loading="true"],[aria-hidden="true"],[inert]')) {
          const identity = observerIdentity(true, trigger);
          if (identity) return identity;
        }
        if (Date.now() >= deadline) {
          const control = rootReady ? '账户选择器及账户名称' : 'Portfolio 详情区域';
          throw Error(`等待${control}加载超时（10 秒，${location.pathname}），请检查登录状态和桌面布局`);
        }
        await delay(200);
      }
    }
    function readAccountHealth(scope = document) {
      const indicators = [...scope.querySelectorAll('[data-testid="account-health"]')].filter(el => visible(el) && !el.closest('[role="dialog"],[role="alertdialog"],[role="menu"],[aria-busy="true"],[data-loading="true"]'));
      const readings = indicators.map(el => core.parseCapitalMetric(elementText(el)));
      const first = readings[0];
      return first?.percent != null && first.percent <= 100 && readings.every(item => item?.percent === first.percent) ? first : null;
    }
    function withFlatAccountHealth(current) {
      return current.position_open === false ? {
        ...current,
        account_health: readAccountHealth()?.percent ?? null
      } : current;
    }
    const missingIndicators = Symbol('missing capital indicators');
    function observerCapitalMetrics() {
      const missing=[];
      const eligible = el => visible(el) && !el.closest('[role="dialog"],[role="alertdialog"],[role="menu"]');
      const banners = [...document.querySelectorAll('div.sticky.top-14')].filter(eligible);
      const metrics = Object.fromEntries(core.CAPITAL_INDICATORS.map(({
        key,
        testId,
        labels
      }) => {
        // Desktop's top-left banner omits the goal/drawdown test IDs. Read only
        // exact labels inside that banner; never search unrelated account cards.
        let sources = banners.flatMap(banner => {
          const identified = [...banner.querySelectorAll(`[data-testid="${testId}"]`)].filter(eligible);
          if (identified.length) return identified.map(el => ({
            el,
            text: elementText(el)
          }));
          return [...banner.querySelectorAll('p')].filter(eligible).flatMap(el => {
            const text = core.normalized(elementText(el));
            const label = labels.find(label => text.toLowerCase().startsWith(label.toLowerCase() + ':') || text.startsWith(label + '：'));
            return label ? [{
              el,
              text: text.slice(label.length + 1).trim()
            }] : [];
          });
        });
        if (!sources.length) sources = [...document.querySelectorAll(`[data-testid="${testId}"]`)].filter(eligible).map(el => ({
          el,
          text: elementText(el)
        }));
        if (!sources.length) missing.push(key);
        const readings = sources.map(({
          el,
          text
        }) => el.closest('[aria-busy="true"],[data-loading="true"]') ? null : core.parseCapitalMetric(text));
        const first = readings[0];
        const consistent = first && readings.every(item => item && ['current', 'limit', 'percent'].every(field => item[field] === first[field]));
        return [key, consistent ? (first.percent==null ? {current:first.current,limit:first.limit} : {percent:first.percent}) : null];
      }));
      Object.defineProperty(metrics,missingIndicators,{value:missing});
      return metrics;
    }
    function dailyUnlimited(scope = document) {
      return [...scope.querySelectorAll('div.sticky.top-14 p,[data-testid="capital-indicator-daily-loss"]')].some(el =>
        visible(el) && /^(?:(?:max\.? daily loss|最大日亏损)\s*[:：]\s*)?(?:no daily loss limit|unlimited|无每日亏损上限|无日损限制|不限)$/i.test(core.normalized(el.innerText)));
    }
    function riskTrigger(metric, label) {
      const triggers = '[data-slot="tooltip-trigger"]';
      const eligible = el => visible(el) && !el.closest('[role="dialog"],[role="menu"],[aria-busy="true"],[data-loading="true"]') && label.test(core.normalized(el.textContent));
      const banner = [...document.querySelectorAll('div.sticky.top-14 '+triggers)].filter(eligible);
      if (banner.length === 1) return banner[0];
      const indicators = [...document.querySelectorAll(`[data-testid="capital-indicator-${metric}"]`)].filter(visible);
      const local = new Set(indicators.flatMap(el => [...el.parentElement.querySelectorAll(triggers)].filter(eligible)));
      return local.size === 1 ? [...local][0] : null;
    }
    async function readRiskTooltip(trigger, name, parse) {
      if (!trigger) return {};
      const opts = {bubbles:true,pointerType:'mouse'};
      try {
        trigger.dispatchEvent(new PointerEvent('pointerover',opts));
        trigger.dispatchEvent(new PointerEvent('pointermove',opts));
        for (let i=0;i<14;i++) {
          assertLive();
          if (observerIdentity().name!==name) throw Error('读取风控底线时账户已变化');
          if (!trigger.isConnected || !visible(trigger)) return {};
          const id = trigger.getAttribute('aria-describedby');
          const tooltip = id && document.getElementById(id);
          if (tooltip && visible(tooltip)) {
            const value = parse(tooltip);
            if (value) return value;
          }
          await delay(100);
        }
        return {};
      } finally {
        trigger.dispatchEvent(new PointerEvent('pointerout',{...opts,relatedTarget:document.body}));
      }
    }
    async function riskReferences(identity, expectedId, positionSample, reading, metricCardId=expectedId) {
      const {name,phase} = identity;
      const source = await hooks.nativeAccounts('selected');
      const row = source?.row;
      if (positionSample && (source?.position_at!==positionSample.position_at ||
          source?.position?.position_id!==positionSample.position.position_id || Date.now()/1000-source.position_at>15))
        throw Error('持仓响应在读取期间已更新，请重新读取');
      if (expectedId && row?.id!==expectedId || row && row.phase!==phase)
        return {reference_error:'交易页未确认当前平台账户身份或阶段'};
      const age = Date.now()/1000-source?.at;
      const proof = {reference_card_id:row?.id,reference_at:source?.at,reference_source:'active_accounts'};
      if (row && age>=0 && age<=330 && (row.daily_floor!=null || row.daily_unlimited) && row.max_drawdown_floor!=null) {
        if (metricCardId===row.id && reading?.capital_metrics[missingIndicators]?.length) {
          const derived=core.nativeCapitalMetrics(row,reading.equity,source.at,reading.observed_at);
          for (const key of reading.capital_metrics[missingIndicators]) {
            if (derived[key]) reading.capital_metrics[key]={...derived[key],source:'active_accounts'};
          }
        }
        return {...proof,daily_floor:row.daily_floor,daily_unlimited:row.daily_unlimited,
          max_drawdown_floor:row.max_drawdown_floor,daily_reset_balance:row.daily_reset_balance,daily_reset_equity:row.daily_reset_equity};
      }
      if (expectedId) return proof;
      // Read-only diagnostics may still use the visible tooltip when native fields are unavailable.
      const daily = await readRiskTooltip(riskTrigger('daily-loss',/^(?:max\.? daily loss|daily loss|最大日亏损|每日亏损)$/i),name,root => {
        const result = {};
        for (const el of [root,...root.querySelectorAll('p,span,div')]) {
          const match = core.normalized(el.textContent).match(/^(8\s*pm ET balance|美东时间晚上\s*8\s*点余额|today['’]s floor|今日底线|今日底線)\s*[:：]\s*(\$?\s*[\d,]+(?:\.\d+)?)$/i);
          if (!match) continue;
          const key = /^(?:8|美东)/.test(match[1]) ? 'daily_reset_balance' : 'daily_floor';
          const value = core.parseMoney(match[2]);
          if (result[key]!=null && result[key]!==value) return null;
          result[key] = value;
        }
        return result.daily_floor!=null ? result : null;
      });
      const maximum = await readRiskTooltip(riskTrigger('drawdown',/^(?:max\.? drawdown|最大回撤)$/i),name,root => {
        const match = core.normalized(root.textContent).match(/(?:若账户价值跌至\s*(\$[\d,]+(?:\.\d+)?)\s*[，,]\s*账户将被永久关闭|account is permanently closed if your account value drops to\s*(\$[\d,]+(?:\.\d+)?))\s*[.。]?$/i);
        const value = match && core.parseMoney(match[1] || match[2]);
        return value!=null ? {max_drawdown_floor:value} : null;
      });
      const after = await hooks.nativeAccounts('selected');
      if (after?.selected!==source?.selected || observerIdentity().signature!==identity.signature)
        return {reference_error:'交易页未确认当前平台账户身份或阶段'};
      return {...proof,reference_source:'tooltip',reference_at:Date.now()/1000,...daily,...maximum};
    }
    function bannerUnrealized() {
      // The desktop second-row banner has no account-upnl test ID. Read its
      // exact visible label without opening the account selector or any menu.
      const eligible = el => visible(el) && !el.closest('[role="dialog"],[role="alertdialog"],[role="menu"],[data-slot="dropdown-menu-content"]');
      const labels = /^(?:未实现盈亏|未實現盈虧|Unrealized (?:PnL|P\/L|P&L))\s*[:：]\s*(.*)$/i;
      const candidates = [...document.querySelectorAll('div.sticky.top-14')].filter(eligible).flatMap(banner => [...banner.querySelectorAll('p')].filter(eligible)).map(el => ({
        el,
        match: core.normalized(elementText(el)).match(labels)
      })).filter(item => item.match);
      if (!candidates.length) return {
        found: false,
        value: null
      };
      const values = candidates.map(({
        el,
        match
      }) => el.closest('[aria-busy="true"],[data-loading="true"]') ? null : core.parseMoney(match[1]));
      const first = values[0];
      return {
        found: true,
        value: first !== null && values.every(value => value === first) ? first : null
      };
    }
    function observerValues(expectedName, scanning = false, source) {
      observerAssertPage();
      const identity = observerIdentity();
      if (expectedName && identity.name !== expectedName) throw new Error('账户切换尚未确认，未读取资金数据');
      const equity = core.parseMoney(elementText(queryOne('[data-testid="account-value"]', document, true)));
      const banner = bannerUnrealized();
      const unrealized = banner.found ? banner.value : core.parseMoney(elementText(queryOne('[data-testid="account-upnl"]', document, true)));
      if (equity === null || unrealized === null) throw new Error('净值或浮动盈亏不可读（可能开启隐私模式）');
      let phase_snapshot;
      if (identity.phase || scanning) try {
        const current = snapshot(source);
        const reading = scanning ? withFlatAccountHealth(current) : current;
        const after = observerIdentity();
        if (after.name === identity.name && after.phase === identity.phase) phase_snapshot = reading;
      } catch {}
      const observed_at = Date.now() / 1000;
      const capital_metrics = observerCapitalMetrics();
      const percent = phase_snapshot?.account_health;
      if (Number.isFinite(percent)) capital_metrics.health = {percent};
      return {
        name: identity.name,
        equity,
        unrealized_pnl: unrealized,
        capital_metrics,
        ...(identity.phase ? {
          phase: identity.phase,
          phase_observed_at: observed_at
        } : {}),
        ...(identity.phase || scanning ? {
          phase_snapshot
        } : {}),
        ...(identity.category ? {
          category: identity.category,
          identity: identity.category + ':' + identity.name,
          status_observed_at: Date.now() / 1000
        } : {}),
        balance: Math.round((equity - unrealized) * 100) / 100,
        observed_at,
        read_error: ''
      };
    }
    function observerItems() {
      return [...document.querySelectorAll('[data-testid^="account-item-"]')].filter(el => visible(el) && !el.closest('[data-state="closed"],[aria-hidden="true"],[hidden],[inert]')).map(element => {
        const name = core.normalized(element.querySelector('span.truncate')?.textContent);
        const category = element.getAttribute('data-testid').slice('account-item-'.length);
        const labels = [...element.querySelectorAll('span')].filter(el => visible(el) && !el.classList.contains('truncate') && !el.querySelector('span.truncate')).map(el => core.normalized(el.textContent));
        return {
          element,
          name,
          category,
          phase: core.accountPhase(labels)
        };
      });
    }
    function observerSelectorOpen() {
      return observerItems().length > 0 || observerTrigger(false)?.getAttribute('aria-expanded') === 'true';
    }
    async function observerOpenSelector(guard = () => {}, outerDeadline = Infinity, assertPage = observerAssertPage) {
      guard();
      const pause = ms => delay(Math.min(ms, Math.max(0, outerDeadline - Date.now())));
      assertPage();
      if (observerItems().length) return observerItems();
      const trigger = observerTrigger();
      trigger.focus();
      // Radix opens on keyboard or pointerdown rather than a synthetic click.
      trigger.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        code: 'ArrowDown',
        bubbles: true
      }));
      await pause(180);
      guard();
      if (!observerItems().length) {
        trigger.dispatchEvent(new PointerEvent('pointerdown', {
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          bubbles: true
        }));
        trigger.dispatchEvent(new PointerEvent('pointerup', {
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          bubbles: true
        }));
        await pause(180);
        guard();
      }
      if (!observerItems().length && trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
      const deadline = Number.isFinite(outerDeadline) ? outerDeadline : Date.now() + 4500;
      while (Date.now() < deadline) {
        guard();
        assertPage();
        const items = observerItems();
        if (items.length) return items;
        await pause(150);
      }
      guard();
      throw new Error('未找到可见账户下拉列表，请确认页面已登录且为桌面布局');
    }
    async function observerCloseSelector(guard = () => {}, outerDeadline = Infinity) {
      guard();
      const pause = ms => delay(Math.min(ms, Math.max(0, outerDeadline - Date.now())));
      if (!observerSelectorOpen()) return;
      const menus = new Set(observerItems().map(item => item.element.closest('[data-slot="dropdown-menu-content"],[role="menu"]')).filter(Boolean));
      const menu = menus.size === 1 ? menus.values().next().value : null;
      (menu || observerTrigger()).dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
        cancelable: true
      }));
      await pause(120);
      guard();
      if (observerSelectorOpen()) {
        const trigger = observerTrigger();
        if (trigger.getAttribute('aria-expanded') !== 'false') {
          trigger.dispatchEvent(new PointerEvent('pointerdown', {
            pointerType: 'mouse',
            isPrimary: true,
            button: 0,
            bubbles: true
          }));
          trigger.dispatchEvent(new PointerEvent('pointerup', {
            pointerType: 'mouse',
            isPrimary: true,
            button: 0,
            bubbles: true
          }));
          await pause(120);
          guard();
          if (trigger.getAttribute('aria-expanded') === 'true') trigger.click();
        }
      }
      // Closing animations can leave the portal mounted after aria-expanded changes.
      const deadline = Math.min(outerDeadline, Date.now() + 900);
      while (observerSelectorOpen() && Date.now() < deadline) {
        await delay(Math.min(60, Math.max(0, deadline - Date.now())));
        guard();
      }
    }
    async function observerWaitStable(name, minimumDelay = 1000, {
      monitoring = false,
      scanning = false,
      source,
      samples = 3,
      deadline: outerDeadline = Infinity,
      sampleInterval = 250,
      guard = () => {}
    } = {}) {
      guard();
      await delay(Math.min(minimumDelay, Math.max(0, outerDeadline - Date.now())));
      guard();
      let previous = null;
      let matches = 0;
      let error = '账户资金读数未稳定';
      const deadline = Number.isFinite(outerDeadline) ? outerDeadline : Date.now() + 4000;
      while (Date.now() < deadline) {
        guard();
        try {
          const value = observerValues(name, scanning, source);
          const watchingPosition = monitoring || value.phase_snapshot?.position_open === true;
          const loadingFields = watchingPosition ? '[data-testid="account-value"],[data-testid="account-upnl"]' : '[data-testid="account-value"],[data-testid="account-upnl"],[data-testid^="capital-indicator-"],div.sticky.top-14[aria-busy="true"],div.sticky.top-14 [aria-busy="true"],div.sticky.top-14[data-loading="true"],div.sticky.top-14 [data-loading="true"]';
          const pending = [...document.querySelectorAll(loadingFields)].some(el => visible(el) && el.closest('[aria-busy="true"],[data-loading="true"]'));
          if (pending) throw new Error('账户数据仍在加载');
          const identity = observerIdentity().signature;
          // During monitoring, balances, fees and risk metrics can all change.
          // Wait for identity/loading, then validate the exact position in poll.
          // A scan or opening still requires stable cash and account metrics.
          const metrics = JSON.stringify(Object.fromEntries(Object.entries(value.capital_metrics).map(([key, item]) => [key, item && [item.current, item.limit, item.percent]])));
          matches = previous && previous.identity === identity && (watchingPosition || previous.metrics === metrics && Math.abs(previous.balance - value.balance) <= 0.02) ? matches + 1 : 1;
          previous = {
            identity,
            balance: value.balance,
            metrics
          };
          if (matches >= samples) return value;
        } catch (caught) {
          error = caught.message;
          matches = 0;
          previous = null;
        }
        await delay(Math.min(sampleInterval, Math.max(0, deadline - Date.now())));
      }
      guard();
      const pending = new Error(error);
      pending.code = 'OBSERVATION_PENDING';
      throw pending;
    }
    async function observerSelect(account, guard = () => {}, outerDeadline = Infinity, assertPage = observerAssertPage) {
      const guardPage = () => {
        guard();
        assertPage();
      };
      const attempts = Number.isFinite(outerDeadline) ? 1 : 2;
      let currentName;
      for (let attempt = 0; attempt < attempts; attempt++) {
        guardPage();
        // The first click can finish just as the retry starts. Keep the original target.
        if (attempt && observerIdentity(true)?.name === account.name && !observerSelectorOpen()) return;
        const items = await observerOpenSelector(guardPage, outerDeadline, assertPage);
        guardPage();
        const byName = new Map();
        for (const item of items) byName.set(item.name, byName.has(item.name) ? null : item);
        if (!byName.has(account.name)) throw Object.assign(new Error(account.name + ' 已从账户选择器消失'), {
          code: 'ACCOUNT_MISSING_FROM_SELECTOR'
        });
        const selected = byName.get(account.name);
        if (!selected) throw new Error(account.name + ' 在账户选择器中出现同名项，无法确认账户身份');
        account.category = selected.category;
        account.identity = selected.category + ':' + account.name;
        if (observerIdentity(true)?.name !== account.name) selected.element.click();
        const deadline = Number.isFinite(outerDeadline) ? outerDeadline : Date.now() + (attempt ? 5000 : 3000);
        let closeRequested = false;
        while (Date.now() < deadline) {
          guardPage();
          currentName = observerIdentity(true)?.name;
          if (currentName === account.name) {
            if (!observerSelectorOpen()) return;
            if (!closeRequested) {
              closeRequested = true;
              await observerCloseSelector(guardPage, deadline);
              continue;
            }
          }
          await delay(Math.min(150, Math.max(0, deadline - Date.now())));
        }
        guardPage();
        if (attempt + 1 < attempts) await observerCloseSelector(guardPage);
      }
      throw new Error(currentName === account.name ? `${account.name} 已显示，但账户菜单未关闭，切换无法确认` : `无法确认已切换到 ${account.name}，页面当前为 ${currentName || '未识别账户'}`);
    }
    function portfolioLimit(root, metric) {
      const indicator = queryOne('[data-testid="capital-indicator-'+metric+'"]',root);
      if (indicator) return core.parseCapitalMetric(elementText(indicator));
      // Multi-step evaluations render the two amounts beside each limit's SVG gauge.
      const gauge = queryOne('section[aria-labelledby="evaluation-limits-title"] [data-testid="multi-step-'+metric+'-gauge-progress"]',root);
      const group = gauge?.closest('svg')?.parentElement;
      return group ? core.parseCapitalMetric(elementText(queryOne('p[aria-label]',group))) : null;
    }
    async function readPortfolio(name, phase) {
      const assertPage = () => {
        assertLive();
        if (location.origin !== 'https://next.vestmarkets.com' || location.pathname.replace(/\/$/,'') !== '/portfolio')
          throw Error('全量读取账户详情需要 Portfolio 页面');
        assertNoDialogs();
      };
      const rootSelector = '[data-testid="portfolio-root"]';
      await waitForAccountIdentity(assertPage, rootSelector);
      try {
        await observerSelect({name},assertLive,Date.now()+6000,assertPage);
      } finally {
        if (observerSelectorOpen()) await observerCloseSelector(assertPage);
      }
      await delay(900);
      const deadline = Date.now()+5000;
      const busy = '[aria-busy="true"],[data-loading="true"],[data-slot="skeleton"],.animate-pulse';
      const fieldSelector = ['account-value','account-health','capital-indicator-daily-loss','capital-indicator-drawdown']
        .map(key=>'[data-testid="'+key+'"]').join(',');
      let previous, stable;
      do {
        assertPage();
        const identity = observerIdentity();
        if (identity.name !== name || phase && identity.phase && phase !== identity.phase)
          throw Error('Portfolio 当前账户或阶段与清单不符');
        const root = queryOne(rootSelector,document,true);
        const loading = [...root.querySelectorAll(fieldSelector)].some(el => visible(el) &&
          (el.closest(busy) || [...el.querySelectorAll(busy)].some(visible)));
        stable = null;
        if (!loading && !observerSelectorOpen()) {
          const read = id => elementText(queryOne('[data-testid="'+id+'"]',root));
          const daily = portfolioLimit(root,'daily-loss');
          const drawdown = portfolioLimit(root,'drawdown');
          const fields = {equity:core.parseMoney(read('account-value')),health:readAccountHealth(root)?.percent ?? null,
            daily_loss:daily?.current ?? null,daily_limit:daily?.limit ?? null,
            drawdown:drawdown?.current ?? null,drawdown_limit:drawdown?.limit ?? null};
          const unlimited = dailyUnlimited(root);
          const missing = Object.keys(fields).filter(k=>fields[k]===null && !(unlimited && k.startsWith('daily_')));
          const signature = JSON.stringify([identity.signature,missing,unlimited]);
          if (previous === signature && Object.values(fields).some(Number.isFinite)) {
            stable = {...fields,daily_unlimited:unlimited,observed_at:Date.now()/1000};
            if (!missing.length) return stable;
          }
          previous = signature;
        } else previous = null;
        await delay(250);
      } while (Date.now() < deadline);
      assertPage();
      if (stable && observerIdentity().name === name) return stable;
      throw Error('Portfolio 详情尚未加载或账户读数未稳定');
    }
    async function list() {
      try {
        const items = await observerOpenSelector(assertLive);
        const entries = new Map();
        for (const {
          name,
          category,
          phase
        } of items) {
          if (!name || !category) throw Error('账户菜单存在未识别项目');
          entries.set(name, {
            name,
            category,
            phase,
            ambiguous: entries.has(name)
          });
        }
        return [...entries.values()];
      } finally {
        await observerCloseSelector(assertLive);
      }
    }
    async function selectedRisk(identity, cardId, allowPositionRead=false) {
      const until=Date.now()+3500;
      let snapshot;
      do {
        observerAssertPage();
        const source=await hooks.nativeAccounts('selected'), now=Date.now()/1000;
        if (observerIdentity().signature!==identity.signature || observerSelectorOpen()) throw Error('核验期间交易账户或阶段已变化');
        const row=source?.row, flat=source?.flat;
        snapshot={observed_at:now,risk_source:'flat_balance',risk_issue:'identity'};
        if (cardId && source?.selected===cardId && row?.id===cardId && identity.phase && row.phase===identity.phase && row.category===identity.category) {
          Object.assign(snapshot,{reference_card_id:row.id,reference_at:source.at,reference_source:'active_accounts'});
          if (!Number.isFinite(source.at) || source.at>now || now-source.at>330) snapshot.risk_issue='limits';
          else if (flat?.count>0) {
            if (allowPositionRead) return null;
            snapshot.risk_issue='position';
            break;
          } else if (flat?.reserved===true) {
            snapshot.risk_issue='orders';
            break;
          } else if (flat?.count!==0 || !Number.isFinite(flat.equity) || !Number.isFinite(flat.at) || flat.at>now || now-flat.at>15) {
            snapshot.risk_issue='balance';
            snapshot.sources=source.sources;
          } else {
            const metrics=core.nativeCapitalMetrics(row,flat.equity,source.at,now,flat.at);
            const health=core.capitalHealth(metrics,row.daily_unlimited);
            if (health==null) snapshot.risk_issue='limits';
            else {
              delete snapshot.risk_issue;
              Object.assign(snapshot,{risk_at:flat.at,position_open:false,equity:flat.equity,balance:flat.equity,
                unrealized_pnl:0,phase:row.phase,account_health:health,capital_metrics:metrics,daily_floor:row.daily_floor,
                max_drawdown_floor:row.max_drawdown_floor,daily_reset_balance:row.daily_reset_balance,
                daily_reset_equity:row.daily_reset_equity,daily_unlimited:row.daily_unlimited});
              break;
            }
          }
        }
        if (Date.now()<until) await delay(180);
      } while (Date.now()<until);
      return {name:identity.name,category:identity.category,phase:identity.phase,snapshot};
    }
    async function read(name, category, verifyMenu = false, expectedId, readCardId, nativeRisk=false) {
      const identity = await waitForAccountIdentity(observerAssertPage);
      const selected = {
        name,
        category
      };
      const switched = identity.name !== name;
      const selectedSource = async () => {
        const cardId=expectedId || readCardId;
        if (!cardId) return null;
        const source = await hooks.nativeAccounts('selected');
        const current = observerIdentity();
        const age = Date.now()/1000-source?.at;
        return current.name===name && current.phase && source?.selected===cardId && source.row?.phase===current.phase &&
          source.row.category===current.category && age>=0 && age<=330 ? source : null;
      };
      let source = !switched && !observerSelectorOpen() ? await selectedSource() : null;
      if (switched || (verifyMenu && !source)) {
        await observerSelect(selected, assertLive);
        source = await selectedSource();
      }
      if (nativeRisk) {
        const current=observerIdentity();
        if (current.name!==name) throw Error('读取期间账户发生变化');
        const reading=await selectedRisk(current,expectedId || readCardId,!expectedId && !!readCardId);
        if (reading) {
          if (!expectedId && reading.snapshot.risk_issue) {
            const ages=Object.entries(reading.snapshot.sources || {}).map(([key,value])=>
              key+'='+ (typeof value==='number' ? Math.round(reading.snapshot.observed_at-value)+'s' : value));
            const error = Error(['当前账户交易响应未就绪',reading.snapshot.risk_issue,...ages].join(' · '));
            if (reading.snapshot.risk_issue==='balance') error.readRetry='balance';
            throw error;
          }
          return reading;
        }
      }
      const active = queryOne('[data-testid="account-tab-active-positions"]');
      if (active && !isSelected(active)) await selectTab('[data-testid="account-tab-active-positions"]', () => document, assertLive);
      const markers = source?.position && findAll(core.defaults.positionOpen,'positionOpen');
      if (markers?.length!==1 || markers[0].dataset.testid!=='position-symbol-'+source.position.position_id ||
          Date.now()/1000-source.position_at>15) await ensurePositionPanelLayout(assertLive);
      const account = await observerWaitStable(name, switched ? 1000 : 200, {
        monitoring: !switched && !verifyMenu,
        scanning: true,
        source,
        samples: 3,
        sampleInterval: 120,
        guard: assertLive
      });
      const id = observerIdentity();
      if (id.name !== name) throw Error('读取期间账户发生变化');
      const snap = account.phase_snapshot || {
        position_open: null,
        observed_at: account.observed_at
      };
      const reference = await riskReferences(id,expectedId,snap.position_reference_at ? source : null,account,expectedId || readCardId);
      if ((source || reference.reference_card_id) && readCardId && reference.reference_card_id!==readCardId)
        throw Error('读取期间平台账户身份已变化');
      if (observerIdentity().signature!==id.signature) throw Error('读取期间账户或阶段已变化');
      const restricted = ['default', 'main', 'primary', 'master', 'closed', 'failed'].includes(selected.category);
      return {
        name,
        category: restricted ? selected.category : id.category || selected.category,
        phase: id.phase,
        snapshot: {
          ...snap,
          balance: account.balance,
          equity: account.equity,
          unrealized_pnl: account.unrealized_pnl,
          capital_metrics: account.capital_metrics,
          daily_unlimited: dailyUnlimited(), ...reference
        }
      };
    }
    async function protect(job, filled, requested) {
      const corrected = await globalThis.VestStopProtection.correct({
        guard: assertArmed,
        noDialogs: assertNoDialogs,
        read: () => assertAccount(false),
        one: queryOne,
        click,
        delay,
        visible,
        intent: async (_, current, targets) => {
          await hooks.intent('protect', {
            position_id: current.position_id,
            target_prices: targets
          });
          return {
            authorize_click: true,
            target_prices: targets
          };
        }
      }, job, filled, requested);
      const failed = [corrected.stop_check, corrected.take_profit_check].find(v => v?.status === 'failed');
      if (failed) throw Object.assign(Error(failed.error), {
        snapshot: corrected
      });
      return corrected;
    }
    async function currentOpenObservation() {
      observerAssertPage();
      const identity = observerIdentity();
      if (identity.name !== config.accountName) throw Error('提交前交易账户已变化');
      return selectedRisk(identity,config.platformId);
    }
    async function prepareOpenClick(job) {
      await prepare(assertArmed);
      readyCheck();
      core.validateJob(job, config);
      if (job.size_percent) job.quantity = await selectPositionSize(job);
      else await setInput('quantity', core.nqVestToInput(job.quantity, 'micro'));
      if (job.stop_loss != null && job.stop_loss<job.quantity*0.25) {
        const reading = await currentOpenObservation();
        const checked = await hooks.preflight(reading,job.quantity);
        job.stop_loss = checked.stop_loss;
        job.take_profit = checked.take_profit ?? job.take_profit;
        job.stop_omitted = checked.stop_omitted;
        job.remaining_drawdown = checked.remaining_drawdown;
        job.distance_to_max_floor = checked.distance_to_max_floor;
        job.floor_gap = checked.floor_gap;
        core.validateJob(job,config);
      }
      const verifiedForm = () => {
        assertNoDialogs();
        if (!core.sameQuantity(core.nqInputToVest(numeric('quantity'), 'micro'), job.quantity)) throw Error('下单数量变化');
        if (job.size_percent && Number(queryOne('[role="slider"]', mainForm(true), true).getAttribute('aria-valuenow')) !== job.size_percent) throw Error('提交前仓位比例已变化');
        for (const [fieldKey, value] of [['stopLoss', job.stop_loss], ['takeProfit', job.take_profit]]) {
          if (value == null ? field(fieldKey, true).value.trim() !== '' : !core.sameQuantity(numeric(fieldKey), value)) throw Error('提交前止盈止损金额已变化');
        }
        return field(job.side === 'buy' ? 'buy' : 'sell', true);
      };
      for (let attempt = 0; ; attempt++) {
        assertArmed();
        await setInput('stopLoss', job.stop_loss ?? '');
        await setInput('takeProfit', job.take_profit ?? '');
        const observation = await currentOpenObservation();
        verifiedForm();
        const decision = await hooks.intent('open', {
          symbol: job.symbol, side: job.side, quantity: job.quantity,
          stop_loss: job.stop_loss, take_profit: job.take_profit ?? null
        }, observation, attempt < 2);
        if (decision.refill) {
          job.stop_loss = decision.stop_loss;
          job.take_profit = decision.take_profit;
          job.stop_omitted = decision.stop_omitted;
          job.remaining_drawdown = decision.remaining_drawdown;
          job.distance_to_max_floor = decision.distance_to_max_floor;
          job.floor_gap = decision.floor_gap;
          core.validateJob(job,config);
          continue;
        }
        return {verifiedForm,approved:observation.snapshot};
      }
    }
    async function openOrder(job) {
      let prepared;
      try {
        prepared = await prepareOpenClick(job);
      } catch (error) {
        // An account can become ineligible while the site is sizing the order or rebuilding its form.
        if (!error.reselect) {
          try { await hooks.preflight(await currentOpenObservation(),job.quantity); }
          catch (check) { if (check.reselect) throw check; }
        }
        throw error;
      }
      const latest=(await currentOpenObservation()).snapshot;
      if (latest.risk_issue || latest.position_open!==false || !(latest.account_health>=25) ||
          ['reference_card_id','phase','equity','account_health','daily_floor','max_drawdown_floor','daily_unlimited']
            .some(k=>latest[k]!==prepared.approved[k]) ||
          JSON.stringify(latest.capital_metrics)!==JSON.stringify(prepared.approved.capital_metrics))
        throw Error('提交许可后账户风控响应已变化，已取消点击');
      readyCheck();
      click(prepared.verifiedForm());
      const filled = await awaitPosition(job, new Set());
      const missing = [[filled.stop_check,job.stop_loss,filled.native_sl_absent],
                       [filled.take_profit_check,job.take_profit,filled.native_tp_absent]]
        .find(([check,target,absent]) => check?.status==='failed' && !(target!=null && absent===true))?.[0];
      if (missing) throw Object.assign(Error(missing.error), {
        snapshot: filled
      });
      return protect(job, filled);
    }
    async function closePosition(job, before) {
      const expected = {
        position_id: job.position_id,
        symbol: before.symbol,
        side: before.side,
        quantity: before.quantity
      };
      const button = () => {
        assertNoDialogs();
        if (!core.matchesPosition(assertAccount(false), expected)) throw Error('平仓前持仓已变化');
        const el = field('close', true);
        if (el.dataset.testid !== 'position-close-' + job.position_id) throw Error('平仓按钮与目标持仓不符');
        return el;
      };
      button();
      await hooks.intent('close', expected);
      click(button());
      await delay(450);
      assertArmed();
      const dialog = queryOne('[data-testid="close-dialog"]');
      assertNoDialogs(dialog);
      if (dialog) {
        await ensureQuantityUnit('micro', () => dialog, assertArmed, dialog);
        click(queryOne('[data-testid="size-pct-100"]', dialog, true));
        await delay(200);
        await selectTab('[data-testid="ordertype-tab-market"]', () => dialog, assertArmed, dialog);
        const confirm = queryOne(core.defaults.closeConfirm, dialog, true);
        if (queryOne('[role="slider"]', dialog, true).getAttribute('aria-valuenow') !== '100' || !core.matchesPosition(assertAccount(false), expected) || !core.sameQuantity(core.parseMoney(elementText(confirm)), expected.quantity) || queryOne('[data-testid="size-unit-select"]', dialog, true).dataset.unit !== 'micro') throw Error('无法确认全量平仓的数量与单位');
        assertNoDialogs(dialog);
        assertArmed();
        click(confirm);
      }
      return awaitPosition({
        ...job,
        type: 'close'
      }, null, expected);
    }
    async function withdraw(cmd, continuation) {
      let before = continuation && {balance:continuation.balance_before}, preview = continuation?.preview, after;
      const claim = {
        id: cmd.id,
        name: cmd.account,
        account_id: cmd.account,
        identity: observerIdentity().signature,
        policy: cmd.strategy_payout || {
          live_payout_recipient: 'main',
          live_payout_mode: cmd.params.all_available ? 'all' : 'amount',
          live_payout_amount: cmd.params.amount
        }
      };
      const flow = globalThis.VestProfitClaimFlow.create({
        guard: () => hooks.guard(true),
        identity: observerIdentity,
        visible,
        text: elementText,
        money: core.parseMoney,
        click,
        isTrade: core.isNqTradePath,
        select: async name => {
          if (observerIdentity().name !== name) throw Error('领取目标账户变化');
        },
        flat: async name => {
          const observation = await read(name, 'funded');
          const s = observation.snapshot;
          if (observation.phase !== 'live' || s.position_open !== false || s.unrealized_pnl !== 0) throw Error('领取前后需确认 Live 号空仓');
          return s;
        },
        call: async (_, data) => {
          if (data.action === 'reserve') {
            before = data.snapshot;
            if (cmd.strategy_payout && (Math.abs(before.equity-before.balance) > 0.005 ||
                cmd.strategy_payout.target_balance != null && before.balance-cmd.strategy_payout.target_balance <= 0.005))
              throw Error('Live 空仓余额或领取依据已变化');
            return {
              claim: {
                ...claim,
                status: 'preparing',
                mode_epoch: 1
              }
            };
          }
          if (data.action === 'intent') {
            preview = data.preview;
            if (preview.amount !== cmd.params.amount || preview.recipient !== 'main') {
              throw Error('提现预览与指令不符，页面可领取 '+preview.available+'，申请 '+preview.amount+'，预计实收 '+preview.received);
            }
            await hooks.intent('withdraw', {
              balance_before: before.balance,
              ...preview
            });
            return {
              authorize_click: true
            };
          }
          if (data.action === 'verify') {
            after = data.snapshot;
            if (Math.abs(after.balance - (before.balance - preview.amount)) > 0.005) throw Error('扣款后余额与预期不符，请核验平台记录');
            if (cmd.strategy_payout?.live_payout_mode === 'all' && cmd.strategy_payout.target_balance != null &&
                Math.abs(after.balance-cmd.strategy_payout.target_balance) > 0.005) throw Error('领取全部净利润后的余额未回到原指令起始余额');
            return {
              verified: true
            };
          }
          return {};
        }
      });
      try {
        if (continuation) flow.resume(claim,1,continuation.stage,continuation.started);
        else await flow.begin(claim,1);
        while (flow.active) {
          const next = await flow.run(1);
          if (next?.stage) return {continuation:{...next,balance_before:before.balance,preview}};
          if (flow.active) await delay(220);
        }
        return {
          observation: {
            name: cmd.account,
            category: 'funded',
            phase: 'live',
            snapshot: after
          },
          amount: preview.amount,
          expected_received: preview.received,
          recipient: 'main',
          balance_before: before.balance,
          balance_after: after.balance,
          verification: 'source_balance_debited'
        };
      } finally {
        flow.dispose();
      }
    }
    const history = globalThis.VestHistory.create({guard: () => { assertLive(); assertNoDialogs(); }, identity: observerIdentity,
      query: queryOne, selected: isSelected, select: selectTab, report: hooks.report});
    async function continueCommand(cmd, step) {
      const claim = cmd.action === 'profit.withdraw', portfolio = step.stage === 'portfolio';
      if (!claim && (!['history.read','profit.available'].includes(cmd.action) || !portfolio) || !portfolio && step.stage !== 'return')
        throw Error('无法识别跨页指令步骤');
      const check = () => {
        hooks.guard(claim);
        assertNoDialogs();
        if (location.origin !== 'https://next.vestmarkets.com' || !(portfolio ?
          location.pathname.replace(/\/$/,'') === '/portfolio' : core.isNqTradePath(location.pathname)))
          throw Error('指令未到达指定页面');
      };
      const id = await waitForAccountIdentity(check, portfolio ? '[data-testid="portfolio-root"]' : undefined);
      if (id.name !== cmd.account) {
        try { await observerSelect({name:cmd.account},check,Date.now()+6000,check); }
        finally { if (observerSelectorOpen()) await observerCloseSelector(check); }
      }
      check();
      const current = observerIdentity();
      if (current.name !== cmd.account || cmd.phase && current.phase !== cmd.phase || claim && current.phase !== 'live')
        throw Error('跳转后账户或阶段与指令不一致');
      if (claim) return withdraw(cmd,step);
      if (cmd.action==='profit.available') {
        if (current.phase!=='live') throw Error('只有 Live 账户可以读取可领取利润');
        return globalThis.VestProfitClaimFlow.readAvailable({account:cmd.account,guard:assertLive,identity:observerIdentity,
          visible,text:elementText,click,money:core.parseMoney});
      }
      const tables = {...step.tables,payout:(await history(cmd.account,true,true)).payout};
      if (!Object.values(tables).some(t => t.ready)) throw Error('未读到已加载的历史表格，请检查页面布局后重试');
      return {observation:step.observation,tables};
    }
    async function execute(cmd, continuation) {
      if (continuation) return continueCommand(cmd,continuation);
      if (cmd.action==='profit.available') return continueCommand(cmd,{stage:'portfolio'});
      const readOnly = cmd.action==='account.read' || cmd.action==='positions.read';
      const observation = await read(cmd.account,null,true,cmd.expected_risk?.card_id,readOnly ? cmd.read_card_id : null,
        cmd.action==='order.open' || cmd.action==='account.read' && !!cmd.read_card_id);
      let approved;
      if (cmd.action === 'order.open') approved = await hooks.preflight(observation);
      else if (!readOnly || !cmd.read_receipt) await hooks.report({observation});
      if (cmd.action === 'history.read') {
        const tables = await history(cmd.account, true);
        if (observation.phase === 'live' || ['funded','live','closed','failed'].includes(observation.category)) {
          assertNoDialogs();
          return {continuation:{stage:'portfolio',observation,tables}};
        }
        if (!Object.values(tables).some(t => t.ready)) throw Error('未读到已加载的历史表格，请检查页面布局后重试');
        return {observation, tables};
      }
      if (cmd.action === 'account.read') return {
        observation
      };
      if (cmd.action === 'positions.read') {
        if (typeof observation.snapshot.position_open !== 'boolean') throw Object.assign(Error('无法确认活动持仓'),{snapshot:observation.snapshot});
        return {
          observation
        };
      }
      hooks.guard(true);
      core.assertExecutionAllowed(observation);
      const identity = observerIdentity();
      if (cmd.phase && identity.phase !== cmd.phase) throw Error('指令阶段与页面不一致');
      config = {
        platformId: cmd.expected_risk?.card_id,
        accountId: cmd.account,
        accountName: cmd.account,
        accountCategory: observation.category,
        phase: identity.phase,
        identityText: identity.signature,
        inputUnit: 'micro',
        selectors: core.defaults
      };
      try {
        if (cmd.action === 'profit.withdraw') return await withdraw(cmd);
        const p = cmd.params;
        const job = {
          ...p,
          id: cmd.id,
          account_id: cmd.account,
          phase: identity.phase,
          symbol: 'NQ-PERP'
        };
        let current;
        if (cmd.action === 'order.open') {
          if (!['eval', 'funded', 'live'].includes(observation.category)) throw Error('该账户状态不可开仓');
          current = await openOrder({
            ...job,
            stop_loss:approved.stop_loss,
            take_profit:approved.take_profit ?? p.take_profit,
            stop_omitted:approved.stop_omitted,
            remaining_drawdown:approved.remaining_drawdown,
            distance_to_max_floor:approved.distance_to_max_floor,
            floor_gap:approved.floor_gap,
            type: 'open',
            ...(p.micro ? {
              quantity: core.nqInputToVest(p.micro, 'micro')
            } : {})
          });
        } else {
          const before = assertAccount(false);
          if (!cmd.expected_position || !core.matchesPosition(before, cmd.expected_position) || !core.sameQuantity(before.entry_price, cmd.expected_position.entry_price)) throw Error('目标持仓与页面不符');
          if (cmd.action === 'order.close') current = await closePosition(job, before);else if (cmd.action === 'position.protect') current = await protect(job, before, Object.keys(p).filter(k => k !== 'position_id'));else throw Error('不支持的指令');
        }
        return {
          observation: {
            ...observation,
            snapshot: current
          }
        };
      } finally {
        config = null;
      }
    }
    return {
      list,
      read,
      readPortfolio,
      history,
      execute
    };
  }
  globalThis.VestPage = {
    create
  };
})();
