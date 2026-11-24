'use strict';

let logsOffset = 0, logLevel = '', logRequest = 0;
let reportOffset = 0, reportSection = 'position', reportRequest = 0, reportFilter = {};
const reportSections = {position:'持仓盈亏',order:'平台订单',account_history:'账户历史',deposit:'链上入金',chain_withdrawal:'链上提现',
  payout:'Live 利润领取',withdrawal:'领取回执',instruction:'交易指令'};
const lifecycleLabels = {'1':'已创建','2':'活动','3':'考核通过','4':'触及最大回撤','5':'触及日损上限','6':'已领取','7':'已到期'};
let historyState = '';
const accountSections = new Set(['position','order','payout','account_history']);
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
  return nodes.length ? table(['节点','阶段','赢 / 亏 / 持平','已结算','胜率','已实现盈亏 · USDC','待补盈亏','Live 领取净额 · USDC','系统核验扣款 · USDC'],
    nodes.flatMap(n => [row(n.label,'节点合计',n,true), ...n.stages.map(s => row('',phaseLabels[s.phase],s))])) : empty('尚无节点');
}
function detailTable(data) {
  if (!data.items.length) return empty('此筛选下暂无' + reportSections[data.section]);
  if (data.section === 'instruction') return commandsTable(data.items, reportTime);
  const account = item => '<td class="cell"><strong>' + esc(item.account) + '</strong><small>' + routeLabel(item) + '</small></td>';
  const phase = item => '<td class="nowrap">' + esc(phaseLabels[item.phase || 'unknown']) + '</td>';
  const ref = id => '<small class="record-note">' + esc(id) + '</small>';
  const market = i => '<td class="cell">' + esc(i.symbol || '—') + '<small>' + esc(dir[i.side] || i.side || '—') + '</small></td>';
  if (data.section==='account_history') return table(['账户 / 节点','平台账户 ID','阶段','状态','方案','起始资金','最终净值','阶段净值变动','创建 / 激活时间','结束时间'],
    data.items.map(i=>`<tr>${account(i)}<td>${ref(i.ref)}</td>${phase(i)}<td>${esc(lifecycleLabels[i.status] || i.status)}</td><td>${esc(i.plan || '—')}</td>${numericCell(i.initial_capital)}${numericCell(i.final_equity)}${numericCell(i.closed && Number.isFinite(i.final_equity) && Number.isFinite(i.initial_capital) ? i.final_equity-i.initial_capital : null,true)}<td class="cell">${reportTime(i.created_at)}<small>${reportTime(i.activated_at)}</small></td><td>${reportTime(i.finalized_at)}</td></tr>`));
  if (['deposit','chain_withdrawal'].includes(data.section)) return table(['创建时间','账户 / 节点','金额','币种','状态','链','交易哈希 / 记录编号'],
    data.items.map(i=>`<tr><td>${reportTime(i.created_at)}</td>${account(i)}${numericCell(i.amount)}<td>${esc(i.currency || '未标明')}</td><td>${esc(i.status)}</td><td>${esc(i.chain_id || '—')}</td><td>${ref(i.tx_hash || i.ref)}</td></tr>`));
  if (data.section === 'payout') {
    const states = {completed:'已完成',processing:'处理中',refunded:'已退款',failed:'失败'};
    return table(['创建 / 完成时间','来源账户 / 节点','平台记录编号','申请总额 · USDC','交易者所得 · USDC','平台分成 · USDC','平台状态'],
      data.items.map(i => `<tr><td class="cell num">${reportTime(i.created_at)}<small>${reportTime(i.executed_at)}</small></td>${account(i)}
      <td>${ref(i.display_id || i.ref)}</td>${numericCell(i.gross_amount)}${numericCell(i.net_amount)}${numericCell(i.platform_amount)}<td>${esc(states[i.status] || i.status)}</td></tr>`));
  }
  if (data.section === 'withdrawal') return table(['核验时间','账户 / 来源','阶段','来源扣款 · USDC','预计到账 · USDC','回执'],
    data.items.map(i => '<tr><td class="num">' + reportTime(i.at) + '</td>' + account(i) + phase(i) + numericCell(i.amount) + numericCell(i.expected_received) +
      '<td>' + btn('detail','查看指令','link',i.command_id) + '</td></tr>'));
  if (data.section === 'order') return table(['创建 / 更新时间','账户 / 来源','阶段','合约 / 方向','订单类型 / 编号','委托数量','成交数量','成交价','手续费','平台状态'],
    data.items.map(i => `<tr><td class="cell num">${reportTime(i.created_at)}<small>${reportTime(i.updated_at)}</small></td>${account(i)}${phase(i)}${market(i)}
      <td class="cell">${esc(i.order_type || '—')}${ref(i.display_id || i.ref)}</td><td>${i.quantity!=null ? exact(i.quantity) : esc(i.size_text || '—')}</td>${numericCell(i.executed_quantity)}${numericCell(i.execution_price)}${numericCell(i.fee)}<td>${esc(i.status || '—')}</td></tr>`));
  return table(['平仓 / 观测时间','账户 / 来源','阶段','合约 / 方向','持仓编号','数量','开仓价 / 平仓价','已实现盈亏 · USDC'],
    data.items.map(i => `<tr><td class="cell num">${reportTime(i.at)}<small>${i.closed_at ? '平台平仓' : i.closed ? '观测到平仓' : '最后记录为持仓'}${i.opened_at ? ' · 开 ' + reportTime(i.opened_at) : ''}</small></td>
      ${account(i)}${phase(i)}${market(i)}<td>${ref(i.ref)}</td>${numericCell(i.quantity)}<td class="num">${exact(i.entry_price)} / ${exact(i.exit_price)}</td>${numericCell(i.pnl,true)}</tr>`));
}
async function loadReport() {
  const seq = ++reportRequest;
  try {
    const data = await api('analytics?' + new URLSearchParams({...reportFilter,section:reportSection,
      owner_state:accountSections.has(reportSection) ? historyState : '',offset:reportOffset}));
    if (seq !== reportRequest || page !== 'analytics') return;
    const s = data.summary, metrics = '<div class="metrics report-metrics">' +
      metric('已实现盈亏', exact(s.realized_pnl), `USDC · ${s.settled} 笔结算 · ${s.unsettled} 笔待补`, 'analytics') +
      metric('已结算胜率', rate(s.win_rate), `${s.wins} 赢 · ${s.losses} 亏 · ${s.flat} 持平`, 'positions') +
      metric('Live 利润领取', exact(s.completed_payouts ? s.total_paid : null), 'USDC 净额 · 已同步 ' + s.completed_payouts + ' 笔完成记录', 'accounts') +
      metric('系统已核验扣款', exact(s.withdrawals ? s.total_withdrawn : null), 'USDC 毛额 · ' + s.withdrawals + ' 笔领取回执', 'commands') + '</div>';
    const tabs = Object.entries(reportSections).map(([key,label]) => btn('reportSection',label,key === reportSection ? 'chosen' : '',key)).join('');
    const historyFilter = accountSections.has(reportSection) ? '<div class="report-tabs" role="group" aria-label="归属账户当前状态">'+Object.entries({'':'全部账户',active:'活动账户',closed:'已关闭账户'}).map(([key,label])=>btn('historyState',label,historyState===key?'chosen':'',key)).join('')+'</div>' : '';
    const cash = (data.cash || []).map(c=>reportSections[c.kind]+' · '+(c.currency || '未标币种')+' · 已完成金额 '+exact(c.settled_amount)+'（共 '+c.records+' 条）');
    const coverage = ['已采集 '+(data.counts?.account_history || 0)+' 个账户，其中 '+(data.counts?.closed_accounts || 0)+' 个已结束',
      (data.counts?.order || 0)+' 笔平台订单',...cash].map(esc).join(' · ');
    $('reportResults').innerHTML = historyFilter + metrics + panel('节点与阶段',stageTable(data.nodes) + '<div class="panel-body muted">胜率 = 盈利笔数 ÷ 有已实现盈亏的平仓笔数，持平计入分母。Live 领取净额取已完成且有执行时间的交易者所得。</div>') +
      panel('历史明细','<div class="panel-body row"><small>'+coverage+'</small>'+btn('importArchive','导入历史 JSON')+'</div>'+
        '<div class="panel-body muted">统计范围为节点浏览器已加载及已导入的历史页。可在 Vest 查看账户历史、订单或钱包流水后同步，未加载的分页不计入。</div>'+
        '<div class="report-tabs">' + tabs + '</div>'+detailTable(data) + pager(data.total,reportOffset,'reportPage'));
  } catch (err) {
    if (seq === reportRequest && $('reportResults')) $('reportResults').textContent = err.message;
  }
}
Object.assign(operations, {
  historyState: value=>{historyState=value || ''; reportOffset=0; return loadReport();},
  importArchive: ()=>{
    const workers=state.workers.filter(w=>!reportFilter.node_id || w.node_id===reportFilter.node_id);
    if (!workers.length) throw Error('所选范围尚无节点浏览器');
    const kinds=['account_history','position','order','deposit','chain_withdrawal','platform_payout'];
    dialog('导入 Vest 历史 JSON',grid(select('target','来源节点和浏览器',workers.map(w=>option(JSON.stringify([w.node_id,w.worker_id]),nodeLabel(w.node_id)+' / '+workerLabel(w.node_id,w.worker_id))).join(''))+
      select('kind','数据类型',kinds.map(k=>option(k,reportSections[k==='platform_payout'?'payout':k])).join(''))+
      input('owner','订单或持仓所属平台账户 ID（行内缺少时填写）','','text','maxlength="160"')+
      '<label>响应 JSON 文件<input name="file" type="file" accept=".json,application/json" required></label>')+
      '<p>选择一个原始响应页或记录数组。订单需要平台账户 ID，重复导入会按平台编号更新。</p>', '导入',async form=>{
        const [node_id,worker_id]=JSON.parse(form.get('target')),kind=form.get('kind');
        const payload=JSON.parse(await form.get('file').text());
        const rows=Array.isArray(payload) ? payload : payload?.[kind==='account_history'?'accounts':kind==='position'?'positions':'items'];
        if (!Array.isArray(rows) || !rows.length) throw Error('文件中没有该类型的记录');
        const items=rows.map((r,i)=>{
          const item=VestArchive.project(kind,r,form.get('owner').trim() || null);
          if (!item) throw Error('第 '+(i+1)+' 行缺少有效的平台标识、金额、账户归属或时间');
          return item;
        });
        for(let i=0;i<items.length;i+=50) await api('analytics/import','POST',{node_id,worker_id,items:items.slice(i,i+50)});
        notify('已处理 '+items.length+' 条历史记录'); await loadReport();
      });
  },
  logPage: value => { logsOffset = Number(value); return loadLogs(); },
  reportPage: value => { reportOffset = Number(value); return loadReport(); },
  reportSection: value => { reportSection = value; reportOffset = 0; return loadReport(); },
  resetReport: () => { reportFilter = {}; historyState = ''; reportOffset = 0; $('content').replaceChildren(); return analyticsView(); }
});
