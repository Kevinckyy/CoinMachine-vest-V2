# Linux 控制中心与 Windows Server 节点的 IP 部署

使用固定 IPv4 与自选 HTTPS 端口。安装脚本通过 Git 读取本仓库已发布的 `main`，中心使用稀疏检出，节点仅下载所选提交的 `fleet/` 和 `extension/` 文件内容。脚本安装依赖、签发 IP 证书、登记节点、设置防火墙和登录任务，首次打开活动账户页时自动只读配对。

## 准备

- Linux 使用带 systemd、apt-get 或 dnf 的服务器，以 root 或 sudo 运行。发行版需提供 Podman、OpenSSL 1.1.1+、Python 3.7+。安装器会安装这些包，以及 curl 和 CA 证书。容器内应用使用 Python 3.12。以下示例使用一台新中心。
- Windows 使用 x64 Windows Server 2019 或更新的桌面体验版，安装 Git for Windows，在今后运行浏览器的用户桌面打开管理员 PowerShell。脚本下载 PSF 的 Python 运行时、官方 Caddy 和 Google 的 Chrome for Testing，并使用独立浏览器配置文件。[Python Windows 包](https://docs.python.org/3/using/windows.html#the-nuget-org-packages) · [Chrome for Testing 下载源](https://github.com/GoogleChromeLabs/chrome-for-testing)
- 示例地址均为文档保留 IP，执行前换成实际地址。云安全组放行中心的 TCP 8443（管理电脑和节点访问），节点的 TCP 8443（中心出口 IP 访问），以及用于首次登记的 SSH 端口。脚本管理主机防火墙；云安全组由云平台管理。源站拉取需要两端均能读取 GitHub 仓库，私有仓库请预先为实际运行账号配置只读凭据。

## 一、安装中心

将交付的 `vest-deploy.tar.gz` 上传至 Linux，运行：

```bash
tar -xzf vest-deploy.tar.gz
sudo bash vest-deploy/deploy/bootstrap/center.sh install 203.0.113.10 8443
```

也可以从已包含这些脚本的仓库执行 `sudo bash deploy/bootstrap/center.sh install 203.0.113.10 8443`。中心使用 SSH 部署密钥拉取私有仓库时，在安装命令前使用 `sudo env VEST_GIT_URL=git@github.com:Kevinckyy/CoinMachine-vest-V2.git bash ...`。

成功后访问 `https://203.0.113.10:8443`。管理密钥保存在服务器 `/var/lib/vest-fleet/admin.token`，管理员可用 `sudo cat /var/lib/vest-fleet/admin.token` 查看。管理电脑通过 SSH 取得 **公开的** `/var/lib/vest-fleet/center-root.crt`，将它导入当前用户的受信任根证书。Windows 管理电脑可执行 `certutil -user -addstore Root .\center-root.crt`。同一台电脑若已运行节点安装器，已经信任该证书。

验证中心的 TLS 和应用响应：

```bash
sudo curl --cacert /var/lib/vest-fleet/center-root.crt \
  --connect-to 203.0.113.10:8443:127.0.0.1:8443 https://203.0.113.10:8443/healthz
```

响应的 `service` 应为 `center`。查看服务日志使用 `sudo journalctl -u vest-fleet-center -u vest-fleet-center-https -n 80`。数据库在 `/var/lib/vest-fleet/data/center.sqlite3`。要迁移原中心，应先暂停原策略、结清在途指令、停止原中心，通过 SQLite 备份接口生成完整备份，再于首次运行此脚本前放入上述路径。旧节点请保留原身份与通信密钥；以下登记流程用于新增节点。

### Docker Hub 连接超时后的恢复

若 Podman 日志显示拉取 Python 或 Caddy 时连接 `registry-1.docker.io:443` 超时，先用 `uname -m` 确认架构。`x86_64` 选择 `vest-offline-amd64.tar.gz`，`aarch64` 或 `arm64` 选择 `vest-offline-arm64.tar.gz`。将对应离线包传到已执行过首次安装的中心，在包所在目录运行以下命令（例为 x86_64）：

```bash
tar -xzf vest-offline-amd64.tar.gz
sudo bash vest-offline/recover.sh
```

恢复脚本核对架构和 SHA-256，向 root 的 Podman 镜像库导入缺失的官方镜像，然后按已保存的 IP 和端口接续安装。它在本机通过 HTTPS 核验中心身份后才显示 `Center ready`。数据库、管理密钥、证书和 Git 版本沿用原安装。已通过其他方式导入同名镜像的服务器可在新版脚本目录直接运行 `sudo bash center.sh resume`。

## 二、在每台 Windows Server 安装节点

从交付包取出 `deploy/bootstrap/node.ps1`，或者使用随附的单独脚本。将它放在 Windows 的任意工作目录，在该目录的管理员 PowerShell 执行：

```powershell
.\node.ps1 -CenterSsh root@203.0.113.10 -NodeId cloud-02 -PublicIP 198.51.100.20 -Port 8443
```

`-PublicIP` 填这台 Windows 节点的地址。首次 SSH 登录需核对中心主机指纹，按现有 SSH 方式认证。非 root SSH 用户需要能用 sudo 非交互执行 `bash /opt/vest-fleet/bootstrap/center.sh bundle ...`。可以用 `-SshPort 2222` 指定 SSH 端口。若中心的实际出站 IP 和控制台入口不同，用 `-CenterSourceIP` 指定 Windows 入站防火墙允许的源 IP。节点使用 GitHub 只读 SSH 部署密钥时加 `-Ssh`。

安装器会通过 SSH 登记该节点并取得专属证书和密钥，通过 HTTPS 验证中心和桥，然后自动打开已加载插件的专用浏览器。首次登录自己的 Vest 账号，进入 `https://next.vestmarkets.com/accounts`，中心即可看到只读浏览器。在中心下达「全量拉取账户列表」验收回执。需要资金操作时，从插件明确选择「允许执行指令」。

遇到 `ssh: connect to host ... port 22: Connection timed out` 时，Windows 尚未连到中心的 SSH 监听端口。若要继续使用 SSH，可在中心用 `sudo ss -lntp` 核对实际端口，在 Windows 用 `Test-NetConnection <中心IP> -Port <SSH端口>` 验证连通性，再通过 `-SshPort` 指定该端口。`-Port` 设置的是 Windows 节点桥的 HTTPS 端口。

也可以在云控制台登录 Linux 中心生成同一个安装包，通过已认证的文件传输通道送至 Windows 当前用户的个人下载目录，再用原脚本导入：

```bash
sudo bash /opt/vest-fleet/bootstrap/center.sh node cloud-02 198.51.100.20 8443
# 输出 /var/lib/vest-fleet/nodes/cloud-02/cloud-02.zip
```

```powershell
.\node.ps1 -Bundle "$env:USERPROFILE\Downloads\cloud-02.zip"
```

节点包包含此节点的 TLS 私钥和通信凭据，请按密钥文件保存。中心的 CA 私钥和管理员密钥保留在 Linux 上。Windows 安装目录默认为 `%LOCALAPPDATA%\VestFleet`，日志为其下的 `node-state\agent.log`。每台节点保留唯一 ID，节点桥内部 8877 仅监听回环。默认每台 Windows 使用一个专用浏览器配置文件。

## 重跑和维护

### 更新控制中心及已部署的 Windows 节点

有版本号的安装包把中心更新入口和节点发布入口放在同一目录，`release.json` 固定完整 Git 提交和插件版本。已有 1.8.0 安装可解压新版包，在 Linux 中心依次运行：

```bash
cd vest-deploy/deploy/bootstrap
sudo python3 update_center.py
sudo bash update-nodes.sh --node cloud-01
```

中心脚本使用原 Git 仓库和本机已安装的服务，先取回并核对发布版本，再短暂停止中心，备份 SQLite、切换代码并核验 HTTPS 与中心实报的插件版本。更新失败会尝试恢复旧代码，保留已写入的业务账本；兼容性要求同节点更新。原先停止的服务更新后保持停止。中断后重跑同一命令会先回滚未完成的切换。备份位于 `/var/lib/vest-fleet/backups/`。

节点命令向中心提交更新。重复 `--node` 可选择多台，`--wait 300` 可调整等待时长。终端输出本次 `request_id`，响应丢失后用 `--request-id 原ID` 重试。退出码 2 表示中心仍在等待确认，可以继续在控制台查看该节点的更新记录。需要指定其他已发布版本时，两条命令均支持 `--revision 完整SHA`。

Windows 受管节点的计划任务会自动执行中心指令。若需要在节点上唤醒已安装的任务并查看本地回执，在浏览器用户的 PowerShell 运行 `.\Update-VestNode.ps1 -Revision 完整SHA`，与 `release.json` 放在同一目录时可省略参数。Edge 应加载安装目录的 `node-state\extension`。中心的「服务器 → 浏览器」显示每个浏览器实际上报的插件版本；升级后的执行授权需要在插件中重新确认。

相同地址与节点 ID 可以重跑，脚本复用原数据库、密钥和浏览器配置。中心与节点叶证书有效期 397 天，剩余不足 30 天时，重跑相应安装命令会重新签发并加载证书。中心 CA 有效期 10 年，应安全备份 `/var/lib/vest-fleet`，并在 CA 到期前安排根证书轮换。浏览器、Caddy、Python 在首次安装时下载，后续宿主运行时升级属主机维护。

Windows 节点的桥、代理和浏览器随该用户登录启动。后续应用更新由中心「服务器 → 节点更新」下达已发布的完整 Git SHA；更新服务核对数据与版本后才切换。安装脚本取得的是已发布代码，本机尚未提交推送的策略或插件修复需先发布，再指定对应版本。[节点更新指南](../UPDATES.md)
