'use strict';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
})[c]);
const titles = {
  overview: '运行总览',
  nodes: '服务器',
  accounts: '账户与持仓',
  strategy: '自动策略',
  commands: '指令记录',
  logs: '运行日志',
  analytics: '盈亏分析'
};
const descriptions = {
  overview: '查看节点连接、账户读数和指令执行进度。',
  nodes: '管理云端桥接服务及其连接的浏览器。',
  accounts: '查看账户最近一次页面读数，维护别名、执行权限和策略账户池。',
  strategy: '按节点查看账户阶段、策略状态和当前批次。',
  commands: '跟踪所选节点的指令投递、执行和核验结果。',
  logs: '查看节点连接、浏览器状态、策略批次和指令的变更记录。',
  analytics: '查看各节点的交易结果、阶段胜率和已核验出金。'
};
const paths = {
  overview: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  nodes: 'M3 4h18v6H3z M3 14h18v6H3z M6 7h1 M6 17h1',
  accounts: 'M3 7h18v13H3z M7 7V4h10v3 M3 12h18 M10 12v2h4v-2',
  strategy: 'M3 17l5-7 4 4 7-10 M15 4h5v5',
  commands: 'M5 3h14v18H5z M8 8h8 M8 12h8 M8 16h5',
  logs: 'M4 5h16v14H4z M7 9l3 2-3 2 M12 14h4',
  analytics: 'M3 3v17h18 M7 16v-4 M12 16V8 M17 16V5',
  positions: 'M3 18h18 M5 14l4-5 4 3 6-8',
  review: 'M12 3l9 16H3z M12 9v4 M12 16h.01'
};
const icon = name => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name]}"/></svg>`;
const actionTitles = {
  'accounts.list': '全量拉取账户列表',
  'accounts.read_all': '全量读取账户信息',
  'account.read': '读取账户状态',
  'positions.read': '读取持仓',
  'profit.available': '读取可领利润',
  'history.read': '同步订单与盈亏历史',
  'order.open': '市价开仓',
  'order.close': '全量平仓',
  'position.protect': '修改止盈止损',
  'profit.withdraw': '领取利润',
  'page.navigate': '跳转页面'
};
const statuses = {
  pending: ['待投递', 'info'],
  sending: ['等待送达确认', 'info'],
  queued: ['等待插件领取', 'info'],
  running: ['执行中', 'info'],
  succeeded: ['已完成', 'good'],
  failed: ['失败', 'bad'],
  unknown: ['待核验', 'warn'],
  cancelled: ['已取消', ''],
  expired: ['已过期', ''],
  resolved: ['已人工核验', 'good']
};
const updateStatus = {
  queued: ['等待节点领取', 'info'], dispatched: ['节点已领取', 'info'], preparing: ['准备版本', 'info'],
  applying: ['正在切换版本', 'info'], installed: ['已安装，等待插件确认', 'warn'], succeeded: ['桥和插件均已确认', 'good'],
  failed: ['更新失败', 'bad'], rolled_back: ['已回滚', 'warn'], cancelled: ['已撤销', ''], superseded: ['后续更新已接手', '']
};
const category = {
  active: '活跃',
  eval: '考核',
  funded: '资金',
  live: '实盘',
  default: '主账户',
  passed: '已通过',
  closed: '已关闭',
  failed: '已失败'
};
const stageNames = {'1/2':'考核 1/2','2/2':'考核 2/2',live:'Live'};
const dir = {
  buy: '做多',
  sell: '做空',
  random: '每批随机'
};
const READ = ['accounts.list', 'accounts.read_all', 'account.read', 'positions.read', 'profit.available', 'history.read', 'page.navigate'];
const tag = (label, cls = '') => `<span class="tag ${cls}"><i class="dot"></i>${esc(label)}</span>`;
const badge = c => c.cancel_requested ? tag('取消中', 'warn') : tag(...(statuses[c.status] || [c.status]));
const money = n => Number.isFinite(n) ? n.toLocaleString('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
}) : '—';
const time = ts => ts ? new Date(ts * 1000).toLocaleString('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
}) : '—';
const positive = n => n > 0 ? 'positive' : n < 0 ? 'negative' : '';
const option = (v, label, selected = false) => `<option value="${esc(v)}" ${selected ? 'selected' : ''}>${esc(label)}</option>`;
const btn = (op, label, cls = '', val = '') => `<button type="button" class="${cls}" data-op="${op}" data-value="${esc(val)}">${esc(label)}</button>`;
const empty = (title, help = '', action = '') => `<div class="empty"><strong>${esc(title)}</strong>${esc(help)}${action ? ' <div>' + action + '</div>' : ''}</div>`;
const panel = (name, content, action = '') => `<section class="panel"><div class="panel-head"><h2>${esc(name)}</h2>${action}</div>${content}</section>`;
const table = (headers, rows) => `<div class="scroll"><table><thead><tr>${headers.map(h => '<th>' + esc(h) + '</th>').join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
let token = sessionStorage.getItem('vest.admin') || '',
  state, stateBaseline,
  busy = false;
function activeRoute() {
  const hash = location.hash.slice(1);
  const detail = /^strategy\/([a-zA-Z0-9_.-]+)$/.exec(hash);
  return detail ? {page:'strategy', node:detail[1]} : {page:Object.hasOwn(titles,hash) ? hash : 'overview', node:''};
}
let page = activeRoute().page, strategyNode = activeRoute().node;
let selectedNode = sessionStorage.getItem('vest.node') || '',
  accountQuery = '',
  commandFilter = '',
  commandOffset = 0,
  historyRequest = 0,
  submitDialog = null;
const addressKey = a => JSON.stringify([a.node_id, a.worker_id, a.name]);
const nodeLabel = id => state.nodes.find(n => n.id === id)?.label || id;
const workerLabel = (nid, wid) => state.workers.find(w => w.node_id === nid && w.worker_id === wid)?.label || wid;
const routeLabel = a => esc(nodeLabel(a.node_id)) + ' / ' + esc(workerLabel(a.node_id, a.worker_id));
const nodeScopes = ['accounts', 'commands', 'logs'];
const strategyPath = (id, op) => 'nodes/' + encodeURIComponent(id) + '/strategy/' + op;
function selectNode(id) {
  selectedNode = id;
  sessionStorage.setItem('vest.node', id);
  commandOffset = 0;
  logsOffset = 0;
  if (nodeScopes.includes(page)) $('content').replaceChildren();
}
async function api(path, method = 'GET', body) {
  const headers = {
    Authorization: 'Bearer ' + token
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch('/v1/' + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(10000)
  });
  const data = await res.json();
  if (!res.ok) {
    const err = Error(data.error || 'HTTP ' + res.status);
    err.status = res.status;
    throw err;
  }
  return data;
}
let toastTimer;
function notify(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $('toast').hidden = true;
  }, 3500);
}
function loginScreen() {
  token = '';
  liveMetrics.clear();
  sessionStorage.removeItem('vest.admin');
  state = null;
  stateBaseline = null;
  if ($('dialog').open) $('dialog').close();
  $('login').hidden = false;
  $('app').hidden = true;
  $('loginForm').elements.token.focus();
}
async function refresh() {
  if (!token || busy) return;
  busy = true;
  const requestToken = token;
  try {
    const response = await api('state?since='+encodeURIComponent(stateBaseline?.status_cursor || 'initial'));
    if (token !== requestToken) return;
    if (response.base) {
      if (response.base !== stateBaseline?.status_cursor) { stateBaseline = null; return; }
      for (const [path,value] of response.changes) {
        let parent = stateBaseline;
        for (const key of path.slice(0,-1)) parent = parent[key];
        parent[path.at(-1)] = value;
      }
      stateBaseline.status_cursor = response.status_cursor;
    } else stateBaseline = response;
    const latest = {...stateBaseline};
    latest.receivedAt = performance.now();
    const nodeId = page === 'strategy' && strategyNode;
    if (nodeId && latest.commands.length >= recentCommandLimit && latest.nodes.some(n => n.id === nodeId)) {
      latest.poolHistory = {nodeId,commands:await nodePoolCommands(latest,nodeId)};
    }
    if (token !== requestToken) return;
    state = latest;
    if (!state.nodes.some(n => n.id === selectedNode)) selectNode(state.nodes[0]?.id || '');
    sessionStorage.setItem('vest.admin', token);
    $('login').hidden = true;
    $('app').hidden = false;
    $('banner').hidden = true;
    $('syncStatus').textContent = '同步于 ' + new Date(state.now * 1000).toLocaleTimeString('zh-CN', {
      hour12: false
    });
    render();
  } catch (err) {
    if (!state || err.status === 401) {
      loginScreen();
      $('loginError').textContent = err.message;
    } else {
      $('banner').hidden = false;
      $('banner').textContent = '中心暂时未响应，当前显示上次读数。' + err.message;
    }
  } finally {
    busy = false;
  }
}
function changePage(next, node = '') {
  if (!Object.hasOwn(titles, next)) return;
  page = next;
  strategyNode = next === 'strategy' ? node : '';
  location.hash = strategyNode ? 'strategy/' + encodeURIComponent(strategyNode) : next;
  render();
}
function render() {
  if (!state) return;
  $('navigation').innerHTML = Object.entries(titles).map(([key, label]) => `<button class="${page === key ? 'active' : ''}" data-op="page" data-value="${key}" ${page === key ? 'aria-current="page"' : ''}>${icon(key)}${label}</button>`).join('');
  $('crumb').textContent = titles[page];
  const scoped = nodeScopes.includes(page);
  const toolbar = page === 'strategy' ? strategyToolbar() : page === 'nodes' || page === 'overview' ? btn('addNode', '＋ 添加服务器', 'primary') : selectedNode && ['commands', 'accounts'].includes(page) ? btn('send', '下达指令', 'primary') : '';
  const choices = state.nodes.map(n => option(n.id, n.label + ' · ' + n.id, n.id === selectedNode)).join('');
  const scope = scoped && choices ? '<label class="node-scope">当前节点<select id="nodeScope">' + choices + '</select></label>' : '';
  const refreshCards = page === 'accounts' && selectedNode ?
    btn('refreshCards', actionTitles['accounts.list']) + btn('readAll', actionTitles['accounts.read_all']) : '';
  const strategyDetail = page === 'strategy' && strategyNode;
  const heading = `<div><h1>${strategyDetail ? esc(nodeLabel(strategyNode)) : titles[page]}</h1><p>${strategyDetail ? '节点策略详情 · '+esc(strategyNode) : descriptions[page]}</p></div><div class="buttons">${scope}${refreshCards}${toolbar}</div>`;
  if ($('heading')._template !== heading) {
    $('heading').innerHTML = heading;
    $('heading')._template = heading;
    if ($('nodeScope')) $('nodeScope').onchange = e => { selectNode(e.target.value); render(); };
  }
  if (scoped && !selectedNode) {
    $('content').innerHTML = panel('节点工作区', empty('尚未添加服务器', '添加服务器后可以在这里管理该节点。', btn('addNode', '添加服务器', 'link')));
    return;
  }
  if (page === 'analytics') return analyticsView();
  if (page === 'logs') return logsView();
  // Keep the search input and text selection stable while telemetry refreshes.
  if (page === 'accounts' && $('accountTable')) {
    renderAccounts();
    return;
  }
  if (page === 'commands' && $('commandTable')) {
    renderCommands();
    return;
  }
  if (page === 'overview') overview();else if (page === 'nodes') nodesView();else if (page === 'accounts') {
    $('content').innerHTML = '<div class="filters"><input id="accountSearch" aria-label="搜索账户" placeholder="搜索账户名称或别名"></div><div id="accountTable"></div>';
    $('accountSearch').value = accountQuery;
    $('accountSearch').oninput = e => {
      accountQuery = e.target.value;
      renderAccounts();
    };
    renderAccounts();
  } else if (page === 'commands') {
    $('content').innerHTML = '<div class="filters"><select id="cmdFilter" aria-label="指令状态"></select>' + btn('lookup', '按完整 ID 查询') + '</div><div id="commandTable"></div>';
    $('cmdFilter').innerHTML = option('', '全部状态') + Object.entries(statuses).map(([k, v]) => option(k, v[0], commandFilter === k)).join('');
    $('cmdFilter').onchange = e => {
      commandFilter = e.target.value;
      commandOffset = 0;
      renderCommands();
    };
    renderCommands();
  } else strategyView();
}
function metric(label, value, detail, ico) {
  return `<div class="metric"><div class="metric-title">${label}${icon(ico)}</div><div class="count">${value}</div><small>${esc(detail)}</small></div>`;
}
function positionCount(a) {
  if (a.card && (a.card_at || 0) >= (a.observed_at || 0)) return a.card.active_positions;
  return a.snapshot.position_open === true ? 1 : a.snapshot.position_open === false ? 0 : null;
}
function openLockLabel(a) {
  return a.open_lock?.kind==='read_retry' ? '等待读数重试' : '开仓风控锁定';
}
function openLockDetail(a) {
  return a.open_locked ? '<small>'+esc(a.open_lock.reason)+' · '+time(a.open_lock.until)+' 后重新核验</small>' : '';
}
const liveMetrics = new Map();
const metricKey = (a, cardId, pid, count) => JSON.stringify([a.node_id,a.worker_id,a.name,cardId ?? '',pid ?? '',count]);
const amountAndLimit = (used, limit) => money(used)+' / '+money(limit);
const protectionAmount = n => n === 'omitted' ? '未设置' : money(n);
function metricText(a,m) {
  if (a.ambiguous) return {pnl:money(m.pnl),drawdown:amountAndLimit(m.drawdown,m.drawdown_limit),
    daily:amountAndLimit(m.daily_loss,m.daily_limit),at:time(m.at)};
  const snap=a.snapshot, risk=a.risk || {}, floor=a.daily_floor;
  const portfolio=a.portfolio?.observed_at >= (a.phase_started_at || 0) ? a.portfolio : {};
  const day=floor && m.at>=floor.start && m.at<floor.end ? floor : null;
  const latestLimits=(a.risk_at || 0)>=(portfolio.observed_at || 0) ? risk : portfolio;
  const drawdownLimit=m.drawdown_limit ?? latestLimits.drawdown_limit ?? portfolio.drawdown_limit ?? risk.drawdown_limit;
  const dailyLimit=m.daily_limit ?? day?.daily_limit;
  const drawdownFloor=latestLimits.max_drawdown_floor ?? portfolio.max_drawdown_floor ?? risk.max_drawdown_floor;
  const samePosition=a.position_detail?.position_id && a.position_detail.position_id===snap.position_id &&
    (!Object.hasOwn(a,'tracked_position_id') || a.tracked_position_id===snap.position_id) &&
    snap.position_open===true && (!snap.phase || snap.phase===a.phase) && positionCount(a)===1 && m.at>=a.observed_at;
  // Vest's evaluation cards show the profit target and aggregate unrealized PnL.
  // The confirmed position balance excludes that PnL, unlike the last reported equity.
  const balanceEstimate=samePosition && Number.isFinite(snap.balance) && Number.isFinite(m.pnl);
  const equity=m.equity ?? (balanceEstimate ? snap.balance+m.pnl : null);
  const prefix=m.equity==null && balanceEstimate ? '≈' : '';
  const sampleAt=portfolio.equity_at;
  const recentSample=portfolio.equity_source==='performance_series' && Number.isFinite(sampleAt) && sampleAt<=m.at &&
    m.at-sampleAt<=600 && sampleAt>=(a.position_detail?.opened_at || a.position_detail?.submitted_at || 0);
  function loss(used,limit,reference,sampled) {
    if (Number.isFinite(used)) return amountAndLimit(used,limit);
    if (Number.isFinite(equity) && Number.isFinite(reference))
      return prefix+amountAndLimit(Math.max(0,reference-equity),limit);
    if (recentSample && Number.isFinite(sampled)) return amountAndLimit(sampled,limit)+'（采样 '+time(sampleAt)+'）';
    return amountAndLimit(null,limit);
  }
  const dailyBase=day?.verified && Number.isFinite(day.floor) && Number.isFinite(dailyLimit) ? day.floor+dailyLimit : null;
  const initialCapital=Number.isFinite(drawdownFloor) && Number.isFinite(drawdownLimit) ? drawdownFloor+drawdownLimit : null;
  return {pnl:money(m.pnl), drawdown:loss(m.drawdown,drawdownLimit,initialCapital,portfolio.drawdown),
    daily:dailyLimit==null && (portfolio.daily_unlimited ?? risk.daily_unlimited)===true ? '无限额' :
      loss(m.daily_loss,dailyLimit,dailyBase,day && sampleAt>=day.start ? portfolio.daily_loss : null), at:time(m.at)};
}
function positionMetricKey(a) {
  const pid=Object.hasOwn(a,'tracked_position_id') ? a.tracked_position_id : a.snapshot.position_id;
  return metricKey(a,a.card?.id,pid,positionCount(a));
}
function positions(accounts) {
  const rows = accounts.filter(a => a.present && positionCount(a)>0).map(a => {
    const count = positionCount(a), d = a.position_detail, card = a.card || {}, snap = a.snapshot;
    const cardLatest = a.card && a.card_at >= (a.observed_at || 0);
    const base = cardLatest ? {...card,at:a.card_at} : {pnl:snap.unrealized_pnl,equity:snap.equity,at:a.observed_at,
      drawdown:snap.capital_metrics?.drawdown?.current, drawdown_limit:snap.capital_metrics?.drawdown?.limit,
      daily_loss:snap.capital_metrics?.daily_loss?.current, daily_limit:snap.capital_metrics?.daily_loss?.limit};
    const key = positionMetricKey(a), tick = liveMetrics.get(key);
    const m = tick && tick.at > base.at ? tick : base, values = metricText(a,m);
    const note = a.ambiguous ? '同名账户待核对' : count>1 ? count+' 笔持仓合计' : !d ? '等待该笔成交明细' : '';
    return `<tr data-position-key="${esc(key)}" data-observed-at="${esc(m.at)}"><td class="cell"><strong>${esc(a.alias || a.name)}</strong><small>${routeLabel(a)}</small>${note ? '<small>'+esc(note)+'</small>' : ''}</td>
      <td class="nowrap">${esc(stageNames[a.phase] || '待确认')}</td><td>${esc(d?.symbol || '—')}</td><td>${d?.side ? tag(dir[d.side],d.side==='buy'?'good':'info') : '—'}</td>
      <td class="num">${esc(d?.quantity ?? '—')}</td><td class="num">${money(d?.entry_price)}</td>
      <td data-metric="pnl" class="num ${positive(m.pnl)}">${values.pnl}</td>
      <td data-metric="drawdown" class="num">${values.drawdown}</td><td data-metric="daily" class="num">${values.daily}</td>
      <td class="num">${protectionAmount(d?.take_profit)} / ${protectionAmount(d?.stop_loss)}</td>
      <td class="cell">${time(d?.submitted_at || d?.opened_at)}${!d?.submitted_at && d?.opened_at ? '<small>平台开仓</small>' : ''}</td><td data-metric="at">${values.at}</td></tr>`;
  });
  return rows.length ? table(['账户 / 来源','阶段','合约','方向','Vest 数量','成交均价','浮动盈亏 · USDC','回撤 / 上限 · USD',
    '每日亏损 / 上限 · USD','止盈 / 止损 · USD','下单时间','读取时间'],rows) : empty('暂无已读到的持仓','插件读取到活动持仓后会显示在这里。');
}
let readingMetrics = false;
async function refreshPositionMetrics() {
  if (readingMetrics || !token || document.hidden || !document.querySelector('[data-position-key]')) return;
  const scope = page==='accounts' ? selectedNode : strategyNode;
  const requestedToken = token;
  readingMetrics = true;
  try {
    const {items} = await api('position-metrics'+(scope ? '?node_id='+encodeURIComponent(scope) : ''));
    if (token !== requestedToken) return;
    liveMetrics.clear();
    for (const m of items) liveMetrics.set(metricKey(m,m.card_id,m.position_id,m.active_positions),m);
    const accounts=new Map(state.accounts.filter(a=>a.present && positionCount(a)>0).map(a=>[positionMetricKey(a),a]));
    for (const row of document.querySelectorAll('[data-position-key]')) {
      const m = liveMetrics.get(row.dataset.positionKey);
      const a=accounts.get(row.dataset.positionKey);
      if (!a || !m || m.at <= Number(row.dataset.observedAt)) continue;
      const values = metricText(a,m);
      for (const cell of row.querySelectorAll('[data-metric]')) {
        const key = cell.dataset.metric;
        if (cell.textContent !== values[key]) cell.textContent = values[key];
        if (key==='pnl') cell.className = 'num '+positive(m.pnl);
      }
      row.dataset.observedAt = m.at;
    }
  } catch { /* The visible source timestamp stays at the last successful read. */ }
  finally { readingMetrics = false; }
}
setInterval(refreshPositionMetrics,1000);
function commandsTable(list, formatTime = time) {
  if (!list.length) return empty('暂无指令记录');
  return table(['创建时间', '操作', '目标账户 / 浏览器', '来源', '状态', ''], list.map(c => `<tr><td class="num">${formatTime(c.created_at)}</td><td><strong>${esc(actionTitles[c.action])}</strong></td><td class="cell">${esc(c.account || '浏览器')}<small>${routeLabel(c)}</small></td><td>${c.source === 'manual' ? '手动' : '策略'}</td><td>${badge(c)}</td><td>${btn('detail', '详情', 'link', c.id)}</td></tr>`));
}
function overview() {
  const s = state,
    live = s.nodes.filter(n => n.online),
    open = s.accounts.filter(a => a.present && a.fresh).reduce((sum,a) => sum + (positionCount(a) || 0),0);
  const nodeRows = s.nodes.slice(0, 5).map(n => `<div class="node-row"><span class="node-icon">${icon('nodes')}</span><div><strong>${esc(n.label)}</strong><small>${s.workers.filter(w => w.node_id === n.id && w.online).length} 个在线浏览器 · ${s.accounts.filter(a => a.node_id === n.id && a.present).length} 个账户</small></div>${tag(n.online ? '在线' : '离线', n.online ? 'good' : '')}</div>`).join('');
  const summary = '<div class="metrics">' + metric('在线服务器', live.length, '共 ' + s.nodes.length + ' 台已登记服务器', 'nodes') + metric('已发现账户', s.accounts.filter(a => a.present).length, s.accounts.filter(a => a.fresh).length + ' 个账户读数有效', 'accounts') + metric('活动持仓', open, '按最新有效的页面读数统计', 'positions') + metric('待核验指令', s.unknown_count, '资金操作结果尚待确认', 'review') + '</div>';
  const strategies = s.strategies.map(st => '<div class="node-row"><div>' + btn('nodeStrategy', nodeLabel(st.node_id), 'link', st.node_id) + '<small>' + esc(st.message) + '</small></div>' + tag(st.enabled ? '运行中' : '已停止', st.enabled ? 'good' : '') + '</div>').join('');
  $('content').innerHTML = summary + '<div class="split">' + panel('服务器状态', nodeRows ? '<div class="nodes-list">' + nodeRows + '</div>' : empty('尚未添加服务器', '登记桥地址与节点密钥后开始同步。'), btn('page', '查看全部', 'link', 'nodes')) + panel('各节点策略', strategies ? '<div class="nodes-list">' + strategies + '</div>' : empty('尚无节点策略')) + '</div>' + panel('活动持仓', positions(s.accounts), btn('page', '查看账户', 'link', 'accounts')) + panel('最近指令', commandsTable(s.commands.slice(0, 5)), btn('page', '查看记录', 'link', 'commands'));
}
function nodesView() {
  const version = sha => sha ? '<code title="' + esc(sha) + '">' + esc(sha.slice(0,12)) + '</code>' : '—';
  const rows = state.nodes.map(n => `<tr><td class="cell"><strong>${esc(n.label)}</strong><small>${esc(n.id)}</small></td><td>${tag(n.online ? '在线' : '离线', n.online ? 'good' : '')}<small class="record-note"> ${esc([n.error,n.history_error,n.log_error].filter(Boolean).join(' · '))}</small></td><td class="num">${esc(n.url)}</td><td class="num">${time(n.last_seen)}</td><td><div class="actions">${btn('nodeAccounts', '账户', 'link', n.id)}${btn('nodeStrategy', '策略', 'link', n.id)}${btn('nodeLogs', '日志', 'link', n.id)}${btn('editNode', '编辑', 'link', n.id)}</div></td></tr>`);
  const workers = state.workers.map(w => {
    const comparison = {current:'与中心一致',behind:'待更新',ahead:'高于中心版本',unknown:'待确认'}[w.version_status] || '待确认';
    const mode = w.mode === 'execute' || w.pending_mode === 'execute' ? 'readonly' : 'execute';
    const label = w.pending_mode === 'execute' ? '撤回执行授权' : mode === 'execute' ? '切为执行' : '切为只读';
    const reason = !w.online || !w.page ? '等待浏览器在线并绑定页面' : !w.mode_control ? '需升级桥和插件至 1.12.0' : '';
    const pending = w.pending_mode ? '<small>等待插件确认'+(w.pending_mode==='execute'?'执行':'只读')+'</small>' : '';
    const control = reason ? '<small>'+reason+'</small>' : w.pending_mode === 'readonly' ? '' :
      btn('workerMode',label,'link',JSON.stringify([w.node_id,w.worker_id,w.session_id,mode]));
    return `<tr><td class="cell"><strong>${esc(w.label)}</strong><small>${esc(nodeLabel(w.node_id))}</small></td><td>${tag(w.online ? '在线' : '离线', w.online ? 'good' : '')}</td><td class="cell">${tag(w.mode === 'execute' ? '执行' : '只读', w.mode === 'execute' ? 'info' : '')}${pending}${control}</td><td>${esc(w.page) || '—'}<small> ${esc(w.error)}</small></td><td class="cell">${esc(w.plugin_version || '未上报')} · ${comparison}<small>中心版本 ${esc(state.plugin_version || '未知')}${w.release ? ' · '+version(w.release) : ''}</small></td><td class="num">${time(w.last_seen)}</td><td>${btn('workerCmd', '下达指令', 'link', JSON.stringify([w.node_id, w.worker_id]))}</td></tr>`;
  });
  const releases = state.nodes.map(n => {
    const job = n.update;
    const agent = n.agent_seen ? '上次联系 ' + time(n.agent_seen) : '等待首次接入';
    let receipt = job ? tag(...(updateStatus[job.state] || [job.state])) + '<small>' + esc(job.detail) + '</small>' : '—';
    if (job?.state === 'installed') {
      const waiting = job.expected.filter(id => !job.confirmed.includes(id)).map(id => workerLabel(n.id,id));
      receipt += '<small>' + (waiting.length ? '待确认 · ' + esc(waiting.join('、')) : '等待首个已绑定浏览器') + '</small>';
    }
    const cancel = job?.state === 'queued' ? btn('cancelUpdate', '撤销', 'link', JSON.stringify([n.id,job.id])) : '';
    return `<tr><td class="cell"><strong>${esc(n.label)}</strong><small>${agent}</small></td><td>${version(n.release)}</td><td>${version(job?.revision)}</td><td class="cell">${receipt}</td><td>${cancel}</td></tr>`;
  });
  $('content').innerHTML = panel('服务器', rows.length ? table(['节点', '连接', '桥地址', '最近同步', ''], rows) : empty('尚未登记服务器', '在云服务器上启动节点桥后，添加其地址。')) +
    (releases.length ? panel('节点更新', table(['节点 / 更新服务', '节点桥版本', '目标提交', '最近更新结果', ''], releases), btn('deployUpdate', '下达更新', 'primary')) : '') +
    panel('浏览器', workers.length ? table(['浏览器 / 节点', '连接', '权限', '当前页面', '插件版本', '最后心跳', ''], workers) : empty('尚无浏览器连接', '在云服务器已登录的 Vest 标签页打开插件，填写本机桥的插件密钥并绑定。'));
}
function renderAccounts() {
  const list = state.accounts.filter(a => a.present && selectedNode === a.node_id && (a.name+' '+a.alias).toLowerCase().includes(accountQuery.trim().toLowerCase()));
  const rows = list.map(a => {
    const key = addressKey(a), card = a.card || {}, risk = {...a.risk};
    const detail=a.portfolio;
    if (detail?.source==='native') {
      for (const field of ['equity','health','daily_loss','daily_limit','drawdown','drawdown_limit','daily_unlimited']) {
        const previousAt=Math.max(a.risk_at || 0,card[field]!=null ? a.card_at || 0 : 0);
        if (detail[field]!=null && (risk[field]==null || detail.observed_at>=previousAt)) risk[field]=detail[field];
      }
    }
    const status = a.ambiguous ? '同名待核对' : !a.fresh ? '待刷新' : a.excluded ? '主账户' : !a.enabled ? '已停用' : category[a.category] || a.category;
    const pnl = Number.isFinite(card.pnl_percent) ? money(card.pnl)+' ('+card.pnl_percent+'%)' : money(card.pnl);
    return `<tr><td class="cell"><strong>${esc(a.alias || a.name)}</strong><small>${routeLabel(a)}</small></td>
      <td>${tag(status,a.fresh && a.enabled ? 'good':'')} <small>${esc(a.phase || '')}</small></td>
      <td>${pnl}</td><td>${positionCount(a) ?? '—'}</td>
      <td>${risk.daily_unlimited ? '无限额' : money(risk.daily_loss)+' / '+money(risk.daily_limit)}</td><td>${money(risk.drawdown)} / ${money(risk.drawdown_limit)}</td>
      <td>${money(risk.equity)}</td><td class="cell">${money(a.daily_floor?.floor)}<small>${a.daily_floor?.source === 'platform' ? '页面已读取' : '等待页面读取'}</small></td>
      <td>${risk.health == null ? '—' : esc(risk.health)+'%'}</td><td class="cell">${a.open_locked ? openLockLabel(a) : a.candidate ? '可候选' : a.in_pool ? '入池待选' : '—'}${openLockDetail(a)}</td>
      <td class="cell">${time(Math.max(a.card_at || 0,a.observed_at || 0,detail?.observed_at || 0))}${detail ? '<small>详情 '+time(detail.observed_at)+(detail.missing.length ? ' · 字段不全' : '')+'</small>' : ''}${detail?.equity_source==='performance_series' ? '<small>净值采样 '+time(detail.equity_at)+'</small>' : ''}</td><td><div class="actions">${btn('account','管理','link',key)}${btn('accountCmd','指令','link',key)}</div></td></tr>`;
  });
  const node = state.nodes.find(n=>n.id===selectedNode);
  const workers = state.workers.filter(w=>w.node_id===selectedNode && w.online);
  const ready = workers.filter(w=>w.card_generation===node?.card_generation && w.card_session===w.session_id);
  const progress = node?.card_generation ? '列表已拉取 '+ready.length+' / '+workers.length+' 个在线浏览器' : '';
  const scans = state.workers.filter(w=>w.node_id===selectedNode && w.portfolio_scan).map(w=>{
    const s = w.portfolio_scan;
    const stage = s.status !== 'running' ? statuses[s.status]?.[0] || s.status :
      s.stage === 'portfolio' ? '读取账户详情' : '核对账户列表与缓存';
    return '<tr><td>'+esc(w.label)+'</td><td>'+esc(stage)+'</td><td>'+esc(s.total ?? '—')+'</td><td>'+esc(s.read ?? '—')+
      '</td><td>'+esc(s.partial ?? '—')+'</td><td>'+esc(s.failed ?? '—')+'</td><td>'+esc(s.error || '')+'</td></tr>';
  });
  $('accountTable').innerHTML = (scans.length ? panel('最近一次全量读取',table(['浏览器','进度','账户数','读全','字段不全','失败','说明'],scans)) : '') +
    panel('活动账户', rows.length ? table(['账户 / 来源','状态 / 阶段','卡片盈亏','活动持仓数','日损 / 上限','回撤 / 上限','净值','当日爆仓线 · USD','健康度','策略池','最近读数',''],rows) : empty('没有匹配的活动账户','可从已绑定的浏览器全量拉取账户列表。'),esc(progress)) + panel('持仓明细',positions(list));
}
async function renderCommands() {
  const sequence = ++historyRequest;
  try {
    const result = await api('commands?' + new URLSearchParams({
      node_id: selectedNode,
      status: commandFilter,
      offset: commandOffset
    }));
    if (sequence !== historyRequest || page !== 'commands' || !$('commandTable')) return;
    if (commandOffset > 0 && commandOffset >= result.total) {
      commandOffset = 0;
      return renderCommands();
    }
    const controls = (commandOffset ? btn('previousCommands', '上一页') : '') + (result.total > commandOffset + result.items.length ? btn('nextCommands', '下一页') : '');
    const count = result.total ? `第 ${commandOffset + 1}–${commandOffset + result.items.length} 条 / 共 ${result.total} 条` : '共 0 条';
    $('commandTable').innerHTML = panel('指令记录', commandsTable(result.items) + '<div class="panel-body row"><small>' + count + '</small><div class="buttons">' + controls + '</div></div>');
  } catch (err) {
    if (sequence === historyRequest && $('commandTable')) $('commandTable').textContent = err.message;
  }
}
const input = (name, label, value = '', type = 'text', extra = '') => `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
const stopBufferInput = value => input('stop_buffer', '爆仓线上方净值缓冲 M · USD', value, 'number', 'min="0" step="0.01" required');
const select = (name, label, choices) => `<label>${label}<select name="${name}" required>${choices}</select></label>`;
const check = (name, label, on, disabled = false) => `<label class="check"><input type="checkbox" name="${name}" ${on ? 'checked' : ''} ${disabled ? 'disabled' : ''}>${label}</label>`;
const grid = html => '<div class="form-grid">' + html + '</div>';
function dialog(title, body, submitLabel, submit) {
  $('dialogTitle').textContent = title;
  $('dialogBody').innerHTML = body;
  $('dialogError').textContent = '';
  $('dialogFoot').innerHTML = btn('dismiss', '关闭') + (submitLabel ? '<button class="primary" type="submit">' + esc(submitLabel) + '</button>' : '');
  submitDialog = submit;
  if (!$('dialog').open) $('dialog').showModal();
}
function updateForm() {
  const attempts = new Map();
  const choices = state.nodes.map(n => '<label class="check"><input type="checkbox" name="target" value="' +
    esc(n.id) + '"' + (n.id === selectedNode ? ' checked' : '') + '>' + esc(n.label) + ' · ' + esc(n.id) + '</label>').join('');
  dialog('下达节点更新', input('revision', 'main 上的完整 Git 提交', '', 'text', 'required pattern="[0-9a-f]{40}" maxlength="40" spellcheck="false"') +
    '<fieldset><legend>目标节点</legend>' + choices + '</fieldset><p>节点会先完成在途指令，再切换桥和插件。浏览器重载后以只读模式连接。</p>', '下达更新', async form => {
    const nodes = form.getAll('target');
    if (!nodes.length) throw Error('请选择至少一个节点');
    const revision = form.get('revision');
    const results = await Promise.allSettled(nodes.map(id => {
      const key = revision + '/' + id;
      if (!attempts.has(key)) attempts.set(key, crypto.randomUUID());
      return api('nodes/' + encodeURIComponent(id) + '/updates/' + attempts.get(key), 'PUT', {revision});
    }));
    const errors = results.flatMap((r,i) => r.status === 'rejected' ? [nodeLabel(nodes[i]) + ' · ' + r.reason.message] : []);
    if (errors.length) throw Error('已受理 ' + (nodes.length-errors.length) + ' / ' + nodes.length + '。' + errors.join('，'));
    notify('已向 ' + nodes.length + ' 个节点下达更新');
  });
}
function nodeForm(id) {
  const n = state.nodes.find(x => x.id === id);
  dialog(n ? '编辑服务器' : '添加服务器', grid(input('id', '节点 ID', n?.id, 'text', n ? 'readonly' : 'required pattern="[a-zA-Z0-9][a-zA-Z0-9_.\\-]{0,79}"') + input('label', '显示名称', n?.label, 'text', 'maxlength="80" required') + '<div class="full">' + input('url', '桥地址', n?.url, 'url', 'placeholder="https://bridge.example.com" required') + '</div>' + '<div class="full">' + input('token', '节点通信密钥', '', 'password', n ? 'placeholder="留空沿用原密钥" autocomplete="off"' : 'autocomplete="off" minlength="24" required') + '</div>'), '保存服务器', async data => {
    const {
      id,
      ...node
    } = Object.fromEntries(data);
    await api('nodes/' + encodeURIComponent(id), 'PUT', node);
    notify('服务器配置已保存');
  });
}
async function accountForm(key) {
  const a = state.accounts.find(a => addressKey(a) === key);
  if (!a) throw Error('账户已变化，请刷新');
  const view = state;
  let executing = false;
  if (a.in_pool) {
    let commands = view.commands;
    if (view.commands.length >= recentCommandLimit) {
      commands = view.poolHistory?.nodeId === a.node_id ? view.poolHistory.commands : await nodePoolCommands(view,a.node_id);
    }
    executing = executingPoolAccounts(view,a.node_id,commands.values()).has(a.account_ref || a.name);
  }
  const pool = check('in_pool', '加入自动策略池', a.in_pool, a.excluded || executing) +
    (executing ? '<p class="full form-note">账户正在执行，暂不能出池。</p>' : '');
  const s = a.snapshot;
  dialog('管理账户', `<p><strong>${esc(a.name)}</strong> · ${routeLabel(a)}</p><p class="form-note">余额 ${money(s.balance)} USDC · 最近读数 ${time(a.observed_at)}</p>` + (a.read_error ? '<p class="error">' + esc(a.read_error) + '</p>' : '') + grid(input('alias', '账户别名', a.alias, 'text', 'maxlength="80"') + input('account_ref', '交易账户标识', a.account_ref, 'text', 'maxlength="160" placeholder="默认使用完整账户名"') + '<p class="full form-note">同一实际账户在各节点使用相同标识，共享指令和每日开仓额度。不同登录下的同名账户可分别指定标识。</p>' + `<label class="full">备注<textarea name="note" maxlength="500">${esc(a.note)}</textarea></label>` + check('enabled', '允许执行资金指令', a.enabled && !a.excluded, a.excluded) + pool), '保存', async data => {
    const inPool = data.has('in_pool');
    let changePool = !executing && inPool !== a.in_pool;
    if (changePool && !inPool) changePool = await verifyPoolExit(a);
    await api('accounts/config', 'POST', {
      node_id: a.node_id,
      worker_id: a.worker_id,
      account: a.name,
      alias: data.get('alias'),
      account_ref: data.get('account_ref'),
      note: data.get('note'),
      enabled: data.has('enabled'),
      ...(changePool ? {in_pool:inPool} : {})
    });
    notify('账户设置已保存');
  });
}
function commandForm(initial = []) {
  const nid = initial[0] || selectedNode;
  if (!state.workers.some(w => w.node_id === nid && w.online)) throw Error('此节点尚无在线浏览器');
  const form = $('dialogForm');
  let priorRequest = '',
    key = crypto.randomUUID();
  dialog('下达浏览器指令', grid(select('node', '服务器', '') + select('worker', '浏览器', '') + select('action', '操作', Object.entries(actionTitles).map(([k, v]) => option(k, v, k === (initial[2] ? 'account.read' : 'accounts.list'))).join('')) + '<div id="accountField"></div><div class="full" id="parameterFields"></div>'), '下达指令', async data => {
    const action = data.get('action'),
      params = {};
    for (const k of ['micro', 'stop_loss', 'stop_buffer', 'omit_floor_gap_below', 'omit_stop_below', 'take_profit', 'amount']) if (data.has(k) && data.get(k) !== '') params[k] = Number(data.get(k));
    for (const k of ['side', 'position_id', 'destination']) if (data.has(k)) params[k] = data.get(k);
    const req = {
      node_id: data.get('node'),
      worker_id: data.get('worker'),
      account: data.get('account') || null,
      action,
      params
    };
    const fingerprint = JSON.stringify(req);
    if (priorRequest && fingerprint !== priorRequest) key = crypto.randomUUID();
    priorRequest = fingerprint;
    const c = await api('commands/' + key, 'PUT', req);
    notify((actionTitles[c.action] || c.action) + ' · ' + (statuses[c.status]?.[0] || c.status));
  });
  const f = form.elements;
  function params() {
    const action = f.action.value;
    const a = state.accounts.find(a => a.node_id === f.node.value && a.worker_id === f.worker.value && a.name === f.account?.value);
    let body = '';
    const amount = (k, label, v = '', required = false, step = 'any') => input(k, label, v, 'number', 'min="0.000001" step="' + step + '" ' + (required ? 'required' : ''));
    if (action === 'order.open') {
      const config = state.strategies.find(s => s.node_id === f.node.value)?.config || {};
      const prefix = a?.phase === 'live' ? 'live_' : '';
      body = grid(select('side','市价方向',option('buy','做多') + option('sell','做空')) +
        input('micro','Micro 合约数',1,'number','min="1" step="1" required') + stopBufferInput(config[prefix+'stop_buffer'] ?? 20) +
        input('omit_floor_gap_below','两线差额免止损阈值 · USD（留空关闭）',config.skip_stop_loss_on_floor_gap ? config.floor_gap_threshold : '', 'number','step="any"') +
        amount('omit_stop_below','净值距最大回撤线免止损阈值 · USD（留空关闭）',config[prefix+'skip_stop_loss_on_low_drawdown'] ? config[prefix+'drawdown_stop_loss_threshold'] : '') +
        (prefix ? amount('take_profit','止盈金额 · USDC（可选）') : ''));
    }
    if (['order.close', 'position.protect'].includes(action)) {
      body = input('position_id', '目标持仓 ID', a?.snapshot.position_id || '', 'text', 'required readonly placeholder="请先刷新该账户的持仓"');
      if (action === 'position.protect') body += '<p class="form-note">填写需要修改的保护金额，留空的项目保留原值。</p>' + grid(amount('stop_loss', '止损金额 · USDC') + (a?.phase==='live' ? amount('take_profit', '止盈金额 · USDC') : ''));
    }
    if (action === 'profit.withdraw') body = amount('amount', '领取金额 · USDC', '', true) + '<p class="form-note">由当前 Live 账户领取利润，收款对象为平台主账户。</p>';
    if (action === 'page.navigate') body = select('destination', '目标页面', option('accounts', '活动账户') + option('trade', 'NQ 交易页') + option('portfolio', '持仓 / Portfolio'));
    const w = state.workers.find(w => w.node_id === f.node.value && w.worker_id === f.worker.value);
    if (!READ.includes(action) && w?.mode !== 'execute') body += '<p class="error">此浏览器为只读。请先在节点插件中允许执行，再打开此窗口。</p>';
    $('parameterFields').innerHTML = body;
  }
  function accounts() {
    const needsAccount = !['accounts.list', 'accounts.read_all', 'page.navigate'].includes(f.action.value);
    const list = state.accounts.filter(a => a.node_id === f.node.value && a.worker_id === f.worker.value && a.present && !a.ambiguous);
    $('accountField').innerHTML = needsAccount ? select('account', '目标账户', list.map(a => option(a.name, a.alias ? a.alias + ' · ' + a.name : a.name, a.name === initial[2])).join('')) : '';
    if (f.account) f.account.onchange = params;
    params();
  }
  function workers() {
    const list = state.workers.filter(w => w.node_id === f.node.value && w.online);
    f.worker.innerHTML = list.map(w => option(w.worker_id, w.label, w.worker_id === initial[1])).join('');
    accounts();
  }
  f.node.innerHTML = option(nid, nodeLabel(nid), true);
  f.node.onchange = workers;
  f.worker.onchange = accounts;
  f.action.onchange = accounts;
  workers();
}
async function detail(id) {
  const c = await api('commands/' + encodeURIComponent(id));
  if (nodeScopes.includes(page) && c.node_id !== selectedNode) throw Error('此指令属于其他节点');
  const actions = ['pending', 'sending', 'queued'].includes(c.status) ? btn('cancel', '取消待执行指令', 'danger', c.id) : '';
  const resolve = c.status === 'unknown' ? grid(select('executed', '平台核验结果', option('yes', '已执行') + option('no', '未执行')) + input('note', '核验依据', '', 'text', 'maxlength="500" required')) : '';
  dialog('指令详情', '<div class="row"><h3>' + esc(actionTitles[c.action]) + '</h3>' + badge(c) + '</div>' + '<p class="form-note">' + routeLabel(c) + ' · ' + esc(c.account || '浏览器') + '</p><p class="num record-note">' + esc(c.id) + '</p>' + '<p class="form-note">创建 ' + time(c.created_at) + ' · 更新 ' + time(c.updated_at) + '</p>' + (c.error ? '<p class="error">' + esc(c.error) + '</p>' : '') + '<pre>' + esc(JSON.stringify({
    params: c.params,
    intents: c.intents,
    result: c.result
  }, null, 2)) + '</pre>' + actions + resolve, resolve ? '提交核验结果' : '', async data => {
    await api('commands/' + encodeURIComponent(id) + '/resolve', 'POST', {
      executed: data.get('executed') === 'yes',
      note: data.get('note')
    });
    notify('核验结果已保存');
  });
}
function lookup() {
  dialog('查询指令', input('id', '完整指令 ID', '', 'text', 'required'), '查询', async data => {
    await detail(data.get('id').trim());
    return false;
  });
}
const operations = {
  previousCommands: () => {
    commandOffset = Math.max(0, commandOffset - 50);
    return renderCommands();
  },
  nextCommands: () => {
    commandOffset += 50;
    return renderCommands();
  },
  page: changePage,
  nodeAccounts: id => { selectNode(id); changePage('accounts'); },
  nodeStrategy: id => { selectNode(id); changePage('strategy',id); },
  nodeLogs: id => { selectNode(id); changePage('logs'); },
  refreshCards: async () => {
    await api('nodes/'+encodeURIComponent(selectedNode)+'/accounts/refresh','POST',{});
    notify('已请求该节点全量拉取账户列表');
    await refresh();
  },
  readAll: async () => {
    const result = await api('nodes/'+encodeURIComponent(selectedNode)+'/accounts/read-all','POST',{});
    notify('已为 '+result.commands.length+' 个浏览器安排全量读取账户信息'+
      (result.skipped.length ? '，另有 '+result.skipped.length+' 个浏览器需要更新插件' : ''));
    await refresh();
  },
  addNode: () => nodeForm(),
  editNode: nodeForm,
  deployUpdate: updateForm,
  cancelUpdate: async value => {
    const [node, job] = JSON.parse(value);
    await api('nodes/' + encodeURIComponent(node) + '/updates/' + encodeURIComponent(job) + '/cancel', 'POST', {});
    notify('已撤销待领取更新');
    await refresh();
  },
  account: accountForm,
  joinPool: key => setPoolMembership(key,true),
  leavePool: key => setPoolMembership(key,false),
  send: () => commandForm(),
  workerCmd: value => commandForm(JSON.parse(value)),
  workerMode: async value => {
    const [node,worker,session_id,mode] = JSON.parse(value);
    const reply = await api('nodes/'+node+'/workers/'+worker+'/mode','PUT',{session_id,mode});
    notify(reply.pending_mode ? '已送达节点，等待插件确认' : '节点已确认当前权限');
    await refresh();
  },
  accountCmd: value => commandForm(JSON.parse(value)),
  strategyConfig: id => strategyConfig(id),
  strategyDefaults: () => strategyEditor('defaults'),
  strategyPresets: () => strategyPresets(),
  editPreset: id => strategyEditor('preset',id),
  deletePreset: id => deletePreset(id),
  lookup,
  detail,
  dismiss: () => $('dialog').close(),
  start: nid => {
    dialog('启动 ' + nodeLabel(nid) + ' 的自动策略', '<p>将先全量拉取该节点的账户列表，再按已保存的参数选择账户。同批同向下单，Live 平仓后按本节点的领取设置处理净利润。</p>', '启动策略', async () => {
      await api(strategyPath(nid, 'start'), 'POST', {});
      notify('节点策略已启动');
    });
  },
  stop: async nid => {
    await api(strategyPath(nid, 'stop'), 'POST', {});
    notify('策略已停止');
    await refresh();
  },
  cancel: async id => {
    await api('commands/' + encodeURIComponent(id) + '/cancel', 'POST', {});
    await detail(id);
    await refresh();
  }
};
document.addEventListener('click', async e => {
  const target = e.target.closest('[data-op]');
  if (!target) return;
  try {
    await operations[target.dataset.op]?.(target.dataset.value);
  } catch (err) {
    if ($('dialog').open) $('dialogError').textContent = err.message;else notify(err.message);
  }
});
$('dialogForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!submitDialog) return;
  const button = e.submitter;
  if (button) button.disabled = true;
  $('dialogError').textContent = '';
  try {
    const close = await submitDialog(new FormData(e.target));
    if (close !== false) $('dialog').close();
    await refresh();
  } catch (err) {
    $('dialogError').textContent = err.message;
  } finally {
    if (button) button.disabled = false;
  }
});
$('dismiss').onclick = () => $('dialog').close();
$('loginForm').onsubmit = async e => {
  e.preventDefault();
  token = e.target.elements.token.value.trim();
  $('loginError').textContent = '';
  await refresh();
  if (state) e.target.reset();
};
$('logout').onclick = loginScreen;
$('refresh').onclick = refresh;
window.addEventListener('hashchange', () => {
  const route = activeRoute();
  page = route.page;
  strategyNode = route.node;
  render();
});
window.addEventListener('DOMContentLoaded', () => {
  $('loginSubmit').disabled = false;
  if (token) refresh();
});
setInterval(() => {
  if (token && !document.hidden) refresh();
}, 4000);
