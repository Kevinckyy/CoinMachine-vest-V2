/* Project the account responses that the Vest page already requests. */
(() => {
  'use strict';
  if (Object.hasOwn(window,'vestFleetSnapshotsV2')) return;
  const gateway = 'https://api-gateway.hz.vestmarkets.com';
  const accounts = {url:gateway+'/v3/capital/accounts/active', parse:accountRows, sequence:0};
  const positions = {url:gateway+'/v3/positions/opened', parse:openedPositions, sequence:0};
  const balances = {parse:body=>indexed(body?.accounts,'account_id',r=>signed(r.amount)),sequence:0};
  const orders = {url:gateway+'/v3/positions/opened-orders',parse:body=>{
    // Vest represents an empty order registry as an empty object or a null collection.
    if (Array.isArray(body) && body.length===0) return new Set();
    if (body && typeof body==='object' && !Array.isArray(body) &&
        (Object.keys(body).length===0 || Object.hasOwn(body,'orders') && body.orders===null)) return new Set();
    if (!Array.isArray(body?.orders) || body.orders.length>2000) return;
    const owners=new Set();
    for (const r of body.orders) {
      // Vest excludes reduce-only margin from account equity, even when the row has no owner.
      if (r?.reduce_only===true || r?.reduceOnly===true) continue;
      const id=r?.account_id ?? r?.accountId;
      if (typeof id!=='string' || !id || r.accountId!=null && r.accountId!==id) return;
      owners.add(id);
    }
    return owners;
  },sequence:0};
  const series=new Map();
  let lastSeriesAt=0;
  const signed=v=>(typeof v==='number' || typeof v==='string' && /^-?\d+(?:\.\d+)?$/.test(v)) &&
    Number.isFinite(+v) && Math.abs(+v)<=1e12 ? +v : null;
  function indexed(rows,key,value) {
    if (!Array.isArray(rows) || rows.length>2000) return;
    const result=new Map();
    for (const r of rows) {
      if (typeof r?.[key]!=='string' || !r[key] || result.has(r[key])) return;
      result.set(r[key],value(r));
    }
    return result;
  }
  function performanceRows(body) {
    if (!Array.isArray(body?.items) || body.items.length>50000) return;
    const now=Date.now()/1000;
    for (const r of body.items) {
      const id=r?.account_id, at=globalThis.VestArchive.stamp(r?.ts);
      if (at && at<=now+1) lastSeriesAt=Math.max(lastSeriesAt,at);
      if (typeof id!=='string' || !id || !at || at>now+1 || now-at>600 || at<(series.get(id)?.at || 0)) continue;
      const collateral=signed(r.collateral_value), pnl=signed(r.total_unrealized_pnl);
      const equity=signed(r.equity_value) ?? (collateral!==null && pnl!==null ? collateral+pnl : null);
      if (equity!==null) series.set(id,{equity,at});
    }
  }
  const money = value => (typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) &&
    Number.isFinite(Number(value)) && Number(value)>=0 && Number(value)<=1e12 ? Number(value) : null;
  const queue = [];
  const archived = new Map();
  let serial=0;
  const {project,archiveKind}=globalThis.VestArchive;
  function captureArchive(url,payload) {
    const kind=archiveKind(url), rows=kind==='account_history' ? payload?.accounts : kind==='position' ? payload?.positions : payload?.items;
    if (!kind || !Array.isArray(rows) || rows.length>2000) return;
    const id=url.searchParams.get('account_id');
    const items=[];
    for (const raw of rows) {
      const item=project(kind,raw,id);
      if (!item) continue;
      const compact=Object.fromEntries(Object.entries(item).filter(([,v])=>v!=null));
      const key=JSON.stringify([kind,item.source_account_id,item.ref]), signature=JSON.stringify(compact);
      if (archived.get(key)===signature) continue;
      archived.set(key,signature);
      if (archived.size>5000) archived.delete(archived.keys().next().value);
      items.push(compact);
    }
    for (let i=0;i<items.length;i+=50) queue.push({seq:++serial,items:items.slice(i,i+50)});
    if (items.length) window.dispatchEvent(new Event('vest-fleet-archive-ready'));
  }
  Object.defineProperty(window,'vestFleetReadArchiveV1',{value:(ack) => {
    if (ack!==undefined) {
      if (queue[0]?.seq===ack) queue.shift();
      return queue.length>0;
    }
    return queue.length ? structuredClone(queue[0]) : null;
  }});
  function endpoint(url) {
    try {
      const u=new URL(url,location.href);
      if (u.origin===gateway && u.pathname==='/v3/accounts' && u.searchParams.get('active')==='true' &&
          [...u.searchParams.keys()].every(k=>['active','limit'].includes(k))) return balances;
      return [accounts,positions,orders].find(channel=>channel.url===u.href) || null;
    } catch { return null; }
  }
  function accountRows(payload) {
    if (!Array.isArray(payload?.accounts) || payload.accounts.length>500) return;
    const rows = [], ids = new Set();
    for (const raw of payload.accounts) {
      if (!raw || typeof raw.id!=='string' || !raw.id || raw.id.length>160 || ids.has(raw.id)) return;
      ids.add(raw.id);
      // Vest Capital types 2/3 and stages 1/2 denote Evaluation and Funded.
      const type = raw.account_type, status = raw.status;
      if (type===1 || type===8) continue;
      if (![2,3].includes(type) || ![1,2,3,4,5,6,7].includes(status)) return;
      if (status!==2 || raw.blocked_at) continue;
      const live = type===3;
      if (raw.stage!==(live?2:1)) return;
      const step = raw.step ?? 1, steps = raw.steps_total ?? 1;
      const phase = live ? 'live' : steps===2 && [1,2].includes(step) ? step+'/2' : null;
      const index = raw.attempt_index;
      const name = Number.isSafeInteger(index) && index>=0 ? 'Account '+String(index+1).padStart(2,'0') : 'Legacy Account';
      const rate = money(raw.max_daily_loss_pct);
      rows.push({id:raw.id,root:typeof raw.root_account_id==='string' && raw.root_account_id || raw.id,name,phase,category:live?'funded':'eval',daily_unlimited:rate===0,
        daily_floor:rate===0 ? null : money(raw.daily_loss_floor),max_drawdown_floor:money(raw.max_drawdown_limit),
        initial_capital:money(raw.initial_capital),daily_limit:money(raw.daily_reset_base_limit),
        daily_rate:rate,daily_reset_at:globalThis.VestArchive.stamp(raw.daily_reset_at),
        daily_reset_balance:money(raw.daily_reset_balance),daily_reset_equity:money(raw.daily_reset_equity)});
    }
    return rows;
  }
  function protectionLeg(rows, quantity, key) {
    if (!Array.isArray(rows)) return {};
    // Vest's position table shows awaiting legs. Triggered and cancelled legs can still be present in the array.
    const active=rows.filter(leg=>leg?.status!=='cancelled' && leg?.status!=='triggered');
    if (!active.length) return {['native_'+key+'_absent']:true,['native_'+key+'_price']:null};
    const [leg]=active;
    const single=active.length===1 && leg?.status==='awaiting' && leg.executionType==='market' &&
      (leg.sizeMode==='full_position' || leg.sizeMode==='fixed' && money(leg.quantity)===quantity);
    // Preserve an explicit but unsupported protection instead of treating it as an empty leg.
    return {['native_'+key+'_absent']:false,['native_'+key+'_price']:single ? money(leg.triggerPrice) : null};
  }
  function openedPositions(payload) {
    // Vest sends an explicit null collection when the user has no open positions.
    if (Object.hasOwn(payload,'positions') && payload.positions===null && !(Number(payload.total)>0)) return new Map();
    if (!Array.isArray(payload?.positions)) {
      positions.state='invalid-positions';
      return;
    }
    if (payload.positions.length>1000) return;
    const byAccount=new Map(), ids=new Set();
    for (const p of payload.positions) {
      const accountId=p?.accountId ?? p?.account_id;
      if (!p || typeof accountId!=='string' || !accountId || accountId.length>160 ||
          (p.account_id!=null && p.account_id!==accountId) ||
          typeof p.positionId!=='string' || !p.positionId || p.positionId.length>160 || ids.has(p.positionId)) {
        positions.state='invalid-position-identity';
        return;
      }
      ids.add(p.positionId);
      const quantity=money(p.quantity), entry=money(p.openPrice);
      const side=p.side==='long' ? 'buy' : p.side==='short' ? 'sell' : null;
      const count=(byAccount.get(accountId)?.count || 0)+1;
      const usable=count===1 && p.symbol==='NDX-USD-PERP' && side && quantity>0 && entry>0;
      byAccount.set(accountId,{count,position:usable ? {position_id:p.positionId,side,quantity,entry_price:entry,
        ...protectionLeg(p.takeProfits,quantity,'tp'),...protectionLeg(p.stopLosses,quantity,'sl'),
        ...(Number.isSafeInteger(p.openDate) && p.openDate>=1e12 && p.openDate<=Date.now()+1000 ? {opened_at:p.openDate/1000} : {})} : null});
    }
    return byAccount;
  }
  function begin(channel) {
    const ticket=++channel.sequence, at=Date.now()/1000;
    channel.snapshot=null;
    channel.pending=at;
    channel.state='pending';
    return payload=>{
      if (ticket!==channel.sequence) return;
      channel.pending=null;
      channel.state=!payload || payload.error || payload.errors?.length || payload.success===false ? 'failed' :
        payload.next || payload.next_cursor || payload.has_more || payload.hasMore || payload.nextCursor ? 'partial' : 'invalid';
      if (channel.state!=='invalid') return;
      const rows=channel.parse(payload);
      if (rows) {
        channel.snapshot={at,rows};
        channel.state='ready';
      }
    };
  }
  function flatBalance(id,pos,ord,bal) {
    const count=pos ? pos.rows.get(id)?.count || 0 : null;
    const reserved=ord ? ord.rows.has(id) : null;
    const amount=count===0 && reserved===false ? bal?.rows.get(id) : null;
    return {count,reserved,equity:amount ?? null,at:amount!=null ? Math.min(pos.at,ord.at,bal.at) : null};
  }
  // The extension reads a copy from the exact bound document. No request headers, tokens,
  // page functions, or unrelated response bodies are passed across worlds.
  Object.defineProperty(window,'vestFleetSnapshotsV2',{value:(scope='directory',priorId='') => {
    const snapshot=accounts.snapshot;
    if (scope===true) return {at:snapshot?.at ?? null,pending_at:accounts.pending ?? null,bulk_version:1,
      trade_at:Math.min(...[balances,orders,positions].map(ch=>ch.snapshot?.at || 0))};
    if (!snapshot) return null;
    if (scope==='inventory') {
      const opened=positions.snapshot;
      return {at:snapshot.at,position_at:opened?.at ?? null,
        rows:snapshot.rows.map(({id,name,phase,category})=>({id,name,phase,category,
          active_positions:opened ? opened.rows.get(id)?.count ?? 0 : null}))};
    }
    if (scope==='bulk') {
      const now=Date.now()/1000;
      const fresh=(channel,maxAge)=>channel.snapshot && now-channel.snapshot.at<=maxAge ? channel.snapshot : null;
      const pos=fresh(positions,90), bal=fresh(balances,330), ord=fresh(orders,90);
      return {at:snapshot.at,ready:!!(pos && bal && ord),sources:{
        balances:balances.snapshot?.rows.size ?? null,positions:positions.snapshot?.rows.size ?? null,
        orders:orders.snapshot?.rows.size ?? null,series:series.size,
        balance_state:balances.state || 'unseen',position_state:positions.state || 'unseen',order_state:orders.state || 'unseen',
        series_age:lastSeriesAt ? Math.max(0,Math.round(now-lastSeriesAt)) : null
      },rows:snapshot.rows.map(row=>{
        const id=row.id, flat=flatBalance(id,pos,ord,bal);
        const chart=series.get(id);
        const recent=chart && now-chart.at<=600 && chart.at>=(flat.at || 0);
        return {...row,active_positions:flat.count,equity:recent ? chart.equity : flat.equity,
          equity_source:recent ? 'performance_series' : flat.at ? 'flat_balance' : null,
          equity_at:recent ? chart.at : flat.at};
      })};
    }
    if (scope==='directory') return {at:snapshot.at,rows:snapshot.rows.map(({id,name,phase,category})=>({id,name,phase,category}))};
    const notice=scope==='notice';
    if (scope!=='selected' && !notice) return null;
    const selected = new Set();
    for (let i=0;i<sessionStorage.length;i++) {
      const key=sessionStorage.key(i);
      if (key?.startsWith('vest-active-account:')) {
        const id=sessionStorage.getItem(key);
        if (id) selected.add(id);
      }
    }
    // A newly opened Vest tab can restore its selected ID from the user's
    // persistent preference before the first in-tab switch.
    if (notice && !selected.size && globalThis.localStorage) {
      for (let i=0;i<localStorage.length;i++) {
        const key=localStorage.key(i);
        if (key?.startsWith('vest-active-account:') && localStorage.getItem(key)) selected.add(localStorage.getItem(key));
      }
    }
    const id=selected.size===1 ? [...selected][0] : null;
    const row=snapshot.rows.find(item=>item.id===id);
    const opened=positions.snapshot;
    if (notice) {
      const roots = new Map();
      for (const item of snapshot.rows) {
        if (item.phase==='2/2' && item.id!==id) roots.set(item.root,(roots.get(item.root) || 0)+1);
      }
      return {at:snapshot.at,selected:id,row:row ? {root:row.root,phase:row.phase} : null,
        prior_active:priorId ? snapshot.rows.some(item=>item.id===priorId) : null,
        successor_roots:[...roots.keys()].filter(root=>roots.get(root)===1),
        count:id && opened ? opened.rows.get(id)?.count ?? 0 : null,positions_at:opened?.at ?? null};
    }
    const position=row && opened?.rows.get(id)?.position;
    return structuredClone({at:snapshot.at,selected:id,row:row ?? null,
      flat:row ? flatBalance(id,opened,orders.snapshot,balances.snapshot) : null,
      sources:Object.fromEntries([['balances',balances],['positions',positions],['orders',orders]].map(([key,ch])=>
        [key,ch.snapshot?.at ?? ch.state ?? 'unseen'])),
      ...(position ? {position,position_at:opened.at} : {})});
  }});
  function observe(method,input) {
    if (String(method).toUpperCase()!=='GET') return null;
    let url;
    try {url=new URL(input,location.href);} catch {return null;}
    const channel=endpoint(url.href), kind=archiveKind(url);
    const performance=url.origin===gateway && url.pathname==='/v3/trading-performance/series';
    if (!channel && !kind && !performance) return null;
    const accept=channel && begin(channel);
    return {href:url.href,finish(body){
      if (accept) accept(body);
      if (performance && body) performanceRows(body);
      if (kind && body) captureArchive(url,body);
    }};
  }
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method,url,...rest) {
    const result = open.call(this,method,url,...rest);
    const accept=observe(method,url);
    if (accept) this.addEventListener('loadend',()=>{
      try {
        accept.finish(this.status!==200 || this.responseURL!==accept.href ? null : this.responseType==='json' ? this.response : JSON.parse(this.responseText));
      } catch {accept.finish(null);}
    },{once:true});
    return result;
  };
  const fetch = window.fetch;
  window.fetch = function(input,init) {
    const result=fetch.apply(this,arguments);
    const accept=observe(init?.method ?? input?.method ?? 'GET',input?.url ?? input);
    if (accept) result.then(async response=>{
      accept.finish(response.status===200 && response.url===accept.href ? await response.clone().json() : null);
    }).catch(()=>accept.finish(null));
    return result;
  };
})();
