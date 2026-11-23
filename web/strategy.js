'use strict';

const stageNames = {'1/2':'考核 1/2','2/2':'考核 2/2',live:'Live'};
const poolNames = {random:'全随机选择',same_stage:'每批同阶段',dynamic:'动态分配'};
const strategyFor = id => state.strategies.find(s => s.node_id === id);
const poolChanges = new Set();
const unfinishedStatuses = ['pending','sending','queued','running','unknown'];
const recentCommandLimit = 100;

async function nodePoolCommands(view, nodeId) {
  const commands = new Map(view.commands.filter(c => c.node_id === nodeId).map(c => [c.id,c]));
  // The dashboard returns at most 100 recent commands across all nodes.
  if (view.commands.length >= recentCommandLimit) {
    await Promise.all(unfinishedStatuses.map(async status => {
      let offset = 0;
      while (true) {
        const result = await api('commands?' + new URLSearchParams({node_id:nodeId,status,offset}));
        for (const c of result.items) commands.set(c.id,c);
        offset += result.items.length;
        if (!result.items.length || offset >= result.total) break;
      }
    }));
    const s = view.strategies.find(s => s.node_id === nodeId);
    const missing = [];
    const previous = state?.poolHistory?.nodeId === nodeId ? state.poolHistory.commands : null;
    for (const id of s?.members || []) {
      if (commands.has(id)) continue;
      const cached = previous?.get(id);
      if (cached?.status === 'succeeded') commands.set(id,cached);
      else missing.push(id);
    }
    for (let i = 0; i < missing.length; i += 8) {
      const records = await Promise.all(missing.slice(i,i+8).map(id => api('commands/'+encodeURIComponent(id))));
      for (const c of records) commands.set(c.id,c);
    }
  }
  return commands;
}

function executingPoolAccounts(view, nodeId, commands) {
  const s = view.strategies.find(s => s.node_id === nodeId);
  const members = new Set(s?.members || []);
  const accounts = new Map(), executing = new Set();
  for (const a of view.accounts) {
    if (a.node_id !== nodeId) continue;
    accounts.set(addressKey(a),a);
    if (a.present && positionCount(a) > 0) executing.add(a.account_ref || a.name);
  }
  for (const c of commands) {
    if (c.node_id !== nodeId || !c.account) continue;
    const a = accounts.get(JSON.stringify([nodeId,c.worker_id,c.account]));
    const active = unfinishedStatuses.includes(c.status) && (!READ.includes(c.action) || (s?.run && c.source === 'strategy-'+s.run));
    // A filled batch member still belongs to the strategy until flat confirmation and Live settlement.
    const settling = members.has(c.id) && c.status === 'succeeded' && !s.exit_lists?.[c.id]?.removed &&
      (!a || positionCount(a) !== 0 || Math.max(a.card_at || 0,a.observed_at || 0) <= c.updated_at ||
       c.phase === 'live' && s.enabled && s.policy_version === 2 && !s.draining && !s.claims?.[c.id]?.done);
    if (active || settling) executing.add(c.account_ref || a?.account_ref || c.account);
  }
  return executing;
}

async function verifyPoolExit(a) {
  const path = 'state?' + new URLSearchParams({node_id:a.node_id});
  let view = await api(path);
  const commands = await nodePoolCommands(view,a.node_id);
  if (view.commands.length >= recentCommandLimit) {
    // Refresh the account and current batch after any paginated command lookups.
    view = await api(path);
    for (const c of view.commands) commands.set(c.id,c);
  }
  const current = view.accounts.find(item => addressKey(item) === addressKey(a));
  if (!current?.present) throw Error('账户列表已变化，请刷新后重试');
  if (!current.in_pool) return false;
  if (executingPoolAccounts(view,a.node_id,commands.values()).has(current.account_ref || current.name)) {
    throw Error(current.name+' 正在执行，暂不能出池');
  }
  return true;
}

function canJoinPool(a) {
  return a.present && a.enabled && !a.excluded && !a.ambiguous && ['active','eval','funded','live'].includes(a.category);
}

async function setPoolMembership(key, inPool) {
  const a = state.accounts.find(account => addressKey(account) === key);
  if (!a?.present || a.in_pool === inPool || (inPool && !canJoinPool(a)) || poolChanges.has(key)) return;
  poolChanges.add(key);
  strategyView();
  try {
    if (!inPool && !await verifyPoolExit(a)) return;
    await api('accounts/config','POST',{node_id:a.node_id,worker_id:a.worker_id,account:a.name,in_pool:inPool});
    notify(a.name + (inPool ? ' 已入池' : ' 已出池'));
  } finally {
    await refresh();
    poolChanges.delete(key);
    if (state && page === 'strategy' && strategyNode === a.node_id) strategyView();
  }
}

function strategyToolbar() {
  if (strategyNode) return btn('page','返回全部节点','','strategy') + btn('nodeLogs','运行日志','',strategyNode);
  return btn('strategyDefaults','默认参数') + btn('strategyPresets','参数预设');
}

function strategyStatus(node, s) {
  return !node.online ? tag('离线','bad') : s.enabled ? tag('执行中','good') : tag('在线','info');
}

function strategyControls(node, s) {
  const edit = '<button type="button" data-op="strategyConfig" data-value="'+esc(node.id)+'"'+
    (s.enabled ? ' disabled title="停止策略后可修改参数"' : '')+'>参数设置</button>';
  const run = s.enabled ? btn('stop','停止策略','danger',node.id) : node.online ? btn('start','启动策略','primary',node.id) :
    '<button type="button" class="primary" disabled title="节点上线后可启动">启动策略</button>';
  return edit + run;
}

function strategyMessage(s, note = '') {
  if (!s.enabled || s.message !== '批间等待' || !Number.isFinite(s.next_at)) return esc(note || s.message);
  return (note ? esc(note)+' · ' : '')+'批间等待 · 剩余 <time class="batch-countdown" data-batch-until="'+s.next_at+'"></time>';
}

function updateBatchCountdowns() {
  if (!state || page !== 'strategy' || document.hidden) return;
  const now = state.now + (performance.now() - state.receivedAt)/1000;
  for (const timer of document.querySelectorAll('[data-batch-until]')) {
    const seconds = Math.max(0,Math.ceil(Number(timer.dataset.batchUntil) - now));
    const hours = Math.floor(seconds/3600);
    const minutes = String(Math.floor(seconds/60)%60).padStart(2,'0');
    const value = (hours ? hours+':' : '')+minutes+':'+String(seconds%60).padStart(2,'0');
    if (timer.textContent !== value) timer.textContent = value;
  }
}
setInterval(updateBatchCountdowns,1000);
document.addEventListener('visibilitychange',updateBatchCountdowns);

function strategyCard(node) {
  const s = strategyFor(node.id);
  const accounts = state.accounts.filter(a => a.node_id === node.id && a.present && !a.excluded &&
    !a.ambiguous && ['active','eval','funded','live'].includes(a.category));
  // The same trading account may be visible to two browsers on one node.
  const stageByRef = new Map();
  for (const a of accounts) {
    const ref = a.account_ref || a.name;
    const known = stageByRef.get(ref);
    if (known === 'conflict' || known && a.phase && known !== a.phase) stageByRef.set(ref,'conflict');
    else stageByRef.set(ref,known || a.phase);
  }
  const stages = [...stageByRef.values()];
  const counted = state.workers.some(w => w.node_id === node.id && w.cards_full_at) || accounts.length > 0;
  const counters = Object.entries(stageNames).map(([phase,label]) => '<div><dt>'+label+'</dt><dd>'+
    (counted ? stages.filter(p => p === phase).length : '—')+'</dd></div>').join('');
  const pending = stages.filter(p => !Object.hasOwn(stageNames,p)).length;
  const note = [!node.online && node.last_seen ? '上次同步 '+time(node.last_seen) : '',pending ? pending+' 个阶段待确认' : '',
    !counted ? '等待账户列表' : ''].filter(Boolean).join(' · ');
  return '<article class="strategy-card" data-node="'+esc(node.id)+'">'+
    '<a class="strategy-card-body" href="#strategy/'+encodeURIComponent(node.id)+'" aria-label="'+esc(node.label+' 策略详情')+'">'+
    '<div class="row"><div class="card-identity"><h2>'+esc(node.label)+'</h2><small>'+esc(node.id)+'</small></div>'+strategyStatus(node,s)+'</div>'+
    '<dl class="stage-counts">'+counters+'</dl><div class="card-message"><div>'+strategyMessage(s,note)+'</div><span aria-hidden="true">›</span></div></a>'+
    '<div class="strategy-controls">'+strategyControls(node,s)+'</div></article>';
}

function strategyDetail(node) {
  const s = strategyFor(node.id), c = s.config;
  const accounts = state.accounts.filter(a => a.node_id === node.id && a.present);
  const pool = accounts.filter(a => a.in_pool);
  const history = state.poolHistory?.nodeId === node.id ? state.poolHistory.commands : null;
  const checkingHistory = !history && state.commands.length >= recentCommandLimit;
  const executing = executingPoolAccounts(state,node.id,history ? history.values() : state.commands);
  const queue = (s.planned || []).map(item => item.ref);
  const olderWorkers = state.workers.filter(w => w.node_id === node.id && w.online && w.mode === 'execute' && !w.supports_open_policy);
  const versionNote = olderWorkers.length ? '<p class="form-note">'+esc(olderWorkers.map(w => w.label).join('、'))+
    ' 需要更新节点桥并加载 1.9.0 或更高版本插件，才能核对每日亏损底线与最大回撤线。</p>' : '';
  const controls = '<div class="buttons">'+strategyControls(node,s)+'</div>';
  const summary = '<div class="panel-body"><div class="row"><h3>'+esc(poolNames[c.pool_strategy])+'</h3>'+strategyStatus(node,s)+'</div>'+
    '<div class="summary"><div><small>批次</small><strong>'+s.batch+'</strong></div><div><small>每批账户</small><strong>'+c.batch_size+'</strong></div>'+
    '<div><small>本批方向</small><strong>'+esc(s.members.length || queue.length ? dir[s.batch_side] || '—' : '—')+'</strong></div>'+
    '<div><small>可候选 / 入池</small><strong>'+pool.filter(a => a.candidate).length+' / '+pool.length+'</strong></div></div>'+
    '<p class="strategy-line">'+strategyMessage(s)+'</p>'+(queue.length ? '<p>等待下单 · '+queue.map(esc).join('、')+'</p>' : '')+versionNote+'</div>';
  function accountRow(a) {
    const risk = a.risk || {};
    const key = addressKey(a), label = a.in_pool ? '出池' : '入池';
    const active = a.in_pool && executing.has(a.account_ref || a.name);
    let unavailable = '';
    if (poolChanges.has(key)) unavailable = '正在保存';
    else if (active) unavailable = '账户正在执行，暂不能出池';
    else if (a.in_pool && checkingHistory) unavailable = '正在核对执行状态';
    else if (!a.in_pool && !canJoinPool(a)) unavailable = '当前账户状态无法入池';
    const poolButton = '<button type="button" class="link" data-op="'+(a.in_pool ? 'leavePool' : 'joinPool')+'" data-value="'+esc(key)+'"'+
      (unavailable ? ' disabled title="'+esc(unavailable)+'"' : '')+'>'+label+'</button>';
    const status = active ? '执行中' : a.open_locked ? openLockLabel(a) : a.candidate ? '可候选' : a.in_pool ? '入池待选' : a.live_default_locked ? 'Live 默认锁定' :
      a.ambiguous ? '同名待确认' : a.excluded ? '主账户' : !a.enabled ? '已停用' : '未入池';
    return '<tr><td class="cell"><strong>'+esc(a.alias || a.name)+'</strong><small>'+esc((a.alias ? a.name+' · ' : '')+workerLabel(node.id,a.worker_id))+'</small></td>'+
      '<td>'+esc(stageNames[a.phase] || '待确认')+'</td><td class="cell">'+tag(status,active ? 'info' : a.open_locked ? 'warn' : a.candidate ? 'good' : '')+openLockDetail(a)+'</td>'+
      '<td>'+money(risk.equity)+'</td><td>'+(risk.health == null ? '—' : esc(risk.health)+'%')+'</td>'+
      '<td>'+money(risk.daily_loss)+' / '+money(risk.daily_limit)+'</td><td>'+money(risk.drawdown)+' / '+money(risk.drawdown_limit)+'</td>'+
      '<td>'+money(a.daily_floor?.floor)+'</td><td>'+(positionCount(a) ?? '—')+'</td><td><div class="actions">'+
      btn('account','管理','link',key)+poolButton+'</div></td></tr>';
  }
  const headers = ['账户 / 浏览器','阶段','候选状态','净值','健康度','日损 / 上限','回撤 / 上限','当日爆仓线','活动持仓',''];
  const outside = accounts.filter(a => !a.in_pool);
  const ids = [...s.members, ...Object.values(s.claims || {}).flatMap(p => [p.read,p.quote,p.withdraw].filter(Boolean))];
  const records = ids.map(id => {
    const cmd = history?.get(id) || state.commands.find(c => c.id === id);
    return '<div class="batch-command">'+(cmd ? esc(cmd.account)+' · '+esc(actionTitles[cmd.action])+' '+badge(cmd) : esc(id))+
      btn('detail','查看指令','link',id)+'</div>';
  });
  return panel('策略状态',summary,controls)+panel('活动持仓',positions(accounts))+panel('账户池',pool.length ? table(headers,pool.map(accountRow)) :
    empty('当前账户池为空'),btn('nodeAccounts','管理全部账户','link',node.id))+
    (outside.length ? panel('池外账户',table(headers,outside.map(accountRow))) : '')+
    panel('本批指令',records.length ? '<div class="panel-body">'+records.join('')+'</div>' : empty('当前没有批次指令'));
}

function strategyView() {
  const node = state.nodes.find(n => n.id === strategyNode);
  if (node && state.commands.length >= recentCommandLimit && state.poolHistory?.nodeId !== node.id && !busy) refresh();
  const content = strategyNode ? node ? strategyDetail(node) : empty('找不到这个节点') :
    state.nodes.length ? '<div class="strategy-cards">'+state.nodes.map(strategyCard).join('')+'</div>' :
      panel('服务器',empty('尚未登记服务器','',btn('addNode','添加服务器','link')));
  const target = $('content');
  if (!target.querySelector('[data-strategy-view]') || target._strategyTemplate !== content) {
    target.innerHTML = '<div data-strategy-view>'+content+'</div>';
    target._strategyTemplate = content;
  }
  updateBatchCountdowns();
}

function strategyFields(c) {
  const numeric = (key,label,min,step='1',max='',optional=false) => input(key,label,c[key] ?? '','number',
    'min="'+min+'" step="'+step+'" '+(max !== '' ? 'max="'+max+'" ' : '')+(optional ? '' : 'required'));
  const choices = (key,label,options) => select(key,label,Object.entries(options).map(([k,v]) =>
    option(k,v,String(c[key]) === k)).join(''));
  const flag = (key,label) => check(key,label,c[key]);
  const group = (title,fields,open=false) => '<details class="parameter-group"'+(open ? ' open' : '')+'><summary>'+title+'</summary>'+grid(fields)+'</details>';
  const orders = [['live','2/2','1/2'],['live','1/2','2/2'],['2/2','live','1/2'],['2/2','1/2','live'],['1/2','live','2/2'],['1/2','2/2','live']];
  const limit = (key,label) => input(key,label,c[key] === 'infinity' ? '∞' : c[key],'text',
    'required pattern="(?:∞|infinity|[1-9][0-9]{0,5}|1000000)" title="填写 1 到 1000000 的整数，或填 ∞ 表示不限"');
  const size = (key,label) => choices(key,label,{25:'25%',50:'50%',75:'75%',100:'100%'});
  const phase = prefix => choices(prefix+'side','方向',dir)+(prefix ? size('live_size_percent','仓位比例') :
    size('size_percent','考核 1/2 仓位比例')+size('phase2_size_percent','考核 2/2 仓位比例'))+
    numeric(prefix+'stop_buffer','爆仓线上方缓冲 M · USD',0,'any')+
    flag(prefix+'skip_stop_loss_on_low_drawdown','净值距最大回撤线低于阈值时免止损')+numeric(prefix+'drawdown_stop_loss_threshold','净值距离阈值 · USD',.000001,'any');
  return group('账户池与阶段优先级',choices('pool_strategy','选池方式',poolNames)+numeric('batch_size','每批账户数',1,'1',100)+
      flag('same_stage_full_batch','同阶段账户不足一批时顺延')+flag('pool_limits_enabled','启用账户池上限')+
      limit('exam_pool_limit','考核号上限（∞ 为不限）')+limit('live_pool_limit','Live 上限（∞ 为不限）')+
      numeric('dynamic_reserve_low','动态候补下限',1,'1',1000000)+numeric('dynamic_reserve_high','动态候补恢复线',2,'1',1000000)+
      numeric('dynamic_live_target','动态 Live 目标存量',1,'1',1000000)+numeric('dynamic_exam_slots','补位考核名额（留空自动）',1,'1','',true)+
      flag('live_priority','启用阶段优先级')+select('account_priority_order','阶段顺序',orders.map(order=>
        option(order.join(','),order.map(p=>stageNames[p]).join(' → '),order.join(',') === c.account_priority_order.join(','))).join(''))+
      flag('refresh_account_pool','等待新增候选并在美东 20:00 日切刷新'),true)+
    group('批内与批间等待',
      numeric('order_delay_min','批内最短等待 · 秒',0,'any',86400)+numeric('order_delay_max','批内最长等待 · 秒',0,'any',86400)+
      numeric('batch_delay_min','批间最短等待 · 秒',0,'any',86400)+numeric('batch_delay_max','批间最长等待 · 秒',0,'any',86400))+
    group('考核与 Live 通用风控',flag('skip_stop_loss_on_floor_gap','今日底线减最大回撤线低于阈值时免止损')+
      numeric('floor_gap_threshold','两线差额阈值 · USD',-1e9,'any',1e9),true)+
    group('考核号下单与风控',phase(''))+
    group('Live 下单与风控','<div class="full">'+flag('live_default_locked','Live 默认锁定')+
      '<p class="form-note">开启后，可在「管理账户」中为指定 Live 账户勾选「加入自动策略池」以单独解锁。</p></div>'+phase('live_')+
      choices('live_take_profit_mode','止盈模式',{fixed:'固定止盈额',ratio:'固定盈亏比',entries:'当日首次与后续开仓'})+
      numeric('live_take_profit','固定止盈额 · USD',.000001,'any','',true)+numeric('live_reward_ratio','盈亏比（收益 / 风险）',.000001,'any')+
      numeric('live_min_take_profit','最低止盈金额 · USD',0,'any')+
      numeric('live_first_take_profit','当日首次止盈额 · USD',.000001,'any','',true)+size('live_first_size_percent','当日首次仓位比例')+
      numeric('live_repeat_take_profit','当日后续止盈额 · USD',.000001,'any','',true)+size('live_repeat_size_percent','当日后续仓位比例')+
      '<p id="liveProfitNote" class="full form-note"></p>',true)+
    group('Live 利润领取',choices('live_payout_recipient','收款账户',{main:'平台主账户'})+
      choices('live_payout_mode','领取方式',{all:'全部净利润',amount:'固定金额',percent:'按净利润比例'})+
      numeric('live_payout_amount','固定领取金额 · USDC',.000001,'.000001')+numeric('live_payout_percent','领取比例 · %',.000001,'any',100))+
    '<p class="form-note">任一已开启的免止损条件严格低于阈值时，止损留空。其余情况取净值距今日底线的金额和剩余最大回撤中的较小值，再减去缓冲 M。</p>';
}

function updateStrategyFields() {
  const fields = $('dialogForm').elements;
  const profit = fields.live_take_profit_mode.value;
  const dynamic = fields.pool_strategy.value === 'dynamic';
  const limits = fields.pool_limits_enabled.checked;
  const liveCap = fields.live_pool_limit.value;
  const unlimitedLive = !limits || ['∞','infinity'].includes(liveCap);
  const finiteLive = limits && /^[1-9][0-9]*$/.test(liveCap) && Number(liveCap) <= 1000000;
  const batch = fields.batch_size.valueAsNumber;
  const multiple = Number.isInteger(batch) && batch >= 2;
  // Outside dynamic allocation, a single Live account can reenter within the same batch.
  const orderDelay = !dynamic || multiple;
  const available = {
    live_size_percent: profit !== 'entries', live_take_profit: profit === 'fixed',
    live_reward_ratio: profit === 'ratio', live_min_take_profit: profit === 'ratio',
    live_first_take_profit: profit === 'entries', live_first_size_percent: profit === 'entries',
    live_repeat_take_profit: profit === 'entries', live_repeat_size_percent: profit === 'entries',
    same_stage_full_batch: fields.pool_strategy.value === 'same_stage',
    exam_pool_limit: limits, live_pool_limit: limits,
    dynamic_reserve_low: dynamic && finiteLive, dynamic_reserve_high: dynamic && finiteLive,
    dynamic_live_target: dynamic && unlimitedLive, dynamic_exam_slots: dynamic && multiple,
    order_delay_min: orderDelay, order_delay_max: orderDelay,
    account_priority_order: fields.live_priority.checked,
    floor_gap_threshold: fields.skip_stop_loss_on_floor_gap.checked,
    drawdown_stop_loss_threshold: fields.skip_stop_loss_on_low_drawdown.checked,
    live_drawdown_stop_loss_threshold: fields.live_skip_stop_loss_on_low_drawdown.checked,
    live_payout_amount: fields.live_payout_mode.value === 'amount',
    live_payout_percent: fields.live_payout_mode.value === 'percent'
  };
  for (const [key,active] of Object.entries(available)) {
    const field = fields.namedItem(key);
    field.closest('label').hidden = !active;
    field.disabled = !active;
  }
  fields.dynamic_exam_slots.max = multiple ? String(batch - 1) : '';
  fields.dynamic_reserve_high.min = String(Math.max(2,(fields.dynamic_reserve_low.valueAsNumber || 1) + 1));
  $('liveProfitNote').textContent = profit === 'ratio' ? '止盈取最低止盈额与风险金额乘盈亏比中的较大值。免设止损时，风险金额取净值至页面爆仓线的距离。' :
    profit === 'entries' ? '每个账户按美东 20:00 日切。已确认成交后使用后续档；未填止盈额的档位跳过开仓。' : '未填固定止盈额时，此模式下的 Live 账户跳过自动开仓。';
}

function formSettings(container, base) {
  const config = {...base};
  for (const field of container.querySelectorAll('[name]:enabled')) {
    const {name:key, value} = field;
    if (field.type === 'checkbox') config[key] = field.checked;
    else if (key === 'account_priority_order') config[key] = value.split(',');
    else if (key.endsWith('_pool_limit')) {
      config[key] = ['∞','infinity'].includes(value) ? 'infinity' : Number(value);
    } else if (typeof base[key] === 'number' || base[key] === null) config[key] = value === '' ? null : Number(value);
    else config[key] = value;
  }
  return config;
}

function strategyConfig(id) {
  if (strategyFor(id)?.enabled) throw Error('请先停止策略再修改参数');
  strategyEditor('node',id);
}

function strategyEditor(mode,id) {
  const lib = state.strategy_settings, preset = lib.presets.find(p => p.id === id);
  let base = mode === 'node' ? strategyFor(id).config : mode === 'preset' && preset ? preset.config : lib.defaults;
  const target = mode === 'preset' ? (id || crypto.randomUUID()) : id;
  const loader = mode === 'node' ? '<div class="preset-loader"><label>参数来源<select id="presetSource">'+
    option('','本节点已保存的参数',true)+option('@default','中心默认参数')+lib.presets.map(p=>option(p.id,p.name)).join('')+'</select></label></div>' : '';
  const name = mode === 'preset' ? input('presetName','方案名称',preset?.name || '','text','required maxlength="80"') : '';
  const note = mode === 'defaults' ? '<p class="form-note">新登记的节点会使用这组参数。已有节点可在参数设置中载入。</p>' : '';
  const title = mode === 'defaults' ? '默认参数' : mode === 'preset' ? preset ? '编辑参数预设' : '新建参数预设' : nodeLabel(id)+' · 参数设置';
  dialog(title,note+name+loader+'<div id="policyFields">'+strategyFields(base)+'</div>',
    mode === 'node' ? '保存到此节点' : mode === 'defaults' ? '保存默认参数' : '保存预设',async data => {
      const config = formSettings($('policyFields'),base);
      if (mode === 'defaults') await api('strategy/defaults','PUT',config);
      else if (mode === 'preset') await api('strategy/presets/'+encodeURIComponent(target),'PUT',{name:data.get('presetName').trim(),config});
      else await api(strategyPath(id,'config'),'POST',config);
      notify(mode === 'node' ? nodeLabel(id)+' 的策略参数已保存' : mode === 'preset' ? '参数预设已保存' : '默认参数已保存');
    });
  const controls = $('policyFields');
  controls.oninput = controls.onchange = updateStrategyFields;
  updateStrategyFields();
  if (mode === 'node') $('presetSource').onchange = e => {
    base = e.target.value === '' ? strategyFor(id).config : e.target.value === '@default' ? lib.defaults : lib.presets.find(p=>p.id===e.target.value).config;
    controls.innerHTML = strategyFields(base);
    updateStrategyFields();
  };
}

function strategyPresets() {
  const rows = state.strategy_settings.presets.map(p => '<tr><td><strong>'+esc(p.name)+'</strong></td><td>'+esc(poolNames[p.config.pool_strategy])+
    ' · '+p.config.batch_size+' 个 / 批</td><td><div class="actions">'+btn('editPreset','编辑','link',p.id)+btn('deletePreset','删除','link',p.id)+'</div></td></tr>');
  dialog('参数预设',(rows.length ? table(['方案名称','选池与批量','操作'],rows) : empty('尚未保存预设'))+
    '<div class="buttons">'+btn('editPreset','新建预设','primary')+'</div>','');
}

function deletePreset(id) {
  const p = state.strategy_settings.presets.find(p => p.id === id);
  dialog('删除参数预设','<p>删除「'+esc(p.name)+'」？已载入该方案的节点保留各自的参数。</p>','删除预设',async () => {
    await api('strategy/presets/'+encodeURIComponent(id)+'/delete','POST',{});
    notify('预设已删除');
  });
}
