/* Recognize Vest's completed account events before leasing trading work. */
(() => {
  'use strict';
  const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const all = (root, selector) => [...root.querySelectorAll(selector)].filter(visible);
  const one = (root, selector) => {
    const elements = all(root, selector);
    return elements.length === 1 ? elements[0] : null;
  };
  const text = el => VestBridgeCore.normalized(el?.textContent);
  function inspect() {
    const dialog = one(document, '[role="dialog"],[role="alertdialog"]');
    if (!dialog || dialog.getAttribute('role') !== 'dialog' || dialog.matches('[data-testid="close-dialog"]') ||
        all(document,'[data-testid="confirm-order-submit"],[data-testid="close-submit"]').length) return null;
    const title = one(dialog,'[data-slot="dialog-title"]');
    if (!title) return null;
    let description = one(dialog,'[data-slot="dialog-description"]');
    if (!description) {
      const siblings = [...(title.closest('[data-slot="dialog-header"]')?.children || [])]
        .filter(el => visible(el) && el !== title && !el.contains(title));
      if (siblings.length === 1) description = siblings[0];
    }
    const heading = text(title), detail = text(description);
    const buttons = all(dialog,'button');
    let kind, action, ready = true;
    if (/^(Step 1 Completed!|第\s*1\s*阶段已完成[！!])$/i.test(heading) &&
        /(?:Step 2 of 2|第\s*2\s*\/\s*2\s*阶段)/i.test(detail)) {
      const status = text(one(dialog,'[data-testid="step-status"]'));
      ready = /^(Step 2 is ready\.|第\s*2\s*阶段已准备就绪。)$/i.test(status);
      if (!ready && !/^(Preparing Step 2\.\.\.|正在准备第\s*2\s*阶段\.\.\.)$/i.test(status)) return null;
      kind = 'phase2';
      action = /^(Start Next Step|开始下一阶段)$/i;
    } else if (/^(评估通过|Evaluation Passed)$/i.test(heading) &&
        /^(?:恭喜\s*[-–]\s*您已通过评估阶段。\s*您的\s*\$[\d,]+(?:\.\d+)?\s*Funded Account\s*现已转为实盘。|Congratulations\s*[-–]\s*you've passed the Evaluation Phase\.\s*Your\s+\$[\d,]+(?:\.\d+)?\s+Funded Account is now live\.)$/i.test(detail)) {
      kind = 'live';
      action = /^(Go to Funded Account|前往 Funded Account)$/i;
    } else if (/^(?:您的每日[亏虧][损損][额額]度已用完|您的回撤额度已用完|您已触及每日亏损上限|您的账户已关闭|您的帳戶已關閉|Your (?:daily loss|drawdown) ran out|Your daily loss (?:limit|allowance) (?:has been (?:reached|exceeded|exhausted)|is exhausted)|Daily loss limit (?:reached|exceeded)|Maximum drawdown (?:reached|exceeded)|Account closed|Your account (?:has been|is) closed)$/i.test(heading) &&
        /(?:账户|帳戶).{0,80}(?:已关闭|已關閉)|\byour account\b.{0,100}\b(?:has (?:now )?been closed|is (?:now )?closed)\b/i.test(detail) &&
        /每日[亏虧][损損]|回撤|daily loss|drawdown/i.test(heading+' '+detail)) {
      kind = 'closed';
      action = /^(Close|关闭|關閉)$/i;
    } else return null;
    const actions = buttons.filter(el => action.test(kind === 'closed' ?
      VestBridgeCore.normalized(el.getAttribute('aria-label') || text(el)) : text(el)));
    if (actions.length !== 1) return null;
    const button = actions[0];
    if (kind !== 'closed' && buttons.some(el => el !== button &&
        !/^(Close|关闭|關閉)$/i.test(el.getAttribute('aria-label') || text(el)) &&
        !(kind === 'phase2' ? /^(Got It|知道了|明白了)$/i : /^(I Understand|我理解)$/i).test(text(el)))) return null;
    return {kind, dialog, button, ready: ready && !button.matches(':disabled,[aria-disabled="true"],[aria-busy="true"]')};
  }

  async function handle(state, {guard, native, send}) {
    const notice = inspect(), pending = state.pending;
    if (!state.enabled) {
      const label = {phase2:'第 1 阶段已完成',live:'评估通过',closed:'账户已关闭'}[pending?.kind || notice?.kind];
      return label ? label+' · 已保留弹窗，等待运行中的策略授权' : '';
    }
    if (!pending && !notice) return '';
    const source = await native('notice',pending?.platform_id);
    guard(true);
    const valid = source?.selected && Date.now()/1000-source.at <= 330;
    if (pending) {
      const terminal = pending.kind === 'closed';
      const covered = all(document,'[role="dialog"],[role="alertdialog"]').length > 0;
      if (covered || !valid ||
          !(terminal ? source.prior_active === false :
            source.row?.root === pending.root && source.selected !== pending.platform_id &&
            source.row.phase === (pending.kind === 'phase2' ? '2/2' : 'live') &&
            source.count === 0 && Date.now()/1000-source.positions_at <= 90)) {
        if (!covered && Date.now()/1000-pending.started>4)
          await send('notice.recheck',{platform_id:pending.platform_id,started:pending.started});
        return pending.name+(Date.now()/1000-pending.started>20 ? ' · 阶段处理超过 20 秒，请核对页面；已保留原操作记录' : ' · 等待核验账户状态和弹窗处理结果');
      }
      await send('notice.complete',{platform_id:pending.platform_id,kind:pending.kind,
        selected:source.selected,root:source.row?.root,phase:source.row?.phase ?? null,
        prior_active:source.prior_active,count:source.count,positions_at:source.positions_at});
      return '';
    }
    if (!valid) return '等待页面确认弹窗所属的平台账户';
    const fresh = inspect();
    if (!fresh || fresh.dialog !== notice.dialog || fresh.button !== notice.button || fresh.kind !== notice.kind) return '账户提示已变化，等待重新核验';
    if (!fresh.ready) return '等待 Vest 的账户阶段按钮就绪';
    const roots = source.successor_roots || [];
    const allowed = await send('notice.reserve',{platform_id:source.selected,kind:fresh.kind,
      successor_roots:fresh.kind==='phase2' ? (roots.includes(source.selected) ? [source.selected] : roots) : undefined,
      active:!!source.row,active_phase:source.row?.phase ?? null});
    guard(true);
    const current = await native('notice');
    guard(true);
    const last = inspect();
    if (!allowed?.authorize || current?.selected !== source.selected || !last?.ready ||
        fresh.kind==='phase2' && !current.successor_roots?.includes(allowed.root) ||
        last.dialog !== fresh.dialog || last.button !== fresh.button || last.kind !== fresh.kind)
      return '账户或弹窗已变化，请核对阶段处理记录';
    last.button.click();
    return allowed.name+' · 已处理账户提示，等待平台回执';
  }
  globalThis.VestAccountNotices = {inspect,handle};
})();
