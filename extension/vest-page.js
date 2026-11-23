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
        throw new Error('页面存在额外确认或风险弹窗；已暂停，请人工处理');
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
    function positionDetails() {
      const symbolEl = field('positionSymbol', true);
      const id = symbolEl.getAttribute('data-testid')?.match(/^position-symbol-(.+)$/)?.[1];
      const row = symbolEl.closest('tr');
      if (!id || !row) throw new Error('需要可识别持仓 ID 的桌面持仓表，不能按品种猜测控件');
      const requireSame = (key, prefix) => {
        const el = field(key, true);
        if (el.getAttribute('data-testid') !== prefix + id || el.closest('tr') !== row) throw new Error('持仓数据不属于同一持仓 ID: ' + key);
        return el;
      };
      const link = symbolEl.closest('a[href]');
      const symbolText = core.normalized(elementText(symbolEl));
      core.canonicalNqPosition(symbolText, link?.getAttribute('href'), location.href);
      const side = core.parseSide(elementText(requireSame('positionSide', 'position-side-')));
      const entry = core.parseMoney(elementText(requireSame('entryPrice', 'position-entry-')));
      const valueEl = requireSame('positionValue', 'position-value-');
      // Public Vest desktop markup: value is in the first p, quantity + market unit in the next p.
      const sizeEl = valueEl.closest('p')?.nextElementSibling;
      if (!sizeEl || sizeEl.tagName !== 'P' || !visible(sizeEl) || sizeEl.closest('tr') !== row) throw new Error('无法定位同持仓的真实数量');
      const sizeText = core.normalized(elementText(sizeEl));
      const quantity = core.parseMoney(sizeText);
      if (!side || !(entry > 0) || !(quantity > 0) || !sizeText.endsWith(' ' + symbolText)) throw new Error('持仓方向、数量或数量单位无法确认');
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
        native_tp_price: tpPrice,
        native_sl_price: slPrice,
        native_sl: slPrice > 0 && (side === 'buy' ? slPrice < entry : slPrice > entry),
        native_tp: tpPrice > 0 && (side === 'buy' ? tpPrice > entry : tpPrice < entry),
        native_sl_absent: !!protection && (!sl || /^(?:-|—|–)$/.test(core.normalized(elementText(sl)))),
        native_tp_absent: !!protection && (!tp || /^(?:-|—|–)$/.test(core.normalized(elementText(tp)))),
        native_tpsl: tpPrice > 0 && slPrice > 0 && (side === 'buy' ? tpPrice > entry && slPrice < entry : tpPrice < entry && slPrice > entry)
      };
    }
    function snapshot() {
      positionPanel(true);
      const equity = numeric('balance');
      const pnl = numeric('unrealized');
      const isOpen = core.positionState(!!field('positionOpen'), !!field('positionEmpty'));
      const details = isOpen ? positionDetails() : {
        position_id: null,
        symbol: 'NQ-PERP',
        side: null,
        quantity: null,
        entry_price: null
      };
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
      const current = assertAccount();
      const form = mainForm(true);
      for (const key of ['quantity', 'takeProfit', 'stopLoss', 'buy', 'sell']) field(key, true);
      if (field('buy') === field('sell')) throw new Error('做多与做空控件不能相同');
      const usd = queryOne('[data-testid="tpsl-unit-usd"]', form, true);
      if (!isSelected(usd)) throw new Error('请将页面止盈止损单位切到 USD，并确认选中状态');
      const limit = queryOne('[data-testid="tpsl-limit-switch"]', form, true);
      if (limit.getAttribute('aria-checked') !== 'false' && limit.dataset.state !== 'unchecked') throw new Error('止盈止损必须确认使用市场触发，请关闭 Limit');
      const market = queryOne('[data-testid="ordertype-tab-market"]', form, true);
      if (!isSelected(market)) throw new Error('必须先切换并校准市价订单');
      return current;
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
      return snapshot();
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
      if (assertAccount().position_open !== false) throw new Error('选择仓位大小前账户必须明确空仓');
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
        if (assertAccount().position_open !== false) throw new Error('选择仓位大小期间持仓变化');
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
      if ([...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].some(visible)) throw new Error('页面存在弹窗，请先关闭后再读取账户');
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
    function observerCapitalMetrics() {
      let phase = null;
      try {
        phase = observerIdentity().phase;
      } catch {}
      const eligible = el => visible(el) && !el.closest('[role="dialog"],[role="alertdialog"],[role="menu"]');
      const banners = [...document.querySelectorAll('div.sticky.top-14')].filter(eligible);
      const observed_at = Date.now() / 1000;
      return Object.fromEntries(core.CAPITAL_INDICATORS.map(({
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
        const readings = sources.map(({
          el,
          text
        }) => el.closest('[aria-busy="true"],[data-loading="true"]') ? null : core.parseCapitalMetric(text));
        const first = readings[0];
        const consistent = first && readings.every(item => item && ['current', 'limit', 'percent'].every(field => item[field] === first[field]));
        return [key, consistent ? {
          ...first,
          observed_at,
          ...(phase ? {
            phase
          } : {})
        } : null];
      }));
    }
    function dailyUnlimited(scope = document) {
      return [...scope.querySelectorAll('div.sticky.top-14 p,[data-testid="capital-indicator-daily-loss"]')].some(el =>
        visible(el) && /^(?:(?:max\.? daily loss|最大日亏损)\s*[:：]\s*)?(?:no daily loss limit|unlimited|无每日亏损上限|无日损限制|不限)$/i.test(core.normalized(el.innerText)));
    }
    async function dailyReference(name) {
      const groups = [...document.querySelectorAll('[data-testid="capital-indicator-daily-loss"]')]
        .filter(visible).map(el=>el.parentElement).filter(el=>el && el!==document.body);
      const group = groups.find(el=>el.querySelector('[data-slot="tooltip-trigger"]')) || groups[0];
      if (!group) return {};
      const trigger = group.querySelector('[data-slot="tooltip-trigger"]');
      const readLabels = () => {
        const linked = trigger?.getAttribute('aria-describedby');
        const tooltip = linked && document.getElementById(linked);
        const result = {};
        for (const root of [group,tooltip].filter(Boolean)) {
          for (const el of root.querySelectorAll('p,span,div')) {
            if (el.children.length && !el.matches('span')) continue;
            const label = core.normalized(el.textContent);
            const m = label.match(/^(8\s*pm ET balance|美东时间晚上\s*8\s*点余额|today['’]s floor|今日底线|今日底線)\s*[:：]\s*(\$?\s*[\d,]+(?:\.\d+)?)$/i);
            if (!m) continue;
            if (!visible(el) && root!==tooltip) continue;
            result[/^(?:8|美东)/.test(m[1])?'daily_reset_equity':'daily_floor'] = core.parseMoney(m[2]);
          }
        }
        return result;
      };
      let result = readLabels();
      if ((!result.daily_reset_equity || result.daily_floor==null) && trigger && visible(trigger)) {
        const opts = {bubbles:true,pointerType:'mouse'};
        try {
          trigger.dispatchEvent(new PointerEvent('pointerover',opts));
          trigger.dispatchEvent(new PointerEvent('pointermove',opts));
          for (let i=0;i<10;i++) {
            await delay(110);
            assertLive();
            if (observerIdentity().name!==name) throw Error('读取日损基准时账户已变化');
            result = readLabels();
            if (result.daily_reset_equity || result.daily_floor!=null) break;
          }
        } finally {
          trigger.dispatchEvent(new PointerEvent('pointerout',{...opts,relatedTarget:document.body}));
        }
      }
      return result;
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
    function observerValues(expectedName, scanning = false) {
      observerAssertPage();
      const identity = observerIdentity();
      if (expectedName && identity.name !== expectedName) throw new Error('账户切换尚未确认，未读取资金数据');
      const equity = core.parseMoney(elementText(queryOne('[data-testid="account-value"]', document, true)));
      const banner = bannerUnrealized();
      const unrealized = banner.found ? banner.value : core.parseMoney(elementText(queryOne('[data-testid="account-upnl"]', document, true)));
      if (equity === null || unrealized === null) throw new Error('净值或浮动盈亏不可读（可能开启隐私模式）');
      let phase_snapshot;
      if (identity.phase || scanning) try {
        const current = snapshot();
        const reading = scanning ? withFlatAccountHealth(current) : current;
        const after = observerIdentity();
        if (after.name === identity.name && after.phase === identity.phase) phase_snapshot = reading;
      } catch {}
      const observed_at = Date.now() / 1000;
      const capital_metrics = observerCapitalMetrics();
      const percent = phase_snapshot?.account_health;
      if (Number.isFinite(percent)) capital_metrics.health = {
        text: `${percent}%`,
        percent,
        current: null,
        limit: null,
        observed_at: phase_snapshot.observed_at
      };
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
          const value = observerValues(name, scanning);
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
    async function read(name, category, verifyMenu = false) {
      const identity = await waitForAccountIdentity(observerAssertPage);
      const selected = {
        name,
        category
      };
      const switched = identity.name !== name;
      if (switched || verifyMenu) await observerSelect(selected, assertLive);
      const active = queryOne('[data-testid="account-tab-active-positions"]');
      if (active && !isSelected(active)) await selectTab('[data-testid="account-tab-active-positions"]', () => document, assertLive);
      await ensurePositionPanelLayout(assertLive);
      const account = await observerWaitStable(name, switched ? 1000 : 200, {
        monitoring: !switched && !verifyMenu,
        scanning: true,
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
      const reference = await dailyReference(name);
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
    async function openOrder(job) {
      await prepare(assertArmed);
      if (readyCheck().position_open !== false) throw Error('开仓前需确认空仓');
      core.validateJob(job, config);
      if (job.size_percent) job.quantity = await selectPositionSize(job);
      else await setInput('quantity', core.nqVestToInput(job.quantity, 'micro'));
      if (job.stop_loss != null && job.stop_loss<job.quantity*0.25) {
        const reading = await read(config.accountName,config.accountCategory);
        const checked = await hooks.preflight(reading,job.quantity);
        job.stop_loss = checked.stop_loss;
        job.stop_omitted = checked.stop_omitted;
        job.remaining_drawdown = checked.remaining_drawdown;
        core.validateJob(job,config);
      }
      await setInput('stopLoss', job.stop_loss ?? '');
      await setInput('takeProfit', job.take_profit ?? '');
      const beforeSubmit = () => {
        assertArmed();
        if (observerIdentity().category === 'passed' || (readAccountHealth()?.percent ?? 100) < 25) throw Error('账户当前不可开仓');
        if (readyCheck().position_open !== false || !core.sameQuantity(core.nqInputToVest(numeric('quantity'), 'micro'), job.quantity)) throw Error('持仓状态或下单数量变化');
        if (job.size_percent && Number(queryOne('[role="slider"]', mainForm(true), true).getAttribute('aria-valuenow')) !== job.size_percent) throw Error('提交前仓位比例已变化');
        for (const [fieldKey, value] of [['stopLoss', job.stop_loss], ['takeProfit', job.take_profit]]) {
          if (value == null ? field(fieldKey, true).value.trim() !== '' : !core.sameQuantity(numeric(fieldKey), value)) throw Error('提交前止盈止损金额已变化');
        }
        return field(job.side === 'buy' ? 'buy' : 'sell', true);
      };
      beforeSubmit();
      const reference = await dailyReference(config.accountName);
      const latest = observerValues(config.accountName,true);
      const latestId = observerIdentity();
      await hooks.intent('open', {
        symbol: job.symbol,
        side: job.side,
        quantity: job.quantity,
        stop_loss: job.stop_loss,
        take_profit: job.take_profit ?? null
      }, {name:latestId.name,category:latestId.category,phase:latestId.phase,
        snapshot:{...latest.phase_snapshot,observed_at:latest.observed_at,equity:latest.equity,balance:latest.balance,
          unrealized_pnl:latest.unrealized_pnl,capital_metrics:latest.capital_metrics,daily_unlimited:dailyUnlimited(),...reference}});
      click(beforeSubmit());
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
    async function withdraw(cmd) {
      let before, preview, after;
      const claim = {
        id: cmd.id,
        name: cmd.account,
        account_id: cmd.account,
        identity: config.identityText,
        policy: cmd.strategy_payout || {
          live_payout_recipient: 'main',
          live_payout_mode: 'amount',
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
                before.balance-cmd.strategy_payout.target_balance <= 0.005)) throw Error('Live 空仓余额或可领净利润已变化');
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
            if (preview.amount !== cmd.params.amount || preview.recipient !== 'main') throw Error('提现预览与指令不符');
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
            if (cmd.strategy_payout?.live_payout_mode === 'all' && Math.abs(after.balance-cmd.strategy_payout.target_balance) > 0.005) throw Error('领取全部净利润后的余额未回到阶段起始余额');
            return {
              verified: true
            };
          }
          return {};
        }
      });
      try {
        await flow.begin(claim, 1);
        while (flow.active) {
          await flow.run(1);
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
    async function payoutHistory(name, deep = true) {
      const owner = observerIdentity();
      const portfolio = core.navigationLink(['/portfolio'], /^(持仓|持倉|Portfolio|Positions)$/i, visible);
      if (!portfolio) return {available: false, reason: '未找到 Portfolio 导航'};
      const arrive = async matches => {
        const deadline = Date.now() + 5500;
        do {
          assertLive();
          assertNoDialogs();
          if (matches(location.pathname) && observerIdentity(true)?.name === name) return;
          await delay(150);
        } while (Date.now() < deadline);
        throw Error('页面跳转后未能核对来源账户');
      };
      assertNoDialogs();
      if (owner.name !== name) throw Error('出金历史账户不一致');
      click(portfolio);
      try {
        await arrive(path => path.replace(/\/$/, '') === '/portfolio');
        return (await history(name, deep, true)).payout;
      } finally {
        assertLive();
        assertNoDialogs();
        if (location.pathname.replace(/\/$/, '') === '/portfolio' && observerIdentity(true)?.name === name) {
          const trade = core.navigationLink(['/trade/NQ-PERP','/trade/NDX-USD-PERP','/trade'], /^(交易|Trade)$/i, visible);
          if (!trade) throw Error('已读取 Portfolio，请通过交易导航返回 NQ 页');
          click(trade);
          await arrive(core.isNqTradePath);
        }
      }
    }
    async function execute(cmd) {
      const observation = await read(cmd.account, null, true);
      let approved;
      if (cmd.action === 'order.open') approved = await hooks.preflight(observation);
      else await hooks.report({observation});
      if (cmd.action === 'history.read') {
        const tables = await history(cmd.account, true);
        if (observation.phase === 'live' || ['funded','live','closed','failed'].includes(observation.category)) {
          tables.payout = await payoutHistory(cmd.account);
        }
        if (!Object.values(tables).some(t => t.ready)) throw Error('未读到已加载的历史表格，请检查页面布局后重试');
        return {observation, tables};
      }
      if (cmd.action === 'account.read') return {
        observation
      };
      if (cmd.action === 'positions.read') {
        if (typeof observation.snapshot.position_open !== 'boolean') throw Error('无法确认活动持仓');
        return {
          observation
        };
      }
      hooks.guard(true);
      core.assertExecutionAllowed(observation);
      const identity = observerIdentity();
      if (cmd.phase && identity.phase !== cmd.phase) throw Error('指令阶段与页面不一致');
      config = {
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
            stop_omitted:approved.stop_omitted,
            remaining_drawdown:approved.remaining_drawdown,
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
      payoutHistory,
      execute
    };
  }
  globalThis.VestPage = {
    create
  };
})();
