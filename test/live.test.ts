import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readConfig, loadEnv, validateCredentials } from "../src/config.js";
import { probeRoom } from "../src/bilibili.js";
import { Feishu } from "../src/feishu.js";

// Explicit opt-in: the ordinary unit test command never sends real messages.
test(
  "live Bilibili query and a real Feishu test notification",
  {
    skip: process.env.MONITOR_LIVE_TEST !== "1",
    timeout: 30_000,
  },
  async () => {
    const root = path.resolve(import.meta.dirname, "../..");
    loadEnv(root);
    const c = readConfig(root);
    c.detector.mode = "polling"; // This tests the notification channel, not official authorization.
    validateCredentials(c);
    const snapshot = await probeRoom(
      c.subscription.room_id,
      c.detector.polling.timeout_seconds * 1000,
    );
    assert.ok(snapshot.roomId > 0);
    const text = `[B站订阅] Mac 真实发送验收\n通知渠道：${c.notification.mode}\n房间：${c.subscription.room_id}（真实 ID ${snapshot.roomId}）\n状态：${snapshot.live ? "正在直播" : "未开播"}\n时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}\nhttps://live.bilibili.com/${c.subscription.room_id}\n请确认已看到此消息及手机提醒。`;
    await new Feishu(c).send(text, "live-test:" + randomUUID());
    console.log(
      "Feishu API accepted the test notification. Recipient must verify chat visibility and phone notification separately.",
    );
  },
);
