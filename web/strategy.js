'use strict';

const stageNames = {'1/2':'考核 1/2','2/2':'考核 2/2',live:'Live'};
const poolNames = {random:'全随机选择',same_stage:'每批同阶段',dynamic:'动态分配'};
const strategyFor = id => state.strategies.find(s => s.node_id === id);

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
    '<dl class="stage-counts">'+counters+'</dl><div class="card-message">'+esc(note || s.message)+'<span aria-hidden="true">›</span></div></a>'+
    '<div class="strategy-controls">'+strategyControls(node,s)+'</div></article>';
}

function strategyDetail(node) {
  const s = strategyFor(node.id), c = s.config;
  const accounts = state.accounts.filter(a => a.node_id === node.id && a.present);
  const pool = accounts.filter(a => a.in_pool);
  const queue = (s.planned || []).map(item => item.ref);
  const olderWorkers = state.workers.filter(w => w.node_id === node.id && w.online && w.mode === 'execute' && w.strategy_version !== 1);
  const versionNote = olderWorkers.length ? '<p class="form-note">'+esc(olderWorkers.map(w => w.label).join('、'))+
    ' 需要更新节点桥并加载 1.5.0 或更高版本插件，才能执行 Live 策略和免止损规则。</p>' : '';
  const controls = '<div class="buttons">'+strategyControls(node,s)+'</div>';
  const summary = '<div class="panel-body"><div class="row"><h3>'+esc(poolNames[c.pool_strategy])+'</h3>'+strategyStatus(node,s)+'</div>'+
    '<div class="summary"><div><small>批次</small><strong>'+s.batch+'</strong></div><div><small>每批账户</small><strong>'+c.batch_size+'</strong></div>'+
    '<div><small>本批方向</small><strong>'+esc(s.members.length || queue.length ? dir[s.batch_side] || '—' : '—')+'</strong></div>'+
    '<div><small>可候选 / 入池</small><strong>'+pool.filter(a => a.candidate).length+' / '+pool.length+'</strong></div></div>'+
    '<p class="strategy-line">'+esc(s.message)+'</p>'+(queue.length ? '<p>等待下单 · '+queue.map(esc).join('、')+'</p>' : '')+versionNote+'</div>';
  function accountRow(a) {
    const risk = a.risk || {};
    const status = a.candidate ? '可候选' : a.in_pool ? '入池待选' : a.live_default_locked ? 'Live 默认锁定' :
      a.ambiguous ? '同名待确认' : a.excluded ? '主账户' : !a.enabled ? '已停用' : '未入池';
    return '<tr><td class="cell"><strong>'+esc(a.alias || a.name)+'</strong><small>'+esc((a.alias ? a.name+' · ' : '')+workerLabel(node.id,a.worker_id))+'</small></td>'+
      '<td>'+esc(stageNames[a.phase] || '待确认')+'</td><td>'+tag(status,a.candidate ? 'good' : '')+'</td>'+
      '<td>'+money(risk.equity)+'</td><td>'+(risk.health == null ? '—' : esc(risk.health)+'%')+'</td>'+
      '<td>'+money(risk.daily_loss)+' / '+money(risk.daily_limit)+'</td><td>'+money(risk.drawdown)+' / '+money(risk.drawdown_limit)+'</td>'+
      '<td>'+money(a.daily_floor?.floor)+'</td><td>'+(positionCount(a) ?? '—')+'</td><td>'+btn('account','管理','link',addressKey(a))+'</td></tr>';
  }
  const headers = ['账户 / 浏览器','阶段','候选状态','净值','健康度','日损 / 上限','回撤 / 上限','当日爆仓线','活动持仓',''];
  const outside = accounts.filter(a => !a.in_pool);
  const ids = [...s.members, ...Object.values(s.claims || {}).flatMap(p => [p.read,p.withdraw].filter(Boolean))];
  const records = ids.map(id => {
    const cmd = state.commands.find(c => c.id === id);
    return '<div class="batch-command">'+(cmd ? esc(cmd.account)+' · '+esc(actionTitles[cmd.action])+' '+badge(cmd) : esc(id))+
      btn('detail','查看指令','link',id)+'</div>';
  });
  return panel('策略状态',summary,controls)+panel('账户池',pool.length ? table(headers,pool.map(accountRow)) :
    empty('当前账户池为空'),btn('nodeAccounts','管理全部账户','link',node.id))+
    panel('活动持仓',positions(accounts))+(outside.length ? panel('池外账户',table(headers,outside.map(accountRow))) : '')+
    panel('本批指令',records.length ? '<div class="panel-body">'+records.join('')+'</div>' : empty('当前没有批次指令'));
}

function strategyView() {
  const node = state.nodes.find(n => n.id === strategyNode);
  const content = strategyNode ? node ? strategyDetail(node) : empty('找不到这个节点') :
    state.nodes.length ? '<div class="strategy-cards">'+state.nodes.map(strategyCard).join('')+'</div>' :
      panel('服务器',empty('尚未登记服务器','',btn('addNode','添加服务器','link')));
  const target = $('content');
  if (!target.querySelector('[data-strategy-view]') || target._strategyTemplate !== content) {
    target.innerHTML = '<div data-strategy-view>'+content+'</div>';
    target._strategyTemplate = content;
  }
}

function strategyFields(c) {
  const numeric = (key,label,min,step='1',max='',optional=false) => input(key,label,c[key] ?? '','number',
    'min="'+min+'" step="'+step+'" '+(max !== '' ? 'max="'+max+'" ' : '')+(optional ? '' : 'required'));
  const choices = (key,label,options) => select(key,label,Object.entries(options).map(([k,v]) =>
    option(k,v,String(c[key]) === k)).join(''));
  const flag = (key,label) => check(key,label,c[key]);
  const group = (title,fields,open=false) => '<details class="parameter-group"'+(open ? ' open' : '')+'><summary>'+title+'</summary>'+grid(fields)+'</details>';
  const orders = [['live','2/2','1/2'],['live','1/2','2/2'],['2/2','live','1/2'],['2/2','1/2','live'],['1/2','live','2/2'],['1/2','2/2','live']];
  const limit = (key,label) => input(key,label,c[key] === 'infinity' ? '∞' : c[key],'text','required pattern="(?:∞|infinity|[1-9][0-9]*)"');
  const phase = prefix => choices(prefix+'side','方向',dir)+choices(prefix+'size_percent','仓位比例',{25:'25%',50:'50%',75:'75%',100:'100%'})+
    numeric(prefix+'stop_buffer','爆仓线上方缓冲 M · USD',0,'any')+numeric(prefix+'take_profit','止盈 · USD（可留空）',.000001,'any','',true)+
    flag(prefix+'skip_stop_loss_on_low_drawdown','剩余额度低于阈值时免设止损')+numeric(prefix+'drawdown_stop_loss_threshold','免止损阈值 · USD',.000001,'any');
  return group('批次与等待',numeric('batch_size','每批账户数',1,'1',100)+choices('pool_strategy','选池方式',poolNames)+
    numeric('order_delay_min','批内最短等待 · 秒',0,'any',86400)+numeric('order_delay_max','批内最长等待 · 秒',0,'any',86400)+
    numeric('batch_delay_min','批间最短等待 · 秒',0,'any',86400)+numeric('batch_delay_max','批间最长等待 · 秒',0,'any',86400),true)+
    group('账户池与阶段优先级',flag('live_priority','启用阶段优先级')+select('account_priority_order','阶段顺序',orders.map(order=>
      option(order.join(','),order.map(p=>stageNames[p]).join(' → '),order.join(',') === c.account_priority_order.join(','))).join(''))+
      flag('refresh_account_pool','等待新增候选并在美东 20:00 日切刷新')+flag('live_default_locked','默认锁定新 Live 账户')+
      flag('same_stage_full_batch','同阶段账户不足一批时顺延')+flag('pool_limits_enabled','启用账户池上限')+
      limit('exam_pool_limit','考核号上限（∞ 为不限）')+limit('live_pool_limit','Live 上限（∞ 为不限）')+
      numeric('dynamic_reserve_low','动态候补下限',1)+numeric('dynamic_reserve_high','动态候补恢复线',2)+
      numeric('dynamic_live_target','动态 Live 目标存量',1)+numeric('dynamic_exam_slots','补位考核名额（留空自动）',1,'1','',true))+
    group('考核号下单与风控',phase(''),true)+group('Live 下单与风控',phase('live_'))+
    group('Live 利润领取',choices('live_payout_recipient','收款账户',{main:'平台主账户'})+
      choices('live_payout_mode','领取方式',{all:'全部净利润',amount:'固定金额',percent:'按净利润比例'})+
      numeric('live_payout_amount','固定领取金额 · USDC',.000001,'.000001')+numeric('live_payout_percent','领取比例 · %',.000001,'any',100))+
    '<p class="form-note">免止损比较净值与当日爆仓线的差额。等于阈值时仍会设置止损，金额为该差额减去 M。</p>';
}

function formSettings(data, base) {
  const config = {...base};
  for (const [key,prior] of Object.entries(base)) {
    if (typeof prior === 'boolean') config[key] = data.has(key);
    else if (!data.has(key)) continue;
    else if (key === 'account_priority_order') config[key] = data.get(key).split(',');
    else if (key.endsWith('_pool_limit')) {
      const v = data.get(key).trim();
      config[key] = ['∞','infinity'].includes(v) ? 'infinity' : Number(v);
    } else if (typeof prior === 'number' || prior === null) config[key] = data.get(key) === '' ? null : Number(data.get(key));
    else config[key] = data.get(key);
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
      const config = formSettings(data,base);
      if (mode === 'defaults') await api('strategy/defaults','PUT',config);
      else if (mode === 'preset') await api('strategy/presets/'+encodeURIComponent(target),'PUT',{name:data.get('presetName').trim(),config});
      else await api(strategyPath(id,'config'),'POST',config);
      notify(mode === 'node' ? nodeLabel(id)+' 的策略参数已保存' : mode === 'preset' ? '参数预设已保存' : '默认参数已保存');
    });
  if (mode === 'node') $('presetSource').onchange = e => {
    base = e.target.value === '' ? strategyFor(id).config : e.target.value === '@default' ? lib.defaults : lib.presets.find(p=>p.id===e.target.value).config;
    $('policyFields').innerHTML = strategyFields(base);
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
