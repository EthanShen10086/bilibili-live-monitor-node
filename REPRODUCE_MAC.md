# Mac 从零复现与本次操作记录

本文按实际完成顺序复现。入口文档见 [README](README.md)，云端见 [CLOUD_DEPLOYMENT](CLOUD_DEPLOYMENT.md)，代码原理见 [IMPLEMENTATION](IMPLEMENTATION.md)。所有命令在项目目录执行；凭证值不出现在文档中。

## 1. 准备运行环境

资源：Mac、网络、飞书账号、能添加机器人的群。无需 B 站 Cookie 或开发者授权。

```sh
cd /你的项目目录/live-monitor
bin/setup
cp .env.example .env             # 仅新安装时执行；现有 .env 不要覆盖
chmod 600 .env
```

安装器需要已有 npm；项目自己的 Node 24.21.0 安装在 `.runtime`。SQLite 原生模块如无预编译版本，需要 Python 3 和 Xcode Command Line Tools。复现时保留 package-lock.json，安装器用 npm ci 锁定依赖。

## 2. 创建专用群及机器人

1. 在飞书官网登录，打开 `https://www.feishu.cn/messages`。
2. 左上角 `+` → New Group，填写「B站开播提醒」→ Create。本次仅包含本人，没有邀请其他联系人。
3. 本次网页版群设置 → Bots 只有说明，没有 Add Bot，因此使用官方 Mac 客户端。官方下载地址为 `https://www.feishu.cn/download`，Apple 芯片选对应版本。
4. 客户端登录同一账号，打开该群 → 右上角 `…` → Settings → Bots → Add Bot → Custom Bot。
5. 名称「B站开播提醒」，描述「监控哔哩哔哩直播间1616，发送开播提醒和连接测试消息。」→ Add。
6. 勾选 Set signature verification，取得 Webhook URL 和签名密钥 → Finish。
7. 本地编辑 `.env`，填写 `FEISHU_WEBHOOK` 和 `FEISHU_WEBHOOK_SECRET`。不要公开截图凭证页，也不要把凭证放进命令参数、Git 或聊天。

如按钮受管理员限制，先让群管理员处理。不要用飞书应用密钥代替自定义机器人的签名密钥。

## 3. 验证查询、发送与手机提醒

```sh
bin/monitor probe
bin/monitor check-config --probe
PATH="$PWD/.runtime/node_modules/node/bin:$PATH" npm test
PATH="$PWD/.runtime/node_modules/node/bin:$PATH" npm run test:live
```

期望：房间 1616 解析为真实 ID 11163068；常规测试不发送消息；test:live 会真实发「Mac 真实发送验收」。飞书接口成功、群内看到消息、手机弹出通知是三个不同结果。手机未提醒时，检查手机系统通知权限、飞书通知设置、该群免打扰，以及飞书在电脑活跃时的移动端通知策略；根据客户端实际选项调整并重新测试。不要因为群中可见就标记手机已通过。

测试通知在任意时刻可发，正式检测仍限北京时间周三/五/六/日18:00–24:00。

## 4. 安装与启用后台

```sh
bin/monitor service install --side local
bin/monitor service doctor --side local
bin/monitor service start --side local
```

首次启动看到「B站开播订阅」确认框，点击「启用」。每次电脑重启后的首次登录重新确认；同次启动再次登录或进程恢复复用确认。选择暂不启用则等待，不查询平台。弹窗未出现时，用普通终端执行 `bin/monitor confirm-start`，随后检查状态。

```sh
bin/monitor service health --side local
bin/monitor status
launchctl print gui/$(id -u)/com.bilibili.live-monitor
launchctl print-disabled gui/$(id -u)
```

健康检查通过、status_fresh=true 才能标记运行成功。时段外 outside_window 是正常等待；时段内 healthy 且 last_observation_at 更新，才说明真实检测在进行。

本次工具第一次 bootstrap 返回错误5，后续在普通用户会话复查已经 running。再遇到错误5：用普通终端运行 start-local.command，检查 plist 的程序路径是否存在、Documents 访问是否被系统阻止、服务日志；不要假定都由沙箱导致，也不要直接 sudo 启动 GUI 用户服务。

## 5. 崩溃恢复与跨重启验收

在普通终端显式运行下面的验收动作；它会先验证健康及系统服务 PID，再用 SIGKILL 终止该服务，等待新的健康进程，最多约60秒：

```sh
bin/monitor service verify-recovery --side local
```

期望 JSON：recovered=true，before_pid 与 after_pid 不同。操作期间暂停监控，宜在时段外验收。本次工具不能向实际后台 PID 发信号，故尚未实测恢复；该命令只在用户主动执行时杀进程，不在启动时自动执行。

跨电脑重启验收另选方便时间手动重启 Mac：首次登录应要求确认；拒绝时 waiting_confirmation，确认后 health 通过；同次启动再登录不重新弹框。不要为验收自动重启正在使用的电脑。

## 6. 修改、升级、停用

```sh
bin/monitor service stop --side local
# 修改 config.yaml / .env 或更新代码；代码更新后构建
PATH="$PWD/.runtime/node_modules/node/bin:$PATH" npm run build
bin/monitor check-config --probe
bin/monitor service install --side local   # 程序路径或服务模板变更后重装
bin/monitor service start --side local
bin/monitor service health --side local
```

stop 同时禁用自启动。不要移动当前已运行项目，LaunchAgent 中使用绝对路径。保留 var/state.sqlite，防止重启或升级重复通知。Mac 合盖、睡眠、关机期间无法保证检测，持续运行适合迁到云端。

## 7. 本次证据（2026-10-04 北京时间）

| 步骤 | 实际结果 | 证据 |
|---|---|---|
| 网页登录、创建群 | 完成 | ../feishu-group-created.jpg |
| 客户端创建机器人、签名配置 | 完成 | 凭证仅存 .env，权限600 |
| 真实查询与发送 | 16:04:40 发成功，群内可见 | evidence/live-mac-test.log；../feishu-live-test-passed.png |
| 后台启动确认 | 16:07:28 boot_approved | var/events.log；var/boot-approval.json |
| launchd 与健康 | running、enabled、KeepAlive，健康通过 | evidence/local-service-status.json |
| 手机提醒、下一次电脑重启、实际崩溃恢复 | 未验收 | 逐项补充真实结果，不能以模板配置代替 |

当前已有真实凭证和运行状态；不要重复创建机器人或覆盖 .env。最新自动化测试数量见 [VALIDATION](VALIDATION.md)。
