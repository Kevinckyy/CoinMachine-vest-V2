'use strict';

let logsOffset = 0, logLevel = '', logRequest = 0;
let reportOffset = 0, reportSection = 'position', reportRequest = 0, reportFilter = {};
const reportSections = {position: '持仓盈亏', order: '平台订单', payout: '平台出金', withdrawal: '领取回执', instruction: '交易指令'};
const phaseLabels = {'1/2': '第一阶段', '2/2': '第二阶段', live: '实盘', unknown: '阶段未知'};
const exact = n => Number.isFinite(n) ? n.toLocaleString('zh-CN', {maximumFractionDigits: 6}) : '—';
const rate = n => Number.isFinite(n) ? (n * 100).toFixed(1) + '%' : '—';
const beijing = new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'});
const reportTime = ts => ts ? beijing.format(ts * 1000) : '—';
const numericCell = (n, signed = false) => '<td class="num ' + (signed ? positive(n) : '') + '">' + exact(n) + '</td>';
function pager(total, offset, op) {
  const label = total ? `第 ${offset + 1}–${Math.min(offset + 50, total)} 条 / 共 ${total} 条` : '共 0 条';
  return '<div class="panel-body row"><small>' + label + '</small><div class="buttons">' +
    (offset > 0 ? btn(op, '上一页', '', offset-50) : '') + (offset+50 < total ? btn(op, '下一页', '', offset+50) : '') + '</div></div>';
}
function logsView() {
  if (!$('logTable')) {
    const options = Object.entries({'': '全部级别', info: '信息', warning: '警告', error: '错误'}).map(([v, label]) => option(v, label, v === logLevel)).join('');
    $('content').innerHTML = '<div class="filters"><select id="logLevel" aria-label="日志级别">' + options + '</select></div><div id="logTable"></div>';
    $('logLevel').onchange = e => { logLevel = e.target.value; logsOffset = 0; loadLogs(); };
  }
  loadLogs();
}
async function loadLogs() {
  const seq = ++logRequest, node = selectedNode;
  try {
    const data = await api('nodes/' + encodeURIComponent(node) + '/logs?' + new URLSearchParams({level: logLevel, offset: logsOffset}));
    if (seq !== logRequest || page !== 'logs' || selectedNode !== node) return;
    const types = {node: '节点设置', connection: '节点连接', browser: '浏览器', account: '账户', observation:'页面读数',
      history: '历史同步', log_sync: '日志同步', strategy: '策略', command: '指令', intent: '操作许可', update: '软件更新'};
    const levels = {info: ['信息','info'], warning: ['警告','warn'], error: ['错误','bad']};
    const rows = data.items.map(r => `<tr><td class="num">${reportTime(r.at)}</td><td>${tag(...levels[r.level])}</td><td class="cell">${esc(types[r.event] || r.event)}<small>${r.source === 'bridge' ? '节点桥' : '控制中心'}</small></td>
      <td class="cell">${esc(r.account || '—')}<small>${esc(r.worker ? workerLabel(node,r.worker) : '')}</small></td><td class="record-note">${esc(r.message)}</td>
      <td>${r.command_id ? btn('detail','指令详情','link',r.command_id) : ''}</td></tr>`);
    $('logTable').innerHTML = panel(nodeLabel(node) + ' · 运行日志', (rows.length ? table(['北京时间','级别','事件 / 来源','账户 / 浏览器','记录',''], rows) : empty('此筛选下没有日志')) + pager(data.total,logsOffset,'logPage'));
  } catch (err) {
    if (seq === logRequest && $('logTable')) $('logTable').textContent = err.message;
  }
}

function analyticsView() {
  if (!$('reportFilters')) {
    const f = reportFilter;
    const nodes = option('', '全部节点') + state.nodes.map(n => option(n.id,n.label + ' · '+n.id,n.id === f.node_id)).join('');
    const stages = option('', '全部阶段') + Object.entries(phaseLabels).map(([v,l]) => option(v,l,v === f.phase)).join('');
    $('content').innerHTML = '<form class="report-filters panel" id="reportFilters"><label>节点<select name="node_id">' + nodes + '</select></label>' +
      '<label>账户<input name="account" list="reportAccounts" maxlength="160" placeholder="完整账户名" value="' + esc(f.account) + '"><datalist id="reportAccounts"></datalist></label>' +
      '<label>阶段<select name="phase">' + stages + '</select></label>' + input('from_date','起始日期',f.from_date,'date') + input('to_date','结束日期',f.to_date,'date') +
      input('start_time','每日开始',f.start_time,'time') + input('end_time','每日结束',f.end_time,'time') +
      '<div class="buttons"><button class="primary" type="submit">应用筛选</button>' + btn('resetReport','重置') + '</div></form>' +
      '<p class="report-hint">北京时间（UTC+8）。跨午夜时段归入开始日，每日结束时刻除外。</p><div id="reportResults" aria-live="polite"></div>';
    const form = $('reportFilters');
    function accountOptions() {
      const id = form.elements.node_id.value;
      const names = new Set(state.accounts.filter(a => !id || a.node_id === id).map(a => a.name));
      $('reportAccounts').innerHTML = [...names].sort().map(n => option(n,n)).join('');
    }
    form.elements.node_id.onchange = accountOptions;
    accountOptions();
    form.onsubmit = e => {
      e.preventDefault();
      reportFilter = Object.fromEntries([...new FormData(form)].filter(([,v]) => v.trim()).map(([k,v]) => [k,v.trim()]));
      reportOffset = 0;
      $('reportResults').textContent = '正在读取…';
      loadReport();
    };
  }
  loadReport();
}
function stageTable(nodes) {
  const row = (title, label, s, subtotal = false) => `<tr class="${subtotal ? 'subtotal' : ''}"><td>${esc(title)}</td><td>${esc(label)}</td>
    <td class="num">${s.wins} / ${s.losses} / ${s.flat}</td><td class="num">${s.settled}</td><td class="num">${rate(s.win_rate)}</td>
    ${numericCell(s.realized_pnl,true)}<td class="num">${s.unsettled}</td>${numericCell(s.total_paid)}${numericCell(s.total_withdrawn)}</tr>`;
  return nodes.length ? table(['节点','阶段','赢 / 亏 / 持平','已结算','胜率','已实现盈亏 · USDC','待补盈亏','平台出金净额 · USDC','系统核验扣款 · USDC'],
    nodes.flatMap(n => [row(n.label,'节点合计',n,true), ...n.stages.map(s => row('',phaseLabels[s.phase],s))])) : empty('尚无节点');
}
function detailTable(data) {
  if (!data.items.length) return empty('此筛选下暂无' + reportSections[data.section]);
  if (data.section === 'instruction') return commandsTable(data.items, reportTime);
  const account = item => '<td class="cell"><strong>' + esc(item.account) + '</strong><small>' + routeLabel(item) + '</small></td>';
  const phase = item => '<td class="nowrap">' + esc(phaseLabels[item.phase || 'unknown']) + '</td>';
  const ref = id => '<small class="record-note">' + esc(id) + '</small>';
  const market = i => '<td class="cell">' + esc(i.symbol || '—') + '<small>' + esc(dir[i.side] || i.side || '—') + '</small></td>';
  if (data.section === 'payout') {
    const states = {completed:'已完成',processing:'处理中',refunded:'已退款',failed:'失败'};
    return table(['创建 / 完成时间','来源账户 / 节点','平台记录编号','申请总额 · USDC','平台净额 · USDC','平台状态'],
      data.items.map(i => `<tr><td class="cell num">${reportTime(i.created_at)}<small>${reportTime(i.executed_at)}</small></td>${account(i)}
        <td>${ref(i.display_id || i.ref)}</td>${numericCell(i.gross_amount)}${numericCell(i.net_amount)}<td>${esc(states[i.status])}</td></tr>`));
  }
  if (data.section === 'withdrawal') return table(['核验时间','账户 / 来源','阶段','来源扣款 · USDC','预计到账 · USDC','回执'],
    data.items.map(i => '<tr><td class="num">' + reportTime(i.at) + '</td>' + account(i) + phase(i) + numericCell(i.amount) + numericCell(i.expected_received) +
      '<td>' + btn('detail','查看指令','link',i.command_id) + '</td></tr>'));
  if (data.section === 'order') return table(['创建 / 更新时间','账户 / 来源','阶段','合约 / 方向','订单类型 / 编号','数量','成交价','平台状态'],
    data.items.map(i => `<tr><td class="cell num">${reportTime(i.created_at)}<small>${reportTime(i.updated_at)}</small></td>${account(i)}${phase(i)}${market(i)}
      <td class="cell">${esc(i.order_type || '—')}${ref(i.display_id || i.ref)}</td><td>${esc(i.size_text || '—')}</td>${numericCell(i.execution_price)}<td>${esc(i.status || '—')}</td></tr>`));
  return table(['平仓 / 观测时间','账户 / 来源','阶段','合约 / 方向','持仓编号','数量','开仓价 / 平仓价','已实现盈亏 · USDC'],
    data.items.map(i => `<tr><td class="cell num">${reportTime(i.at)}<small>${i.closed_at ? '平台平仓' : i.closed ? '观测到平仓' : '最后记录为持仓'}${i.opened_at ? ' · 开 ' + reportTime(i.opened_at) : ''}</small></td>
      ${account(i)}${phase(i)}${market(i)}<td>${ref(i.ref)}</td>${numericCell(i.quantity)}<td class="num">${exact(i.entry_price)} / ${exact(i.exit_price)}</td>${numericCell(i.pnl,true)}</tr>`));
}
async function loadReport() {
  const seq = ++reportRequest;
  try {
    const data = await api('analytics?' + new URLSearchParams({...reportFilter,section:reportSection,offset:reportOffset}));
    if (seq !== reportRequest || page !== 'analytics') return;
    const s = data.summary, metrics = '<div class="metrics report-metrics">' +
      metric('已实现盈亏', exact(s.realized_pnl), `USDC · ${s.settled} 笔结算 · ${s.unsettled} 笔待补`, 'analytics') +
      metric('已结算胜率', rate(s.win_rate), `${s.wins} 赢 · ${s.losses} 亏 · ${s.flat} 持平`, 'positions') +
      metric('平台总出金', exact(s.total_paid), 'USDC 净额 · 已同步 ' + s.completed_payouts + ' 笔完成记录', 'accounts') +
      metric('系统已核验扣款', exact(s.total_withdrawn), 'USDC 毛额 · ' + s.withdrawals + ' 笔领取回执', 'commands') + '</div>';
    const tabs = Object.entries(reportSections).map(([key,label]) => btn('reportSection',label,key === reportSection ? 'chosen' : '',key)).join('');
    $('reportResults').innerHTML = metrics + panel('节点与阶段',stageTable(data.nodes) + '<div class="panel-body muted">胜率 = 盈利笔数 ÷ 有已实现盈亏的平仓笔数，持平计入分母。平台总出金取 Portfolio 已完成记录的净额。对实盘账户下达「同步订单与盈亏历史」可补录平台出金。</div>') +
      panel('账户历史','<div class="report-tabs">' + tabs + '</div>' + detailTable(data) + pager(data.total,reportOffset,'reportPage'));
  } catch (err) {
    if (seq === reportRequest && $('reportResults')) $('reportResults').textContent = err.message;
  }
}
Object.assign(operations, {
  logPage: value => { logsOffset = Number(value); return loadLogs(); },
  reportPage: value => { reportOffset = Number(value); return loadReport(); },
  reportSection: value => { reportSection = value; reportOffset = 0; return loadReport(); },
  resetReport: () => { reportFilter = {}; reportOffset = 0; $('content').replaceChildren(); return analyticsView(); }
});
