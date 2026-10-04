# 实现原理与代码入口

## 1. 主链路

`bin/monitor` 选择项目内 Node24 → `src/cli.ts` 加载 `.env` / YAML → `src/config.ts` 校验 → 后台模式检查 active 与 Mac 开机确认 → `src/service.ts` 获取实例锁、打开 SQLite、进入循环。

时间窗口由 `src/schedule.ts` 按 Asia/Shanghai 判定，星期1代表周一，起点包含/终点排除。窗口外无B站查询；已排队消息仍可重试。轮询由 `src/bilibili.ts` 调用真实房间入口，解析短号、直播状态及时间；轮播不算直播。每次请求结束再等待间隔，不重叠请求。

`src/store.ts` 以真实房间ID和开播时间优先识别场次；缺时间时用成功观察到的状态变化。事务内先记录任务，成功发送后标记，查询错误不修改上次有效状态。进程恢复后读取相同 SQLite，避免已发送场次重复。网络响应丢失仍可能重复，不承诺严格恰好一次。

`src/feishu.ts` 根据 notification.mode 选择群 Webhook 签名或应用机器人私聊；HTTP与业务码共同判定成功。私聊获取/缓存token，明确失效时刷新。凭证缺失不发送假成功。`src/http.ts` 统一超时及错误。30分钟TTL后不补发，临时失败退避，永久失败需修复后 retry-failed。

官方模式 `src/official.ts` 使用官方项目凭证签名、start/心跳/end和官方返回的连接参数；未授权不能仅凭房间链接开启。与轮询共用通知和存储，窗口外关闭连接，默认关闭；真实跨场次仍待官方资源验收。

## 2. 服务与部署

`src/deployment.ts` 生成 launchd plist / systemd 用户unit。Mac KeepAlive、RunAtLoad；Linux Restart=always、20秒恢复、用户default.target。Linux doctor 验证用户管理器、服务文件和linger，start及切到云端的预检都会检查；没有linger时在停止源端前拒绝切换，防止“SSH退出后失效”。

Mac `src/boot-approval.ts` 读取内核 kern.boottime，将本次启动确认存 var/boot-approval.json；只在启动身份变化时弹框。同次启动恢复复用确认，读取失败不猜测启动ID。云端无人值守，不调用Mac确认逻辑。

`switch` 使用 SSH BatchMode、可信known_hosts和管理锁，预检→确认两端停止→迁移 SQLite/YAML→更新active→目标启动→健康。不能确认旧实例停止时禁止新实例启动；目标失败必须先确认停掉，再迁回最新状态并恢复源端。凭证不跨主机迁移。不自动升级代码或双机抢占。

健康检查联合验证：服务管理器已加载、进程心跳新鲜、主机匹配、检测状态 healthy/outside_window、实例锁实际被占用。单看PID或plist文件都不够。启动失败、blocked、retrying不能报健康。

新增 `src/recovery.ts` / `service verify-recovery`：显式验收时确认健康进程PID与管理器PID一致，才发SIGKILL；轮询新的健康PID，60秒内成功才报告recovered。只支持选定当前运行端，不自动重启整台主机。测试不会替用户接受GUI确认，也不会绕过工具信号权限。

## 3. 配置、数据和版本

| 文件/目录 | 用途 | 部署更新时 |
|---|---|---|
| config.yaml | 房间、时段、方式、active和SSH目录 | Mac管理非敏感配置；重启生效 |
| .env | 本机凭证 | 权限600；各端分别准备，不打包 |
| package-lock.json、vendor | 固定依赖及官方连接库来源 | 随源码保留 |
| .runtime、node_modules、dist | 平台对应运行环境/依赖/构建结果 | 新平台重新setup，不从Mac复制到Linux |
| var/state.sqlite | 场次和通知队列 | 升级保留；停止后备份/迁移 |
| var/status.json、events.log | 心跳和业务事件 | 状态用于验收，日志保留排错 |
| var/boot-approval.json | Mac当前开机确认 | 不复制到云端、不当跨重启授权 |
| evidence | 此次真实及模拟测试证据 | 不包含密钥，不把历史证据当当前健康 |

## 4. 本次代码与验收更新

- 新增 Linux linger/user-manager 启动和切换预检。
- 新增跨Mac/Linux的显式崩溃恢复命令及PID一致性校验。
- Linux正常/异常进程退出都自动恢复，禁用频率锁死；人为停服务仍停用。
- 回归测试覆盖PID不一致时不杀进程、权限错误立即失败、恢复健康/超时及systemd恢复配置。
- 本机现有进程继续运行旧的已启动实例；构建更新不等于进程热更新。新增CLI命令可立即使用，后台业务代码未变；下次计划停止/启动加载最新构建。云端首次安装会使用最新模板。

常规测试使用模拟网络；真实查询/发送见test:live。cloud doctor、SIGKILL恢复、服务器重启和手机推送仍需资源实测。生产代码没有“插桩开关”伪造成功，测试注入保留用于回归；后续补的是实际资源证据。
