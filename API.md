# Vest Fleet HTTP API v1

中心控制台使用以下 JSON 接口。成功响应为 HTTP 200，错误响应包含 `{"error":"原因"}`。认证失败返回 401，非法参数返回 400，资源不存在返回 404，目标状态或幂等键冲突返回 409。节点连接或协议异常在中心的节点状态中显示，直接核验时也可能返回 502。所有时间为 Unix 秒。

## 中心管理接口

请求头使用 `Authorization: Bearer <VEST_ADMIN_TOKEN>`。写请求使用 `Content-Type: application/json`。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/healthz` | 无密钥健康检查，只返回角色和版本 |
| GET | `/v1/state?node_id=cloud-01` | `nodes,workers,accounts,strategies,strategy_settings,unknown_count,commands`。可省略节点取全网数据。一个节点范围内另返回 `strategy`，多节点时该字段为 `null` |
| GET | `/v1/position-metrics?node_id=cloud-01` | 活动账户的最新卡片数值，包括浮盈、回撤、日损及上限、持仓数和采样时间 `at`。省略节点时返回所有节点。页面可每秒读取。其余控制台状态可用 `/v1/state?since=initial` 建立基线，后续携带返回的 `status_cursor` 读取变化 |
| GET | `/v1/nodes/{node_id}/accounts` | 节点独立目录及持仓快照，返回 `accounts` |
| POST | `/v1/nodes/{node_id}/accounts/refresh` | 全量拉取账户列表。正文 `{}`，返回新的 `generation`。在线浏览器读取活动卡片，离线浏览器重连后补读 |
| POST | `/v1/nodes/{node_id}/accounts/read-all` | 全量读取账户信息。正文 `{}`，为该节点支持该指令的在线浏览器各创建一条指令，返回 `commands`（指令 ID）和 `skipped`（需升级的浏览器 ID）。重复点击复用同一会话仍在执行或待领取的中心指令 |
| GET | `/v1/nodes/{node_id}/logs?level=warning&offset=0` | 该节点的运行事件。可选 `level=info/warning/error`，返回 `total,items`，每页 50 条。事件的 `source` 为 `local`（中心）或 `bridge` |
| GET | `/v1/analytics` | 分节点、分阶段的盈亏、出金和历史明细，筛选参数见下文 |
| PUT | `/v1/nodes/{node_id}` | 登记或更新 `{label,url,token}`。更新时可省略密钥 |
| POST | `/v1/accounts/config` | 通过 `node_id,worker_id,account` 定位，更新 `alias,note,enabled,in_pool,account_ref` 中指定的字段 |
| PUT | `/v1/commands/{id}` | 用调用方生成的唯一 ID 创建指令，重复提交相同内容返回原记录 |
| GET | `/v1/commands?node_id=cloud-01&status=unknown&offset=0` | 可按节点和状态筛选，按创建时间倒序，每页 50 条，返回 `total,items` |
| GET | `/v1/commands/{id}` | 获取状态、目标、参数、资金操作许可记录、结果、错误和时间 |
| POST | `/v1/commands/{id}/cancel` | 请求取消尚未被插件领取的指令，正文为 `{}` |
| POST | `/v1/commands/{id}/resolve` | 人工结清待核验指令，正文为 `{"executed":true,"note":"平台记录和核验依据"}` |
| PUT | `/v1/strategy/defaults` | 用部分或完整配置更新全局默认参数。新登记节点获得一份副本 |
| PUT | `/v1/strategy/presets/{id}` | 创建或更新命名预设，正文为 `{"name":"晚间","config":{"batch_size":3}}`。同名方案须使用原 ID |
| POST | `/v1/strategy/presets/{id}/delete` | 删除预设，正文为 `{}` |
| POST | `/v1/nodes/{node_id}/strategy/config` | 停止状态下更新该节点的部分或完整配置。应用预设时提交对应的 `config` |
| POST | `/v1/nodes/{node_id}/strategy/start`、`/v1/nodes/{node_id}/strategy/stop` | 启停所选节点，正文为 `{}`。旧 `/v1/strategy/*` 兼容单节点，多节点须指定目标 |

### 策略参数

`state.strategy_settings` 返回 `defaults` 和 `presets`。每个预设含 `id,name,config`。节点策略独立保存 `config,batch,batch_side,planned,members,next_at,message`，其中 `planned` 为已选中且待到时派发的账户，`members` 为已派发指令 ID。运行中的队列和同批方向跨中心重启保留。

| 字段 | 含义 |
| --- | --- |
| `batch_size,order_delay_min,order_delay_max,batch_delay_min,batch_delay_max` | 批量及批内、批间等待区间（秒）。旧客户端的 `interval_seconds` 仍可设置固定批间等待 |
| `pool_strategy,same_stage_full_batch` | `random`、`same_stage` 或 `dynamic`。同阶段模式可指定不足整批时顺延 |
| `live_priority,account_priority_order` | 启用阶段排序及三个阶段的完整排列，默认 `["live","2/2","1/2"]` |
| `pool_limits_enabled,exam_pool_limit,live_pool_limit` | 开启池容量限制。上限为正整数或 `"infinity"` |
| `dynamic_reserve_low,dynamic_reserve_high,dynamic_live_target,dynamic_exam_slots` | 动态候补下限和恢复线、Live 目标存量和每批补位考核名额。名额可为 `null` 以使用自动分配 |
| `refresh_account_pool,live_default_locked` | 等待新增候选并在美东日切时刷新账户池，以及 Live 默认锁定。关闭自动刷新时，本轮运行中仍会纳入新发现的合格账户，现有账户无法组批时结束。启动前均先拉取完整活动清单 |
| `side,size_percent,phase2_size_percent,stop_buffer` | 考核方向、1/2 与 2/2 各自的仓位百分档、USD 缓冲 M。考核开仓清空止盈 |
| `live_take_profit_mode` | `fixed` 使用 `live_take_profit`，`ratio` 使用 `live_reward_ratio,live_min_take_profit`。这两种模式使用 `live_size_percent` |
| `live_first_take_profit,live_first_size_percent,live_repeat_take_profit,live_repeat_size_percent` | `entries` 模式按单个账户本交易日确认成交情况选取首次或后续档。每个档位的金额和仓位独立 |
| `skip_stop_loss_on_floor_gap,floor_gap_threshold` | 考核与 Live 共用的有符号底线差额开关和 USD 阈值，默认开启、20 USD |
| `skip_stop_loss_on_low_drawdown,drawdown_stop_loss_threshold` | 考核号免止损开关与 USD 阈值，Live 使用对应的 `live_` 前缀。默认关闭，阈值初始为 200 |
| `live_payout_recipient,live_payout_mode,live_payout_amount,live_payout_percent` | 主账户 `main` 收款。方式为 `all`、`amount`、`percent` |

`order.open` 可携带 `omit_floor_gap_below`（今日底线减去最大回撤线）和 `omit_stop_below`（净值减去最大回撤线）。指标严格低于相应阈值时该规则命中。两项按或判断，未提供的阈值不启用。开仓前及签发点击许可时均核对本账户交易页，免止损返回 `stop_omitted=true,stop_loss=null`。Live 策略和免止损指令需要节点上报 `workers[].strategy_version=1`。已核验的策略领取通过 `strategy_payout.open_id` 关联原开仓，再入场通过 `reentry_claim` 关联已扣款的领取指令。

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
| `accounts.list` | 省略 | `{}` | 全量拉取账户列表，从 `/accounts` 的活动卡片更新缓存，返回 `inventory` 和 `count` |
| `accounts.read_all` | 省略 | `{}` | 全量读取账户信息，先全量拉取列表并确认本地缓存，再在 `/portfolio` 逐户读取并回传。返回 `listed_at,total,read,partial,failed,accounts` |
| `account.read` | 必填 | `{}` | `observation`，含余额、净值、浮盈亏、风险指标和时间 |
| `positions.read` | 必填 | `{}` | `observation.snapshot`，含明确的持仓状态、ID、方向、数量、均价和原生保护价 |
| `history.read` | 必填 | `{}` | 只读。补读该账户的历史持仓及原生订单，对实盘或已归档账户也尝试读取 Portfolio 出金。返回 `observation,tables`。各表含 `available` 和可用时的 `ready,rows_read,skipped,bottom_seen`。历史行分批写入节点桥 |
| `page.navigate` | 省略 | `destination` 取 `accounts`、`trade` 或 `portfolio` | 浏览器完成加载后核对的 `path` |
| `order.open` | 必填 | `{"side":"buy","micro":1,"stop_buffer":20}` | 已确认成交和原生保护的持仓快照。开仓许可凭据含下单时核定的爆仓线、缓冲和实际止损金额 |
| `order.close` | 必填 | `{"position_id":"页面持仓ID"}` | 全量平仓后的空仓快照 |
| `position.protect` | 必填 | `{"position_id":"页面持仓ID","stop_loss":100,"take_profit":250}` | 已核验的实际保护状态，至少指定一项金额 |
| `profit.withdraw` | 必填 | `{"amount":50}` | 核验后的源账户余额、申请金额、预计到账额与主账户收款对象。可加 `"all_available":true`，仅在页面可领总额恰好等于申请金额时提交 |
| `profit.available` | 必填，Live 账户 | `{}` | 只读打开 Portfolio 利润领取预览，返回 `account,phase,available,observed_at`。策略通过 `strategy_payout.quote_id` 关联这个读数，以本次页面可领额决定领取。节点需支持 `payout_quote_version=1`，插件需为 1.7.1 或更高版本 |

开仓方向为 `buy` 或 `sell`。`micro` 是正整数，也可用 `size_percent` 指定 25、50、75 或 100 百分档。两者选一。`stop_buffer` 为净值缓冲 M，省略时使用该节点对应阶段的设置（初始 20 USD）。需要设置止损时，止损金额取净值至今日底线的距离与剩余最大回撤的较小值，再减去 M，向下取整至美分。开仓许可记录 `equity`、`daily_floor.floor`、`max_drawdown_floor`、`floor_gap`、`distance_to_max_floor` 和 `remaining_max_drawdown`。Live 开仓可传固定金额 `take_profit` 或 `reward_ratio` 配合 `min_take_profit`。盈亏比的风险基数是本单止损金额，免止损时使用净值至爆仓线的距离。平仓和修改保护会核对持仓 ID、方向、数量、品种和均价。

目录中的 `card,card_at` 对应活动卡片，`risk,risk_at` 保留风控读数及上次交易页实读时间。`in_pool` 表示允许策略选用，`candidate` 表示当前可以进入下单前核验。`open_locked` 表示当前日内开仓锁，`open_lock.reason,until` 给出原因和到期时间。`daily_floor.floor` 是平台实读值，`observed_at` 是其读取时间，`source` 为 `platform` 或 `pending`。每次开仓核验都需要本次交易页的 `snapshot.daily_floor`。日切或已确认提现后的底线等待读取。插件当前会话的 `card_session,card_generation,cards_full_at` 可用于检查全量刷新进度。

`GET /v1/state` 的 `plugin_version` 为中心所附插件版本。每个 worker 的 `plugin_version` 为浏览器上报版本，`version_status` 为 `current,behind,ahead,unknown` 之一。节点 `GET /v1/status` 也返回各 worker 的版本，受管安装的 Git 提交保存在 `release`。开仓需要节点 `open_policy_version=3` 和插件 1.8.0 或更高版本。

从 1.7.0 起，稳定清单通过 `/v1/plugin/report` 的 `metrics` 上报。批次含 `generation,base_at,observed_at,directory,items`，每行只含账户名和变化的数字。持仓期间每秒读取活动卡片，常规清单核对时一并更新其他账户的变化值。基线过期、成员变动或强制拉取时重新传送清单。中心使用 `GET /v1/status?since=initial` 取得节点基线，随后携带返回的 `status_cursor`，按 `changes` 中的路径和值更新同一基线。

活动账户的 `position_detail` 按节点、浏览器、账户和持仓 ID 关联已核实的成交。保护金额使用真实成交数量与原生触发价核算，确认未设置的字段为 `"omitted"`，未知为 `null`。`submitted_at` 记录浏览器获得本次下单许可的时间。多笔持仓只有账户合计时，卡片数值按账户展示一次。

全量读取的 `result.stage` 依次为 `list`、`cache`、`portfolio`、`done`。清单确认前失败会停在对应步骤。每个账户保存完整名称、卡片 ID、状态及读数或错误。金额单位为 USD，`daily_loss/daily_limit` 和 `drawdown/drawdown_limit` 为当前值和上限，`equity` 为账户价值，`health` 为百分数。缺失值为 `null` 并列入 `missing`。页面明确显示无日损上限时记录 `daily_unlimited=true`。部分读取时指令状态为 `failed`，已读结果仍可查询。节点目录中的 `accounts[].portfolio` 保存每户最近一次详情，`workers[].portfolio_scan` 提供最近一次进度，包括插件本地发起的读取。

当前交易适配器针对 Vest NQ 桌面持仓表的单一可核验仓位。无法从页面唯一确认持仓时，`account.read` 的 `position_open` 可以是 `null`，`positions.read` 会返回失败。空仓使用 `false` 表示。`observed_at` 表示实际页面读取时间，`last_seen` 表示通信时间。

### 指令状态

| 状态 | 含义 |
| --- | --- |
| `pending` / `sending` | 中心已持久化 / 已经开始投递，等待桥确认 |
| `queued` / `running` | 桥已持久化 / 插件已独占领取 |
| `succeeded` | 已收到执行结果。资金操作还需通过对应回执核验 |
| `failed` | 参数、页面条件、权限或执行前置检查失败 |
| `expired` / `cancelled` | 指令已过期、被取消，或实读后需要重新选池。重选时 `result.reselect=true`、`intents={}` |
| `unknown` | 资金操作结果不确定，需检查 `intents`、`error` 和平台记录 |
| `resolved` | 已人工记录核验结论，`result.executed` 和 `result.note` 保留依据 |

`cancel_requested` 表示中心已发起取消。若浏览器在桥处理取消前已领取，中心继续跟踪原指令。已签发许可的操作不会因超时重新分配。指令排队有效期通常为 90 秒，开仓还受当日截止时间限制。插件领取后拥有 120 秒执行窗口。全量读取按步骤计算时限，每次确认清单、缓存或逐户回执后重新计时，连续 120 秒无进展则保留结果并结束。

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
| 插件 | `POST /v1/plugin/heartbeat` | 上报浏览器、`plugin_version`、页面、只读或执行模式和当前会话 |
| 插件 | `POST /v1/plugin/read-all` | 通过已绑定会话为本浏览器创建只读全量读取任务，返回 `id` |
| 插件 | `POST /v1/plugin/report` | 上报账户页 `cards:{generation,full,observed_at,items}`、单账户 `observation` 或 `history:{name,items}`。全量读取时清单须带 `scan_id`，详情按户上报 `portfolio:{id,name,card_id,values}` 或 `error`。旧插件可继续上报菜单 `inventory` |
| 插件 | `POST /v1/plugin/preflight` | 上报目标 `id,observation`，以交易页读数更正缓存。合格时返回 `approved,stop_loss,take_profit,daily_floor,changed` 继续原指令。日内风控锁通过 `open_lock` 返回 |
| 插件 | `POST /v1/plugin/poll` | 原子领取一条指令，空闲返回 `{"command":null}`。支持全量读取的插件上报 `portfolio_version:1`，本地清单写入成功后发送 `cached_scan` 指令 ID，按 `scan.stage` 和 `scan.target` 执行 |
| 插件 | `POST /v1/plugin/intent` | 开仓携带 `id,stage,proof,observation`，用 `proof.quantity,stop_loss,take_profit` 核对表单。传入 `allow_refill=true` 后，金额变化时返回 `refill=true,authorize_click=false` 和最新金额。填妥后用同一指令再次核验，仅 `authorize_click=true` 允许一次点击 |
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
