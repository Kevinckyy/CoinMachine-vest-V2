# Vest Fleet 离线更新包

适用于已经部署的 Linux 控制中心与受管 Windows 节点。目标插件版本和完整 Git 提交见 `release.json`。包内包括应用源码、工作台、节点桥、插件和更新脚本。沿用机器上已安装的运行环境。

把压缩包和同名 `.sha256` 文件放在 Linux 中心的同一目录下，执行以下命令。将文件名中的版本号换成本次交付的版本。

```bash
package=vest-fleet-update-1.12.4.tar.gz
sha256sum -c "$package.sha256" && tar -xzf "$package" && sudo bash vest-fleet-update/update.sh
```

默认更新控制中心，并向已配置的中心 HTTPS 版本仓库发布目标提交。切换版本前备份 SQLite，启动后核验 HTTPS 和中心实报版本；启动失败时回滚代码。相同提交可以重跑。原本停机的中心保留停机状态。

要同时向指定节点下达更新指令，使用下面的命令。重复 `--node` 可选择多台。也可以在更新中心后，在「服务器 → 节点更新」选择节点并填写 `release.json` 中的完整 SHA。

```bash
sudo bash vest-fleet-update/update.sh --node cloud-01
```

Windows 常驻代理通过 HTTPS 领取指令，更新节点桥和插件并回报。已配置中心 HTTPS 版本仓库的节点从中心取版。早期在线安装的节点仍从原 Git 源取版；若这些节点也须脱离 GitHub，先按完整离线部署包说明一次性接入中心版本仓库。

默认等待 180 秒；`--wait 0` 表示提交后返回。退出码 2 也可能表示等待浏览器确认超时，届时可在中心查看回执。相同节点和版本重复运行时复用指令 ID。如一次更新已失败、修复原因后需要新指令，可指定新的 `--request-id`。如提示已恢复上次中断的中心更新，重跑命令即可。受管插件重载后可在中心核对心跳和执行权限。
