> 以下含原始 Mac 部署的历史验收记录。evidence 日志、凭证与运行状态不随公开仓库分发；新 clone 不等于已经部署。新仓库本轮验证见 docs/VALIDATION.md。

# 验证边界

实施日期：2026-10-04（Asia/Shanghai）。

| 项目 | 当前结果 | 证据性质 |
|---|---|---|
| 房间 1616 公开状态入口 | 成功，真实 ID 11163068，未开播 | 真实 HTTPS 查询；完整 CLI probe |
| Node 24、本地构建 | 通过 | 实际运行与 TypeScript 编译 |
| 自动化回归 | 当前 34 项通过，1 项真实发送测试跳过 | 本地测试，含 SQLite、锁、完整工作进程及崩溃恢复验收控制逻辑 |
| B站查询 → 飞书群测试消息 | 真实测试通过，客户端群内可见 | `evidence/live-mac-test.log`；尚无真实开播事件验收 |
| 私聊、token 缓存与刷新 | 通过 | 模拟飞书 API，未真实私聊 |
| 官方认证、场次心跳与结束 | 通过 | 模拟 API/连接，未取得目标授权 |
| WebSocket 认证失败及坏包 | 通过 | 实际协议解码器，测试包 |
| 部署切换与失败回滚 | 通过 | 模拟控制操作，未真实 SSH 切换 |
| LaunchAgent/systemd 模板 | Mac 已安装、加载并运行，健康检查通过 | `launchctl print`、`monitor service health`；Linux 未实际安装 |
| 手机弹窗、真实开播延迟 | 未验证 | 需要飞书资源和真实开播 |

飞书群机器人已创建，签名校验已开启，凭证只保存于权限 600 的本地 `.env`。Mac 后台监控已启动并通过健康检查，手机提醒等待用户确认；云服务器和官方授权仍未提供。
具体资源准备和后续执行顺序见 `RESOURCE_SETUP.md`。

源码包在独立新目录完成 `npm ci`、构建与 23 项测试；构建缓存重定向到项目工作目录。
测试输出见 [portable-test.log](evidence/portable-test.log)，真实房间查询快照见 [bilibili-probe.json](evidence/bilibili-probe.json)。


## Mac 本地启用增量（历史，资源接入前）

- 新增工作进程测试：时段外无网络请求、通知短暂失败后重试并只记录一次成功。
- 新增凭证文件权限/环境变量优先级测试，以及启动确认的同次启动复用、跨启动失效、状态文件权限测试。
- 增量测试：29 项通过，1 项真实发送测试因未显式启用而跳过；输出见 `evidence/local-mac-test.log`。
- `test:live` 已实际执行通过：2026-10-04 16:04:40 北京时间向「B站开播提醒」群发送验收消息，客户端界面已确认可见。手机提醒等待用户确认。
- LaunchAgent 预览由 macOS `plutil` 校验通过；实际确认脚本由 `osacompile` 编译通过，没有弹出确认框或安装服务。
- 本会话沙箱拒绝读取 `kern.boottime`；内核启动标识的真实读取、登录弹窗、每次电脑重启确认和崩溃恢复仍须在普通 macOS 用户后台会话中实测。
- `.env` 已填写真实群 Webhook 与签名密钥，权限 600；Mac LaunchAgent 已安装，尚未启动。实际 plist 已通过 `plutil -lint`。
- 本次尝试 `launchctl bootstrap gui/501 ...` 返回错误 5（Input/output error），随后 `launchctl print` 确认服务未加载，`monitor status` 尚无运行状态。不能把安装视为启动成功；准备 `start-local.command` 供普通 Mac 用户终端执行。是否为工具沙箱限制仍未获得普通终端的对比证据。

## Mac 实际后台复查

- 2026-10-04 16:07:28（北京时间）记录 `boot_approved`；本次启动确认文件为 approved，正常用户进程成功读取了内核启动标识。
- 复查 `launchctl print gui/501/com.bilibili.live-monitor`：running，PID 21674，父进程为 launchd（PID 1），keepalive 和 runatload 已设置。`launchctl print-disabled` 显示 enabled。
- `bin/monitor service health --side local` 实测通过。状态心跳新鲜，检测器为 outside_window，待发送队列为空；当天为周日，18:00 前正确等待。状态证据保存于 `evidence/local-service-status.json`。
- 尝试对该 PID 发送 SIGKILL 验证崩溃恢复，当前工具环境返回 operation not permitted，未能终止进程。崩溃自动恢复仍仅确认配置，未完成实际验收；也未重启电脑测试下一次开机确认。服务继续正常运行。

## 云端部署与复现文档增量

- 新增云端启动/切换前 service doctor，检查用户systemd可达、unit已安装及linger=yes；云端缺linger时在停止本机前拒绝切换。
- Linux模板更新为 Restart=always、RestartSec=20、StartLimitIntervalSec=0；须在实际云端重新service install才更新unit。
- 新增双端 `service verify-recovery`：健康与管理器PID匹配后显式SIGKILL，等待新的健康PID。5项新增回归验证通过，普通测试总计34通过/1跳过；未执行真实云端SIGKILL或主机重启。
- Mac service doctor 和 service health 在本次构建后实测通过；没有中断当前订阅进程。
- 新增 REPRODUCE_MAC.md、CLOUD_DEPLOYMENT.md、IMPLEMENTATION.md。真实云端资源缺失，所有服务器/SSH/开机/手机验收记录保持待填。
