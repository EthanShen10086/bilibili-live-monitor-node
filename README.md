# B 站开播订阅 → 飞书通知（Node 独立仓库）

本仓库是独立源码快照，不带凭证或已安装运行环境。下面的原 Mac 验收历史不代表新 clone 已部署；拆分后的验证见 docs/VALIDATION.md。

后续资源接入从 [RESOURCE_SETUP.md](RESOURCE_SETUP.md) 开始；当前真实/模拟验证范围见 [VALIDATION.md](VALIDATION.md)。

完整步骤：[Mac 操作复现与本次记录](REPRODUCE_MAC.md)、[Linux 云部署与验收](CLOUD_DEPLOYMENT.md)、[代码实现原理与更新](IMPLEMENTATION.md)。

默认订阅 **1616**，真实房间 ID **11163068**；北京时间周三、周五、周六、周日
18:00–24:00 每约 1 分钟查询一次，发到飞书专用群。本机 Mac 优先；支持配置切换
Linux 云服务器、飞书机器人私聊和官方授权事件连接。

## 当前验证结果

- 真实 B 站状态查询成功，返回 `code=0`、真实房间 ID 11163068、未开播状态；
  未使用 Cookie，也没有绕过风控。接口属于网页侧接口，未来可用性不保证。
- 端到端工作进程测试使用模拟接口，覆盖发送、持久化、退出、重启去重和下一场。
- 飞书签名群消息真实发送通过，Mac 客户端群内可见；Mac LaunchAgent 已安装、启用，健康检查通过，本次启动已确认。
- 常规测试34项通过，1项真实发送测试默认跳过；test:live此前已单独实测通过。
- 手机提醒、实际崩溃恢复、跨电脑重启、真实云端切换及官方授权仍待验收。不把模拟测试或服务配置当作这些行为已实测。

## 本机快速开始

按本次确认的启动规则，先看 [LOCAL_MAC_SETUP.md](LOCAL_MAC_SETUP.md)：每次电脑重启后的首次登录先确认，同次启动内再次登录自启动、崩溃自恢复。

在这个目录执行；`bin/setup` 安装项目内 Node 24.21.0，不修改系统 Node。
SQLite 优先使用包内预编译模块；安装器如需编译，需要 Python 3 和 C/C++ 工具链（Mac Xcode Command Line Tools；Linux build-essential）。构建缓存保存在项目 `.node-gyp/`，不写入系统缓存。
这是独立源码仓库；新 clone 后先执行 bin/setup 安装和构建。

```sh
bin/setup                  # 新机器安装时执行；需要已有 npm 和网络
cp .env.example .env       # 仅首次安装，不要覆盖现有真实凭证
chmod 600 .env
```

用编辑器打开 `.env`，只填写所选模式需要的凭证。默认群通知需要：

```dotenv
FEISHU_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/你的实际地址
FEISHU_WEBHOOK_SECRET=机器人签名密钥
```

在飞书目标群中添加「自定义机器人」，开启签名校验。不要把密钥发到聊天中、
提交到 Git 或贴进命令参数。`.env` 加入了忽略规则，并强制要求文件权限为 600。
环境变量已经存在时优先使用环境变量，`.env` 不覆盖它。

```sh
bin/monitor probe                     # 无通知凭证也能独立查询真实房间状态
bin/monitor check-config --probe       # 校验所选模式凭证和检测入口
bin/monitor test-notification          # 会真实发一条测试消息
bin/monitor run                        # 前台运行；Ctrl+C 停止
```

确认群内消息和手机提醒后，退出前台进程，再安装后台服务：

```sh
bin/monitor service install --side local
bin/monitor service start --side local
bin/monitor service doctor --side local
bin/monitor service health --side local
bin/monitor status
bin/monitor service stop --side local
```

安装会写入 `~/Library/LaunchAgents/com.bilibili.live-monitor.plist`。每次电脑重启后的首次登录先弹出确认；本次启动已确认后，登录自动恢复、异常退出自动重启；监控时段内 Mac 要联网且不能系统睡眠。关闭屏幕可以，合盖或
系统睡眠不保证继续运行。服务本身不会更改你的电源设置。

## 配置切换

编辑 `config.yaml`，然后重启当前服务使配置生效。星期一为 1；时段是同日区间，
开始包含、结束不包含，`24:00` 表示当天结束；目前不支持跨午夜的单个区间。
时区由 `Intl` 解析，默认 `Asia/Shanghai`。

- `detector.mode`: `polling` 或 `official`，默认 `polling`。
- `notification.mode`: `feishu_group` 或 `feishu_private`，默认群通知。
- `schedule`: 星期、时区和每天开始/结束时间。
- `deployment.cloud`: SSH 别名与云端安装目录。
- `deployment.active`: 由部署切换命令管理；只在初始配置时手动修改。
- `deployment.local.confirm_each_boot`: 默认 true，按电脑启动周期记住确认；false 表示登录后直接运行。

未选中的模式无需凭证；所选模式缺凭证会报错，官方模式不会偷偷降级为轮询。
正常轮询每次请求结束后再等待间隔，查询失败不改变直播状态，退避最长 5 分钟。

### 飞书机器人私聊

在飞书开放平台创建企业自建应用，启用机器人能力，申请
`im:message:send_as_bot` 发送权限，按所在租户要求发布并获得审批。
将你加入应用可用范围，取得**这个应用对应的** `open_id`。

将配置改为 `notification.mode: feishu_private`，在 `.env` 中填写：

```dotenv
FEISHU_APP_ID=应用ID
FEISHU_APP_SECRET=应用密钥
FEISHU_RECEIVE_ID=你的open_id
```

程序获取并缓存 `tenant_access_token`，到期提前刷新，明确的失效响应触发刷新
后再尝试一次。相同通知使用稳定 UUID；它仅在飞书平台规定的去重窗口内有效。
调用 `bin/monitor test-notification` 验证真实私聊。

此方案只发送消息，不接收聊天指令，不需要公网回调或飞书事件订阅。
参考：https://open.feishu.cn/document/server-docs/im-v1/message/create

### 官方事件模式

此模式不是「填写任意房间号就能监听」。需要官方开发者认证、项目权限及
主播身份码或官方允许的授权条件。你作为观众无法取得目标授权时，继续使用轮询。

配置 `detector.mode: official`，填写以下环境变量：

```dotenv
BILI_APP_ID=项目数字ID
BILI_ACCESS_KEY_ID=开发者访问key
BILI_ACCESS_KEY_SECRET=开发者访问密钥
BILI_ANCHOR_CODE=已授权目标主播的身份码
```

连接流程：签名调用 start → 验证授权房间 → WebSocket 认证 → 连接与场次心跳
→ 开播/下播事件处理 → end。身份不匹配、认证失败不会产生该房间通知；断线或
场次结束会先清理旧场次，再退避重建。窗口外关闭连接，清理失败时停止新建连接。

预检 `check-config --probe` 只校验配置和状态入口，不建立官方场次，避免干扰正在运行的源实例。若要单独验证官方认证，先停止两端监控，再执行 `bin/monitor check-config --probe --official-auth`；该命令会创建、认证并结束一个测试场次。

事件使用 `LIVE_OPEN_PLATFORM_LIVE_START`/`LIVE_OPEN_PLATFORM_LIVE_END`，实际消息
结构和你项目的权限须实测。官方模式仍在连接时使用一次公开状态快照，解析短号
并补齐当前状态；不是轮询降级，也不进行每 1 分钟查询。此快照接口不可用时，
官方模式暂时也无法启动。服务器端身份码/场次生命周期可能不支持跨下播监控，
需要真实跨两场直播验证，不能据此保证 1616 可用或事件不会漏。

库固定为上游官方接入提交，来源及本地兼容修改见
`vendor/bilibili-live-ws/PROVENANCE.md`。未使用已停止维护的旧 bilibili-api SDK。

参考：https://open-live.bilibili.com/document

## 云服务器准备和切换

建议 Linux + systemd，从 1 vCPU/1 GB 内存起步；只有出站业务连接，无需域名或
公网 HTTP 端口。SSH 需要可达。使用专用普通服务账号，准备 `/opt/live-monitor`
可写目录；云端采用该账号的 **systemd 用户服务**。

首次准备（按你的系统由管理员执行）：

```sh
sudo mkdir -p /opt/live-monitor
sudo chown 服务账号:服务账号 /opt/live-monitor
sudo loginctl enable-linger 服务账号
```

`enable-linger` 让用户服务在 SSH 退出和主机重启后继续运行；需要用户 systemd
会话正常，精简容器或缺少用户 bus 的机器不适用此部署方式。

在 Mac 的 `~/.ssh/config` 配好 `Host live-monitor`、HostName、User 和私钥，
先手动连接一次，验证服务器身份并建立 known_hosts。管理命令使用 BatchMode，
不关闭主机密钥校验，不弹密码提示。修改 `config.yaml` 的 SSH 别名和目录。

从本机复制项目（不复制凭证、状态、本机二进制，也不删除云端现有文件）：

```sh
rsync -az --exclude=node_modules --exclude=.runtime --exclude=.npm-cache --exclude=.node-gyp \
  --exclude=.env --exclude=var --exclude=dist ./ live-monitor:/opt/live-monitor/
ssh live-monitor
cd /opt/live-monitor
bin/setup
cp .env.example .env
chmod 600 .env
# 用编辑器填写云端自己的凭证，变量名保持一致
bin/monitor check-config --probe
bin/monitor service install --side cloud
bin/monitor service doctor --side cloud
exit
```

云端初始不启动。然后在 Mac 执行：

```sh
bin/monitor switch cloud
bin/monitor status
bin/monitor confirm-start   # 本次电脑启动尚未确认时，先在 Mac 明确确认
bin/monitor switch local
```

切换先验证目标配置及检测入口，停止目标的旧服务，再停止源服务并确认退出，
迁移 SQLite 和配置，更新双方运行位置，启动目标并健康检查。本机是非敏感配置
的管理来源；`.env` 始终留在各自机器，不迁移。两端需使用相同代码版本；本命令
不自动升级代码或创建云服务器。切回本机前若修改了配置，新配置将在本机生效，
云端配置在下一次切到云端时同步。

目标启动后健康检查失败，会先停止目标；若目标运行过，迁回其最新状态，然后
恢复源服务。任何停止无法确认的情况都会拒绝再启动另一个实例。实例锁和 Mac
管理锁防止同端并发；不提供自动双机容灾，不要绕过管理命令同时手动启动两端。
如果切换命令被强制杀死，先检查两端状态并停止服务，再恢复所需运行位置；
没有自动恢复中断切换的行为。

## 状态、失败与日志

- `bin/monitor status`：本机状态；运行位置为云端时还会经 SSH 查询云端状态。
- `bin/monitor retry-failed`：修复通知凭证后，重新排队尚未超过原 30 分钟 TTL 的
  永久失败消息。在云端运行时，在云端执行这个命令。
- 修改配置后重启：`service stop`，再 `service start`，side 对应当前运行端。
- `var/state.sqlite`：场次、去重和消息队列；不要在进程运行中复制或覆盖。
- `var/events.log`：后台事件日志，单文件约 2 MB 后轮转，保留 3 个历史文件。
- `var/status.json`：更新时间、检测状态、最近观察、最近发送及通知失败状态。
- Linux 服务管理日志：`journalctl --user -u live-monitor.service`。
- `service doctor --side cloud`：预检安装、用户管理器及 linger；不发送消息、不启动检测。
- `service verify-recovery --side local|cloud`：主动终止当前健康后台进程并验证新 PID 恢复，最多约60秒；只在计划验收时执行。云端重启和手机验收见 [CLOUD_DEPLOYMENT](CLOUD_DEPLOYMENT.md)。

每个场次只建立一次任务。优先按真实房间 ID + 开播时间去重；没有开播时间时
按观察到的状态变化建立本地场次。首次启动、窗口开始或恢复连接时，若已经开播，
发送一次「当前正在直播」。直播标题变化不触发新通知；轮播不算开播。

接口失败不会伪造下播。短直播、时段外直播、睡眠期间直播可能错过；缺少稳定
场次标识时无法区分未被观察到的短暂下播重开。成功发送以 HTTP 和飞书业务返回
共同判定；响应丢失仍可能导致重复，无法承诺严格恰好一次。30 分钟 TTL 后不补发。
窗口外停止检测，但已排队消息仍可重试至过期。

## 测试与真实验收

填写飞书凭证后可显式执行 `PATH="$PWD/.runtime/node_modules/node/bin:$PATH" npm run test:live`，它会真实发一条验收消息；普通测试不会发送。

```sh
# 项目自己的 Node/npm 路径
PATH="$PWD/.runtime/node_modules/node/bin:$PATH" npm test
```

测试包含星期/时间边界、状态响应变化、场次去重、无时间戳与后补时间戳、TTL、
网络错误、Webhook 签名、私聊凭证缓存和刷新、官方签名和场次清理、认证拒绝与
协议坏包、锁互斥、切换顺序/回滚，以及完整工作进程的跨重启去重。

真实验收顺序：
1. `probe` 验证目标接口；`test-notification` 验证选中的飞书方式及手机提醒。
2. 在检测时段持续运行，观察真实开播消息和事件日志，记录实际延迟。
3. 配好云资源后做本机→云端→本机切换，检查两端只有一个运行实例。
4. 有官方授权时做认证、心跳、下播清理和跨两场开播测试。

健康轮询约一个周期发现开播，随后才是飞书和手机推送；不保证固定秒级送达。
默认时段约 1,440 次查询/周/房间，不把「通常每周两次直播」当通知次数上限。

## 仓库边界

本仓库只管理 Node.js + TypeScript 实现，有独立 .git、package-lock.json、CI 和部署脚本。Go 与 tRPC-Go 在另外两个独立仓库；合集保留为历史快照，三个独立仓库后续各自更新。

发布见 [GitHub 发布](docs/PUBLISH.md)，拆分验证见 [验证记录](docs/VALIDATION.md)。

轮询间隔设置：[分钟级配置和重启步骤](docs/POLLING_INTERVAL.md)。

后台资源优化：[实现说明、Mac 与云端更新步骤](docs/RESOURCE_OPTIMIZATION.md)。保持每 1 分钟轮询。

开播通知成功后自动改为每 5 分钟确认直播状态，观测到下播恢复每 1 分钟；可用 `notified_live_interval_minutes` 调整。详见资源优化手册。

资源保护与复现：[响应上限、日志轮转、历史保留和等待确认节流](docs/RESOURCE_SAFETY.md)。
