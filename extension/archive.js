/* Shared whitelist for native GET responses and operator-imported JSON pages. */
(() => {
  'use strict';
  if (Object.hasOwn(globalThis,'VestArchive')) return;
  const paths = {
    '/v3/capital/accounts/active':'account_history', '/v3/capital/accounts/history':'account_history',
    '/v3/history/orders':'order', '/v3/history/deposits':'deposit', '/v3/history/withdrawals':'chain_withdrawal',
    '/v3/history/payouts':'platform_payout', '/v3/positions':'position'
  };
  const short = v => (typeof v==='string' || Number.isSafeInteger(v)) && String(v).length<=160 && !/[\x00-\x1f]/.test(String(v)) ? String(v).trim() || null : null;
  const amount = v => (typeof v==='number' || typeof v==='string' && /^-?\d+(?:\.\d+)?$/.test(v)) &&
    Number.isFinite(+v) && Math.abs(+v)<=1e12 ? +v : null;
  function stamp(v) {
    const n=typeof v==='number' || typeof v==='string' && /^\d+(?:\.\d+)?$/.test(v) ? Number(v) : null;
    const at=n!==null ? (n>=1e12 ? n/1000 : n) :
      typeof v==='string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/i.test(v) ? Date.parse(v)/1000 : null;
    return at>0 && at<32503680000 ? at : null;
  }
  function project(kind,r,account) {
    if (!r || typeof r!=='object') return null;
    if (kind==='position') {
      const owner=short(r.accountId ?? r.account_id ?? account), ref=short(r.positionId);
      const closed_at=stamp(r.closeDate),opened_at=stamp(r.openDate);
      if (!owner || account && owner!==account || r.account_id!=null && short(r.account_id)!==owner ||
          !ref || !closed_at || opened_at && opened_at>closed_at || !short(r.symbol)) return null;
      return {kind,ref,source_account_id:owner,opened_at,closed_at,pnl:amount(r.pnl),
        symbol:r.symbol==='NDX-USD-PERP' ? 'NQ-PERP' : short(r.symbol),
        side:r.side==='long' ? 'buy' : r.side==='short' ? 'sell' : short(r.side),
        quantity:amount(r.quantity),entry_price:amount(r.openPrice),exit_price:amount(r.closePrice)};
    }
    const ref=short(r.id), created_at=stamp(r.created_at);
    if (!ref || !created_at) return null;
    const base={kind,ref,created_at,updated_at:stamp(r.updated_at) || created_at};
    if (kind==='account_history') {
      if (![2,3].includes(r.account_type) || !Number.isInteger(r.status)) return null;
      return {...base,source_account_id:ref,name:Number.isSafeInteger(r.attempt_index) && r.attempt_index>=0 ?
        'Account '+String(r.attempt_index+1).padStart(2,'0') : ref,
        status:String(r.status),phase:r.account_type===3 ? 'live' : [1,2].includes(r.step) && r.steps_total===2 ? r.step+'/2' : null,
        plan:short(r.plan_name),root_account_id:short(r.root_account_id),initial_capital:amount(r.initial_capital),final_equity:amount(r.final_equity),
        activated_at:stamp(r.activated_at),finalized_at:stamp(r.finalized_at),blocked_at:stamp(r.blocked_at),expires_at:stamp(r.expires_at)};
    }
    if (kind==='order') {
      const id=short(r.account_id) || short(account);
      if (!id || (account && account!==id) || !short(r.symbol)) return null;
      return {...base,source_account_id:id,symbol:short(r.symbol),side:short(r.side),order_type:short(r.order_type),
        status:short(r.status),quantity:amount(r.quantity),executed_quantity:amount(r.executed_quantity),
        execution_price:amount(r.execution_price),fee:amount(r.fee),executed_at:stamp(r.executed_at)};
    }
    if (kind==='platform_payout') {
      const source=short(r.account_id),status=short(r.status);
      if (!source || (account && source!==account) || !status) return null;
      return {...base,source_account_id:source,phase:'live',status:status.toLowerCase(),gross_amount:amount(r.requested_amount),
        net_amount:amount(r.trader_amount),platform_amount:amount(r.platform_amount),executed_at:stamp(r.executed_at)};
    }
    const value=amount(r.amount), status=short(r.status);
    if (value===null || value<0 || !status) return null;
    return {...base,amount:value,status:status.toLowerCase(),currency:short(r.currency),chain_id:short(r.chain_id),tx_hash:short(r.tx_hash)};
  }
  function archiveKind(url) {
    return !url.username && !url.password && url.origin==='https://api-gateway.hz.vestmarkets.com' && Object.hasOwn(paths,url.pathname) ? paths[url.pathname] : null;
  }
  Object.defineProperty(globalThis,'VestArchive',{value:Object.freeze({project,archiveKind,stamp})});
})();
