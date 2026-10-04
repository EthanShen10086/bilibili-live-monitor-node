import { createHmac, createHash } from "node:crypto";
import { secret, type Config } from "./config.js";
import { jsonRequest, RemoteError, type Fetch } from "./http.js";
import type { Notice } from "./store.js";
export function feishuSign(timestamp: string, key: string) {
  return createHmac("sha256", `${timestamp}\n${key}`)
    .update("")
    .digest("base64");
}
function checked(body: any) {
  if (!body || body.code !== 0)
    throw new RemoteError(
      "Feishu",
      body?.code ?? "invalid_response",
      ![
        19021, 19022, 19024, 19025, 99991661, 99991663, 99991672, 230002,
        230013, 230017,
      ].includes(body?.code),
    );
  return body;
}
export function formatNotice(n: Notice, displayRoom: number) {
  const at = (s: string | number) =>
    new Date(s).toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour12: false,
    });
  return `[B站订阅] ${n.catchup ? "当前正在直播" : "开播了"}\n房间：${displayRoom}（真实 ID ${n.roomId}）\n标题：${n.title || "暂无标题"}${n.startTime ? `\n开播时间：${at(n.startTime)}` : ""}\n检测时间：${at(n.detectedAt)}\nhttps://live.bilibili.com/${displayRoom}`;
}
export class Feishu {
  private token?: { value: string; expires: number };
  constructor(
    private c: Config,
    private transport: Fetch = fetch,
  ) {}
  private async accessToken() {
    if (this.token && this.token.expires > Date.now() + 60000)
      return this.token.value;
    const c = this.c.notification.private;
    const r = checked(
      await jsonRequest(
        "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            app_id: secret(c.app_id_env),
            app_secret: secret(c.app_secret_env),
          }),
        },
        10000,
        this.transport,
      ),
    );
    if (
      typeof r.tenant_access_token !== "string" ||
      typeof r.expire !== "number"
    )
      throw new RemoteError("Feishu", "token_schema");
    this.token = {
      value: r.tenant_access_token,
      expires: Date.now() + r.expire * 1000,
    };
    return this.token.value;
  }
  async send(text: string, key: string) {
    if (this.c.notification.mode === "feishu_group") {
      const c = this.c.notification.group;
      const timestamp = String(Math.floor(Date.now() / 1000));
      checked(
        await jsonRequest(
          secret(c.webhook_env),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              timestamp,
              sign: feishuSign(timestamp, secret(c.secret_env)),
              msg_type: "text",
              content: { text },
            }),
          },
          10000,
          this.transport,
        ),
      );
    } else {
      const c = this.c.notification.private;
      const send = async () =>
        checked(
          await jsonRequest(
            `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${c.receive_id_type}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${await this.accessToken()}`,
              },
              body: JSON.stringify({
                receive_id: secret(c.receive_id_env),
                msg_type: "text",
                content: JSON.stringify({ text }),
                uuid: createHash("sha256")
                  .update(key)
                  .digest("hex")
                  .slice(0, 32),
              }),
            },
            10000,
            this.transport,
          ),
        );
      try {
        await send();
      } catch (e) {
        if (
          e instanceof RemoteError &&
          [99991661, 99991663, 99991668].includes(Number(e.code))
        ) {
          this.token = undefined;
          await send();
        } else throw e;
      }
    }
  }
}
