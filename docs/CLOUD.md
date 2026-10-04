# Linux 云端部署、切换与验收

## 1. 运行方式和资源

使用带 systemd/logind 的 Linux 主机及专用普通账号（下文 live-monitor），目录 /opt/live-monitor。示例管理员命令适用于 Ubuntu/Debian；其他发行版换相应包管理命令。不是精简容器部署。建议1 vCPU/1GB起步；编译 SQLite 内存不足时需增加内存或临时 swap，按实际测量调整。

仅需要出站 HTTPS 到 B 站、飞书及安装依赖的站点，管理需要 SSH。无需网页服务、业务公网端口、域名或数据库服务器。先确认云端真实 B 站接口能访问；云出口可能被风控，成功的本机查询不代表云端成功。

Mac 的每次开机确认仅应用于 Mac。云服务器采用无人值守：管理员配置 linger + 用户服务 enable 后，主机重启和 SSH 退出后仍运行；手工 stop 会禁用后续自启动。云端没有 GUI 确认框。服务状态、崩溃恢复验收和重启验收均有对应步骤。

## 2. 管理员准备一次性资源

下面在服务器管理员终端执行；已有账号或目录时复用，不盲目重复创建：

```sh
sudo apt-get update
sudo apt-get install -y nodejs npm python3 build-essential rsync
sudo adduser --disabled-password --gecos '' live-monitor
sudo install -d -o live-monitor -g live-monitor -m 750 /opt/live-monitor
sudo loginctl enable-linger live-monitor
```

用管理员认可的方法将 Mac SSH 公钥加入该账号 authorized_keys，权限目录700、文件600；不复制私钥到云端。业务无需给服务账号 sudo。发行版 Node/npm 只用来运行安装器，服务实际采用项目内 Node24。

linger 会在开机启动用户管理器，并在用户退出后保持运行，依据 [loginctl 官方说明](https://www.freedesktop.org/software/systemd/man/252/loginctl.html)。

## 3. 在 Mac 配置 SSH

本地 ~/.ssh/config 示例；替换真实主机地址和密钥路径：

```sshconfig
Host live-monitor
  HostName YOUR_SERVER
  User live-monitor
  IdentityFile ~/.ssh/YOUR_KEY
  IdentitiesOnly yes
  ServerAliveInterval 30
```

手动 `ssh live-monitor`，按可信渠道核对主机指纹，完成 known_hosts。然后 `ssh -o BatchMode=yes live-monitor 'id'` 应无交互成功。不要关闭 StrictHostKeyChecking 来规避身份检查。

本机 config.yaml 的 deployment.cloud.ssh_host=live-monitor，install_dir=/opt/live-monitor。Mac 是非敏感配置来源；不要手动把本机 deployment.active 改成 cloud，正式切换由 switch 管理。

## 4. 同步源码并在 Linux 重装依赖

先保持云端未运行，本机可继续工作。在 Mac 项目目录执行：

```sh
rsync -az --exclude=node_modules --exclude=.runtime --exclude=.npm-cache \
  --exclude=.node-gyp --exclude=.env --exclude=var --exclude=dist \
  --exclude=.git --exclude=evidence ./ live-monitor:/opt/live-monitor/
ssh live-monitor
cd /opt/live-monitor
bin/setup
cp .env.example .env             # 仅首次部署
chmod 600 .env
```

必须在 Linux 重新安装，不复制 Mac 的 Node 或 better-sqlite3 原生模块。云端用编辑器填写自己的 FEISHU_WEBHOOK 和 FEISHU_WEBHOOK_SECRET；可以指向同一个专用群机器人，但凭证不通过 switch 自动传输。系统服务不继承交互 shell 的 export；使用项目 .env 才能在重启后加载。

```sh
bin/monitor check-config --probe
PATH="$PWD/.runtime/node_modules/node/bin:$PATH" npm test
bin/monitor test-notification
bin/monitor service install --side cloud
bin/monitor service doctor --side cloud
```

期望 doctor 报 installed、user_manager、linger 为 true。此时只做单次查询和测试通知，尚未运行监控，不与本机重复订阅。确认群内云端测试消息及手机提醒。测试通知文案为通用通知测试，不代表实际开播。

若报 Failed to connect to bus，在 SSH 登录服务账号后确认 `systemctl --user show-environment` 成功；管理员检查 pam_systemd、systemd-logind、user@UID.service 和 linger。不要在 root shell 直接用 systemctl --user 操作另一个账号，也不要以全局 root 服务替代未解决的用户会话配置。

退出云端：`exit`。

## 5. Mac → 云端切换

```sh
# Mac 项目目录执行
bin/monitor switch cloud
bin/monitor status
ssh live-monitor 'cd /opt/live-monitor && bin/monitor service health --side cloud'
```

命令先检查云端安装、用户管理器和 linger，再校验目标凭证、真实检测入口；先停止目标旧实例，再停止源实例，确认退出，迁移 SQLite 和 YAML，启动目标并等待健康。本机确认停止前不会启动云端。两端 .env 不复制。

Mac status 应 configured_active=cloud、cloud_status.status_fresh=true。本机 local_status 可能保留旧记录，应 running=false；另外 `launchctl print gui/$(id -u)/com.bilibili.live-monitor` 应没有运行服务。云端 `systemctl --user is-active live-monitor.service` 应 active。时段外 outside_window 是有效健康状态。

若切换失败，读取错误信息：目标无法确认停止时不会恢复源端；能确认停止时尝试迁回最新去重状态并恢复源端。切换中断后先检查双方，不手动同时启动。

## 6. SSH 退出、崩溃与服务器重启验收

SSH 退出：退出服务账号 SSH，等待约30秒，从 Mac 再连接并执行 health 和 status。仍运行且 started_at 没变，证明没有依赖原 SSH 会话。

崩溃恢复：在云端服务账号终端执行（会中断监控，优先选时段外）：

```sh
cd /opt/live-monitor
bin/monitor service verify-recovery --side cloud
bin/monitor service health --side cloud
```

verify-recovery 先验证应用健康、读取 systemd MainPID 并比对，再显式发 SIGKILL，最多等待约60秒。recovered=true 和两个不同 PID 才算实际通过；权限不足或恢复超时报错，不自动宣称成功。实例锁15秒过期，systemd20秒后重启；同一 SQLite 文件保留已发送记录。

服务设置 Restart=always、RestartSec=20，禁用启动频率锁死；手工 systemctl stop 不触发自动拉起。长期凭证/配置错误会每20秒再次启动并记录错误，需要管理员修复或 stop，不会自己恢复错误凭证。参见 [systemd 官方服务定义](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml)。

服务器重启验收必须由管理员选定维护时间（可能影响服务器其他业务），不要由项目脚本自动 reboot：

```sh
# 重启前：服务账号
cat /proc/sys/kernel/random/boot_id > var/boot-before.txt
systemctl --user is-enabled live-monitor.service
loginctl show-user "$(id -u)" --property=Linger --value
bin/monitor status > var/status-before-reboot.json
# 管理员另行执行经过确认的服务器重启
# 重启后：重新 SSH 到服务账号，无需手动 service start
cat /proc/sys/kernel/random/boot_id
cat var/boot-before.txt
bin/monitor service doctor --side cloud
bin/monitor service health --side cloud
bin/monitor status
```

两个 boot_id 不同、unit enabled、linger=yes、重新连接时 health 已通过，才算开机自启动验收；如果先手动启动，就不能证明是自动启动。同一场持续直播不得重复发送；等待下一场真实开播才能证明新场去重行为。

手机通知仍需手机实际确认，与 Linux 或 Mac 服务是否健康独立。消息已在群内但手机未弹出时按 REPRODUCE_MAC 的通知排查步骤操作。

## 7. 切回 Mac、升级与停用

```sh
# Mac 执行；本次开机未确认时先 confirm-start
bin/monitor confirm-start
bin/monitor switch local
bin/monitor status
```

期望云端 inactive/disabled，本机 healthy 或 outside_window，最新 SQLite 去重记录已经迁回。

升级云端代码：先在 Mac switch local；确认云端停用后，按步骤4同步源码，不同步 .env、var；在云端重新 bin/setup、npm test、check-config、service install、service doctor，然后 Mac switch cloud。两端保持相同源码版本；仅拷贝源码但不构建不会更新实际 dist。

云端停用：服务账号执行 `bin/monitor service stop --side cloud`；它 disable --now，不删除状态。再次启动需 active=cloud 并用 service start；已有本机运行时应使用 switch cloud。备份数据库用 state-export（要求服务已停），不要在线复制 SQLite。先保留上一版本源码及服务停止后的数据库备份，再更新，失败可以还原。

日志和排错：

```sh
bin/monitor status
journalctl --user -u live-monitor.service -n 80 --no-pager
tail -n 40 var/events.log
```

| 现象 | 检查与动作 |
|---|---|
| doctor 提示缺 linger | 管理员 enable-linger 服务账号，再检查 |
| 云端 probe -412/429/网络失败 | 检查出口、时间与 DNS；保留上次状态并退避，不把失败当下播，不规避平台风控 |
| 飞书报错 | 核对云端 .env 与权限600、签名配置、手机/群状态；改好后测试发送 |
| 服务反复退出 | journalctl 看 fatal_error，检查 Node24、原生模块、active 与凭证 |
| 状态新鲜但 blocked/retrying | 查询失败或认证问题，health 不会当成健康 |
| ELOCKED | 确认没有第二进程；刚崩溃等锁过期，不直接删锁 |
| 切换 SSH 不可用 | 检查 BatchMode、公钥、指纹、目录和代码版本，不启动另一端冒充切换成功 |

## 8. 云端验收记录模板

当前无服务器资源，因此以下都等待实机验证，不能以本地测试通过代替：

| 验收 | 结果/北京时间/证据路径 |
|---|---|
| Linux 构建与普通测试 | 待填 |
| B站云出口真实查询 | 待填 |
| 群消息及手机提醒 | 待填 |
| doctor、启动健康、时段外等待 | 待填 |
| 本机→云端→本机，始终单实例且去重保留 | 待填 |
| SSH退出持续运行 | 待填 |
| verify-recovery 返回不同PID | 待填 |
| 服务器重启后不手动启动即健康 | 待填 |
| 实际开播一次通知及延迟 | 待填 |
