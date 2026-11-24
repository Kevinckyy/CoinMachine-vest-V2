# 由中心发布节点更新

管理员在中心选定节点和一个已推送到 `main` 的完整 Git 提交。目标节点上的常驻 Python 服务领取指令，在节点本地更新桥和插件，并把结果写回中心。向 GitHub 推送代码本身不会触发部署。一次可以选一台或多台，中心独立跟踪每台的结果。

## 首次接入

Linux 控制中心与 Windows Server 节点使用公网 IP 和端口时，可直接使用[自动安装脚本](bootstrap/README.md)。脚本会安装环境、生成证书、登记节点，并在专用浏览器加载插件。

1. 中心先运行本仓库的新代码。已有 Compose 中心更新工作目录后，运行 `docker compose --env-file center.env -f deploy/center.compose.yml up -d` 并 `docker compose --env-file center.env -f deploy/center.compose.yml restart center`，沿用原卷和管理密钥。
2. 在每个节点准备下列配置。节点访问中心的 HTTPS 地址，中心访问节点原有的 HTTPS 桥地址。更新服务通过出站 HTTPS 领取指令，无需额外开放端口。原有节点沿用原 ID、桥数据库和独立密钥。旧部署若共用节点密钥，先在各节点与中心换成一一对应的密钥。
3. 按下方步骤安装适合该主机的更新服务。旧节点首次迁移时，先暂停该节点策略，等已有浏览器操作返回，再将原桥进程交给新服务托管。其余节点可继续运行。
4. 在节点桌面的每个 Chrome / Edge 配置文件里，加载**节点状态目录内的 `extension`**，刷新已登录的 Vest 交易页并从插件弹窗绑定。旧目录加载的插件应先停用。浏览器以路径标识无固定公钥的解压扩展，首次换目录时可能会分配新的插件和浏览器标识。中心按新的浏览器标识登记账户，核对策略池后即可恢复该节点策略。

```dotenv
VEST_CENTER_URL=https://control.example.com
VEST_NODE_ID=cloud-01
VEST_NODE_TOKEN=<该节点独立的中心通信密钥>
VEST_PLUGIN_TOKEN=<该节点独立的本机插件密钥>
VEST_DOMAIN=bridge-01.example.com
```

将文件保存为节点本地的 `bridge.env`。Windows 的原生更新服务读取每行 `KEY=value`，值使用原文，无需包引号。`VEST_DOMAIN` 供容器中的 Caddy 使用。中心管理密钥保存在中心或管理员终端。

### Linux 云桌面与 Docker Compose

在目标节点的仓库根目录，以运行桌面浏览器的账号创建状态目录，使浏览器可以读取其中的插件。Compose 沿用项目名 `vest-bridge`、原 `bridge-data` 数据卷和 Caddy 证书卷。

```sh
install -d -m 700 node-state
revision=$(git rev-parse HEAD)
docker compose --env-file bridge.env -f deploy/bridge.managed.compose.yml build bridge
docker compose --env-file bridge.env -f deploy/bridge.managed.compose.yml run --rm --no-deps bridge init --state /node --revision "$revision"
docker compose --env-file bridge.env -f deploy/bridge.managed.compose.yml up -d
```

浏览器加载宿主机的 `node-state/extension`。原桥若使用自定义 Compose 项目名或外置卷，请在托管配置中沿用相同项目名和卷名。中心会核对原数据库的实例 ID。

**GitHub 仓库需要认证时**，可为每台节点配置只有读取权限的 deploy key。在宿主机专用目录放入 `id_ed25519` 与核对过 GitHub 主机指纹的 `known_hosts`，私钥文件权限为 600。在 `bridge.env` 中增加 `VEST_GIT_SSH_DIR=/该专用目录的绝对路径`。用下面的命令替代上面三条 Docker 命令。挂载采用只读模式，请使用单独的专用目录。[GitHub 部署密钥说明](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys) · [GitHub 公布的 SSH 指纹](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints)

```sh
compose() { docker compose --env-file bridge.env -f deploy/bridge.managed.compose.yml -f deploy/bridge.git-ssh.compose.yml "$@"; }
compose build bridge
compose run --rm --no-deps bridge init --state /node --revision "$revision" --ssh
compose up -d
```

### Windows 云桌面

使用运行浏览器的 Windows 账号安装 Python 3.12+、Git，在仓库目录运行下列 PowerShell。旧节点的 `-Database` 填原数据库的绝对路径。运行身份需要对该库和状态目录有写权限，并能非交互读取仓库。HTTPS 使用该账号的 Git 凭据管理器，SSH 部署密钥方式在安装命令末尾加 `-Ssh`。

```powershell
.\deploy\Install-VestNode.ps1 -Revision (git rev-parse HEAD) -StateDir 'C:\Vest\node-state' -Database 'C:\Vest\data\bridge.sqlite3' -EnvFile 'C:\Vest\bridge.env'
```

安装器注册并启动当前桌面账号的登录任务 `VestFleet.Node.<节点ID>`。浏览器加载 `C:\Vest\node-state\extension`。已有的公网 HTTPS 反向代理继续指向本机桥。节点日志在 `C:\Vest\node-state\agent.log`。

若使用现有服务管理器，可在节点运行同一入口。下面两步分别用于首次安装与常驻运行。

```sh
python deploy/node_agent.py init --state ./node-state --revision "$(git rev-parse HEAD)"
python deploy/node_agent.py run --state ./node-state --env-file ./bridge.env --db ./runtime/bridge.sqlite3
```

## 从中心下达更新

在中心进入「服务器 → 节点更新 → 下达更新」，勾选节点，填入已发布的 40 位小写 Git 提交 SHA。在「节点更新」看目标提交、当前桥版本和节点回执，在「浏览器」看每个配置文件实际加载的版本。在「运行日志」可查看该节点历次更新。多台发布时，可以先选一台，确认后再选其余节点。

也可从持有中心管理密钥的终端运行以下命令。预先通过本机密钥管理方式设置 `VEST_ADMIN_TOKEN`。每个新批次使用新的 `--request-id`。同一批操作如遇到响应丢失，沿用原 ID、目标节点和提交重试。

```sh
python deploy/dispatch_update.py --center https://control.example.com --node cloud-01 --node cloud-02 --revision "$(git rev-parse HEAD)" --request-id rollout-001 --wait 180
```

`--wait` 的单位为秒，省略时提交后退出。等待时，退出码 0 表示目标节点均已确认，1 表示请求或部署失败，2 表示仍有节点等待确认。等待超时后中心继续跟踪。接口字段见[更新 API](../API.md#中心下达节点软件更新)。

## 切换、确认与回滚

- 节点空闲时每约三秒向中心查询分配给自己的指令。中心等待该节点原有指令结清，同时暂停为其创建新的手动和策略指令。离线节点在恢复后领取，领取前管理员可以撤销。
- 更新服务固定从本项目仓库读取指定提交，验证其位于 `main` 历史，提取 `fleet/` 和 `extension/`。切换时保存事务进度，排空桥端操作，停止自己托管的桥，并备份 SQLite。新的桥须通过端口、节点 ID、数据库实例、进程标识和实际版本检查，才会发布插件文件。
- 插件在本机桥与已部署文件的版本一致后自行重载。原来已绑定且仍打开的 Vest 标签页会刷新，以原浏览器标识和新的只读会话连接。需要继续资金操作时，在插件弹窗重新授权。Chrome 的扩展运行时与内容脚本依照其重载和页面注入机制工作。[Chrome 扩展运行时](https://developer.chrome.com/docs/extensions/reference/api/runtime#unpacked_extension_behavior) · [Chrome 扩展重载说明](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world)
- 中心分别展示「已安装，等待插件确认」与「桥和插件均已确认」。切换时在线的各浏览器可以先后回报。切换时没有在线浏览器，中心等待首个已绑定浏览器的新版本心跳。关闭的浏览器在下次打开后读取已部署版本，必要时在 Vest 页重新绑定。
- 拉取失败或提交无效时，节点继续运行原版并回传失败。切换过程中桥健康检查失败，或节点服务中断后重启，会恢复上一版桥和插件，并保留当前业务数据库。最终回执持久化，中心断线后会补传。若浏览器确认长期未到，可以在中心主动下达一个已知正常的托管提交回退，并检查浏览器是否在线、绑定、加载了固定目录。
- `node-state/active.json` 记录当前版本，`transaction.json` 记录未结更新，`backups/` 存放切换前的数据库快照。自动回滚使用原业务库，保留切换后收到的回执。发布版本的数据库变更需要兼容上一版本。常驻更新器随首次安装固定在宿主机或镜像中，升级更新器本身时由主机管理员维护。
