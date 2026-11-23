# Vest Fleet HTTP API v1

中心控制台使用以下 JSON 接口。成功响应为 HTTP 200，错误响应包含 `{"error":"原因"}`。认证失败返回 401，非法参数返回 400，资源不存在返回 404，目标状态或幂等键冲突返回 409。节点连接或协议异常在中心的节点状态中显示，直接核验时也可能返回 502。所有时间为 Unix 秒。

## 中心管理接口

请求头使用 `Authorization: Bearer <VEST_ADMIN_TOKEN>`。写请求使用 `Content-Type: application/json`。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/healthz` | 无密钥健康检查，只返回角色和版本 |
| GET | `/v1/state?node_id=cloud-01` | `nodes,workers,accounts,strategies,unknown_count,commands`。可省略节点取全网数据。一个节点范围内另返回 `strategy`，多节点时该字段为 `null` |
| GET | `/v1/nodes/{node_id}/accounts` | 节点独立目录及持仓快照，返回 `accounts` |
| POST | `/v1/nodes/{node_id}/accounts/refresh` | 正文 `{}`，返回新的 `generation`。在线浏览器通过账户页完成全量刷新，离线浏览器重连后补读 |
| GET | `/v1/nodes/{node_id}/logs?level=warning&offset=0` | 该节点的运行事件。可选 `level=info/warning/error`，返回 `total,items`，每页 50 条。事件的 `source` 为 `local`（中心）或 `bridge` |
| GET | `/v1/analytics` | 分节点、分阶段的盈亏、出金和历史明细，筛选参数见下文 |
| PUT | `/v1/nodes/{node_id}` | 登记或更新 `{label,url,token}`。更新时可省略密钥 |
| POST | `/v1/accounts/config` | 通过 `node_id,worker_id,account` 定位，更新 `alias,note,enabled,in_pool,account_ref` 中指定的字段 |
| PUT | `/v1/commands/{id}` | 用调用方生成的唯一 ID 创建指令，重复提交相同内容返回原记录 |
| GET | `/v1/commands?node_id=cloud-01&status=unknown&offset=0` | 可按节点和状态筛选，按创建时间倒序，每页 50 条，返回 `total,items` |
| GET | `/v1/commands/{id}` | 获取状态、目标、参数、资金操作许可记录、结果、错误和时间 |
| POST | `/v1/commands/{id}/cancel` | 请求取消尚未被插件领取的指令，正文为 `{}` |
| POST | `/v1/commands/{id}/resolve` | 人工结清待核验指令，正文为 `{"executed":true,"note":"平台记录和核验依据"}` |
| POST | `/v1/nodes/{node_id}/strategy/config` | 停止状态下更新该节点的 `batch_size,interval_seconds,side,size_percent,stop_buffer,take_profit` |
| POST | `/v1/nodes/{node_id}/strategy/start`、`/v1/nodes/{node_id}/strategy/stop` | 启停所选节点，正文为 `{}`。旧 `/v1/strategy/*` 兼容单节点，多节点须指定目标 |

### 筛选交易与出金

`GET /v1/analytics?node_id=cloud-01&from_date=2026-11-23&to_date=2026-11-23&start_time=22:00&end_time=02:00&section=position`

| 参数 | 含义 |
| --- | --- |
| `node_id,account` | 节点 ID、完整平台账户名。可独立使用，省略表示全部 |
| `phase` | `1/2`、`2/2`、`live` 或 `unknown` |
| `from_date,to_date` | 北京时间 `YYYY-MM-DD`，含首尾日期，可分别留空 |
| `start_time,end_time` | 每个所选日的 `HH:MM` 时段，左闭右开，结束早于开始时跨至次日。两者相等表示全天 |
| `section` | `position` 持仓盈亏、`order` 平台订单、`payout` 平台出金、`withdrawal` 系统领取回执、`instruction` 交易指令。默认为 `position` |
| `offset` | 当前明细的非负偏移，每页 50 条。切换明细和翻页保留同一筛选的汇总 |

响应包含 `timezone,summary,nodes,section,total,offset,items`。每个节点含 `node_id,label,stages` 和节点小计。汇总字段包括 `wins,losses,flat,settled,unsettled,win_rate,realized_pnl,total_paid,completed_payouts,total_withdrawn,withdrawals`。其中 `win_rate` 为 0 至 1 的比率，分母为有已实现盈亏的平仓数。无已结算样本时，胜率和已实现盈亏返回 `null`。金额统一为 USDC，聚合精度为百万分之一。

`total_paid` 统计平台已完成且有执行时间的出金净额。`total_withdrawn` 独立统计系统核验过来源余额的领取毛额。平台订单按创建时间、已结算持仓按平仓时间、平台已完成出金按执行时间、系统领取回执按余额核验时间筛选。缺平台时间的持仓使用已标明的观测时间。节点内对同一交易账户和编号去重，全网汇总还会去除跨节点的镜像记录。

### 下达只读指令

先从 `/v1/state` 取得路由。`worker_id` 是插件首次绑定时生成并保存在浏览器配置文件中的标识。`account` 填写平台完整账户名，别名仅供控制台显示。

```http
PUT /v1/commands/1d19c654-5061-4058-84ed-8d1503c751cc
Authorization: Bearer <VEST_ADMIN_TOKEN>
Content-Type: application/json

{
  "node_id": "cloud-01",
  "worker_id": "bbe81ca5-7a46-411f-b766-436a07b2df9a",
  "account": "平台完整账户名",
  "action": "account.read",
  "params": {}
}
```

成功创建后的初始状态通常为 `pending`。使用同一个 ID 调用 `GET /v1/commands/{id}` 直到获得终态。遇到响应丢失时，可以用原 ID 和原请求体重发 PUT。相同 ID 携带不同路由或参数会得到 409。正式使用时，为每次**新的**业务操作生成一个 UUID。

### 浏览器操作

| `action` | `account` | `params` | 成功返回的 `result` |
| --- | --- | --- | --- |
| `accounts.list` | 省略 | `{}` | `inventory`，包括完整名称、类别、阶段和重名标记 |
| `account.read` | 必填 | `{}` | `observation`，含余额、净值、浮盈亏、风险指标和时间 |
| `positions.read` | 必填 | `{}` | `observation.snapshot`，含明确的持仓状态、ID、方向、数量、均价和原生保护价 |
| `history.read` | 必填 | `{}` | 只读。补读该账户的历史持仓及原生订单，对实盘或已归档账户也尝试读取 Portfolio 出金。返回 `observation,tables`。各表含 `available` 和可用时的 `ready,rows_read,skipped,bottom_seen`。历史行分批写入节点桥 |
| `page.navigate` | 省略 | `destination` 取 `accounts`、`trade` 或 `portfolio` | 浏览器完成加载后核对的 `path` |
| `order.open` | 必填 | `{"side":"buy","micro":1,"stop_buffer":20}` | 已确认成交和原生保护的持仓快照。开仓许可凭据含下单时核定的爆仓线、缓冲和实际止损金额 |
| `order.close` | 必填 | `{"position_id":"页面持仓ID"}` | 全量平仓后的空仓快照 |
| `position.protect` | 必填 | `{"position_id":"页面持仓ID","stop_loss":100,"take_profit":250}` | 已核验的实际保护状态，至少指定一项金额 |
| `profit.withdraw` | 必填 | `{"amount":50}` | 核验后的源账户余额、申请金额、预计到账额与主账户收款对象 |

开仓方向为 `buy` 或 `sell`。`micro` 是正整数，也可用 `size_percent` 指定 25、50、75 或 100 百分档，两者选一。`stop_buffer` 是账户爆仓线上方要保留的 USD 净值，可为零，省略则使用该节点策略配置（初始 20）。填入平台的止损金额等于最新净值减去当日有效爆仓线，再减去缓冲，精确到美分。`take_profit` 为可选的单笔 USDC 金额。平仓和保护修改会固定派发时的持仓 ID、方向、数量、品种和均价。领取金额须为正数，最多六位小数。

账户目录中的 `card,card_at` 对应活动卡片，`risk,risk_at` 保留风控读数及上次交易页实读时间。`in_pool` 表示允许策略选用，`candidate` 表示当前会话、空仓、额度和风控条件允许进入下单前核验。`daily_floor` 含美东 20:00 交易日的 `start,end,reset_equity,daily_limit,gross_withdrawn,floor,source,verified`。`source` 可为 `reset`、`platform`、`estimate` 或 `conflict`。开仓前需要 `verified=true`。插件当前会话的 `card_session,card_generation,cards_full_at` 可用于检查全量刷新进度。

当前交易适配器针对 Vest NQ 桌面持仓表的单一可核验仓位。无法从页面唯一确认持仓时，`account.read` 的 `position_open` 可以是 `null`，`positions.read` 会返回失败。空仓使用 `false` 表示。`observed_at` 表示实际页面读取时间，`last_seen` 表示通信时间。

### 指令状态

| 状态 | 含义 |
| --- | --- |
| `pending` / `sending` | 中心已持久化 / 已经开始投递，等待桥确认 |
| `queued` / `running` | 桥已持久化 / 插件已独占领取 |
| `succeeded` | 已收到执行结果。资金操作还需通过对应回执核验 |
| `failed` | 参数、页面条件、权限或执行前置检查失败 |
| `expired` / `cancelled` | 指令已过期、被取消，或在开仓许可前发现读数差异。风控重选时 `result.reselect=true`、`intents={}` |
| `unknown` | 资金操作结果不确定，需检查 `intents`、`error` 和平台记录 |
| `resolved` | 已人工记录核验结论，`result.executed` 和 `result.note` 保留依据 |

`cancel_requested` 表示中心已发起取消。若浏览器在桥处理取消前已领取，中心继续跟踪原指令。已签发许可的操作不会因超时重新分配。指令排队有效期通常为 90 秒，开仓还受当日截止时间限制。插件领取后拥有 120 秒执行窗口。

## 节点桥接口

公网控制接口使用该节点独立的 `VEST_NODE_TOKEN`。插件接口位于本机 `http://127.0.0.1:8877`，使用该节点的 `VEST_PLUGIN_TOKEN`。两种密钥不可互换。

| 调用方 | 方法和路径 | 用途 |
| --- | --- | --- |
| 中心 | `GET /v1/status` | 节点 ID、协议版本、持久化实例 ID、浏览器会话、账户快照、历史序号 `ledger_seq` 和日志序号 `log_seq` |
| 中心 | `PUT /v1/status` | 使用 `instance_id,generation` 请求全节点全量刷新 |
| 中心 | `GET /v1/ledger?after=0` | 返回 `node_id,instance_id,items`，按递增 `seq` 返回游标之后最多 200 行。同一历史记录补全或更新时获得新序号 |
| 中心 | `GET /v1/logs?after=0` | 同样按序号返回最多 200 条节点本地日志。中心落盘后记录游标，重连续传 |
| 中心 | `PUT /v1/commands/{id}` | 投递不可变的执行请求，重复投递返回已有记录 |
| 中心 | `GET /v1/commands/{id}` | 查询桥上的权威执行状态 |
| 中心 | `PUT /v1/commands/{id}/cancel` | 携带原始执行请求，原子取消；先收到取消时也持久化取消记录 |
| 中心 | `POST /v1/commands/{id}/resolve` | 核验指定 `instance_id` 的未知结果 |
| 插件 | `POST /v1/plugin/heartbeat` | 上报浏览器、页面、只读或执行模式和当前会话 |
| 插件 | `POST /v1/plugin/report` | 上报账户页 `cards:{generation,full,observed_at,items}`、单账户 `observation` 或 `history:{name,items}`。旧插件可继续上报菜单 `inventory`。活动卡片按整份清单替换，历史每次最多 200 行 |
| 插件 | `POST /v1/plugin/preflight` | 在 NQ 交易页上报目标 `id,observation`。通过时返回 `approved,stop_loss,daily_floor`；需重选时原指令终止 |
| 插件 | `POST /v1/plugin/poll` | 原子领取一条指令，空闲返回 `{"command":null}` |
| 插件 | `POST /v1/plugin/intent` | 在实际资金操作前登记 `id,stage,proof` 并取得单次点击许可。开仓再次附上 `observation`，并用 `proof.quantity,proof.stop_loss` 核对实仓数量和表单金额 |
| 插件 | `POST /v1/plugin/result` | 按原会话和指令 ID 上报 `ok,result,error`，可重传回执 |

中心发送的执行请求包含管理接口的目标和参数，另有 `id,instance_id,session_id,phase,source,created_at,expires_at`。资金指令带 `account_ref`，平仓和保护修改还带 `expected_position`。插件上报时携带 `worker_id,session_id,generation,mode,label`；同一浏览器配置文件的授权轮次单调递增，旧轮次无法领取或授权点击。回执使用实际领取指令的会话。

中心每约 2 秒独立同步各节点；超过 20 秒没有成功同步，或最近一次同步失败，服务器显示离线。浏览器心跳超过 25 秒会显示离线，账户读数超过 180 秒会标记过期。会话切换后，账户需要在新会话再次读到才会恢复为新鲜读数。

## 中心下达节点软件更新

| 调用方 | 方法和路径 | 请求和结果 |
| --- | --- | --- |
| 管理员 | `PUT /v1/nodes/{node}/updates/{id}` | 正文 `{"revision":"<40位小写Git提交SHA>"}`。相同节点、ID 和提交可安全重试。每台节点同时可有一条待领取或执行中的更新 |
| 管理员 | `GET /v1/nodes/{node}/updates/{id}` | 返回 `state, revision, actual, detail, expected, confirmed, created, updated` 等字段。两个浏览器列表使用稳定的 `worker_id` |
| 管理员 | `POST /v1/nodes/{node}/updates/{id}/cancel` | 正文 `{}`，可撤销尚在 `queued` 的更新 |
| 节点更新服务 | `POST /v1/node-agent/{node}/poll` | 使用该节点独享的 `VEST_NODE_TOKEN`。发送 `instance_id,actual`，返回 `{"job":null}` 或 `{"job":{"id":"…","revision":"…"}}` |
| 节点更新服务 | `POST /v1/node-agent/{node}/report` | 发送 `instance_id,actual,id,revision,state,detail,expected`。重复最终回执返回已记录状态 |

中心持久化派发的节点、提交和进度。正常状态依次为 `queued → dispatched → preparing → applying → installed → succeeded`。其中 `installed` 表示桥健康、插件文件部署完毕。`succeeded` 还要求中心从桥上看到插件新版本的实际心跳。准备失败为 `failed`，恢复上一版为 `rolled_back`，待领取时撤销为 `cancelled`。尚待浏览器确认时派发后续版本会将上一条标记为 `superseded`。

`GET /v1/state` 的每个节点包含桥的 `release`、更新服务最近一次 `agent_seen` 与 `agent_release`、最近更新 `update`。每个浏览器的 `release` 来自已加载插件的 manifest。原手动部署版本可返回空字符串。节点钥匙仅用于本节点桥的控制接口及本节点的领取和回报接口。中心管理接口使用 `VEST_ADMIN_TOKEN`。详细部署与恢复步骤见[节点自动更新部署指南](deploy/UPDATES.md)。
