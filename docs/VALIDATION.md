# 拆分后的验证记录

本仓库为独立 Node 实现。锁文件 package-lock.json、源码 vendor 与 CI 均在本仓库，不引用其他实现的目录。原始 Mac 验收历史保留在根目录 VALIDATION.md；新目录不带凭证、依赖或服务状态。

2026-10-04 拆分后重新 npm ci、npm test：34 项通过、1 项真实联网测试跳过。普通单测不真实发送消息。原来已经运行的 Node 服务仍在原目录，未安装此快照或修改当前后台进程。

```sh
./bin/setup
PATH="$PWD/.runtime/node_modules/node/bin:$PATH" npm test
```

真实消息、跨重启确认、崩溃恢复、云端 SSH 和手机提醒需按 Mac/云端手册独立验收。上传排除 node_modules、.runtime、缓存、dist、.env、var、日志和截图，保留源码、空值示例和锁文件。

## 2026-10-08 分钟级轮询更新

默认 interval_minutes: 1，旧秒配置仍支持且单位互斥。新增分钟转换、非法配置与长间隔退避测试；新增真实 worker 调度测试。当前 36 项测试通过、1 项真实联网测试跳过。 不把单元测试当作真实开播、手机提醒或云端重启的验收。详见 POLLING_INTERVAL.md。
