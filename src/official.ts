import { createHash, createHmac, randomUUID } from "node:crypto";
import { LiveWS } from "bilibili-live-ws";
import { z } from "zod";
import { secret, type Config } from "./config.js";
import { jsonRequest, RemoteError, type Fetch } from "./http.js";
import { sleep } from "./runtime.js";
import { normalizeStart, type Observation } from "./bilibili.js";
export function officialHeaders(
  body: string,
  id: string,
  key: string,
  now = Math.floor(Date.now() / 1000),
  nonce = randomUUID() as string,
): Record<string, string> {
  const h: Record<string, string> = {
    "x-bili-accesskeyid": id,
    "x-bili-content-md5": createHash("md5").update(body).digest("hex"),
    "x-bili-signature-method": "HMAC-SHA256",
    "x-bili-signature-nonce": nonce,
    "x-bili-signature-version": "1.0",
    "x-bili-timestamp": String(now),
  };
  const canonical = Object.keys(h)
    .sort()
    .map((k) => `${k}:${h[k]}`)
    .join("\n");
  return {
    ...h,
    Authorization: createHmac("sha256", key).update(canonical).digest("hex"),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}
const sessionSchema = z.object({
  game_info: z.object({ game_id: z.string().min(1) }),
  anchor_info: z.object({ room_id: z.number().int().positive() }),
  websocket_info: z.object({
    auth_body: z.string().min(1),
    wss_link: z.array(z.string().url().startsWith("wss://")).min(1),
  }),
});
export function officialObservation(
  message: any,
  roomId: number,
  now = Date.now(),
): Observation | undefined {
  if (
    !["LIVE_OPEN_PLATFORM_LIVE_START", "LIVE_OPEN_PLATFORM_LIVE_END"].includes(
      message?.cmd,
    )
  )
    return;
  const data = message.data;
  if (!data || Number(data.room_id) !== roomId)
    throw new RemoteError("Official", "wrong_event_room", false);
  const live = message.cmd === "LIVE_OPEN_PLATFORM_LIVE_START";
  const startTime = live
    ? normalizeStart(data.timestamp ?? data.live_start_time)
    : undefined;
  if (live && typeof data.title !== "string")
    throw new RemoteError("Official", "event_schema", true);
  return {
    roomId,
    live,
    title: data.title ?? "",
    startTime,
    detectedAt: now,
    eventId: typeof data.msg_id === "string" ? data.msg_id : undefined,
  };
}
export class Official {
  private gameId?: string;
  private ws?: Pick<LiveWS, "on" | "close" | "removeAllListeners">;
  private lastHeartbeat = 0;
  private lastGameHeartbeat = 0;
  connected = false;
  error?: RemoteError;
  constructor(
    private c: Config,
    private roomId: number,
    private onObservation: (o: Observation) => void,
    private transport: Fetch = fetch,
    private socketFactory: (
      info: ConstructorParameters<typeof LiveWS>[0],
    ) => Pick<LiveWS, "on" | "close" | "removeAllListeners"> = (info) =>
      new LiveWS(info),
  ) {}
  private async api(route: string, payload: object) {
    const c = this.c.detector.official;
    const body = JSON.stringify(payload);
    const r = await jsonRequest(
      `https://live-open.biliapi.com/v2/app/${route}`,
      {
        method: "POST",
        headers: officialHeaders(
          body,
          secret(c.access_key_id_env),
          secret(c.access_key_secret_env),
        ),
        body,
      },
      10000,
      this.transport,
    );
    if (r?.code !== 0)
      throw new RemoteError(
        "Official",
        r?.code ?? "invalid_response",
        ![4001, 4002, 4003, 4004, 4005, 4006, 7001, 7002, 7003].includes(
          r?.code,
        ),
      );
    return r.data;
  }
  async start() {
    this.error = undefined;
    const appId = Number(secret(this.c.detector.official.app_id_env));
    const raw = await this.api("start", {
      app_id: appId,
      code: secret(this.c.detector.official.anchor_code_env),
    });
    // Retain game_id before validation so a partially valid session can still be ended.
    if (typeof raw?.game_info?.game_id === "string")
      this.gameId = raw.game_info.game_id;
    const r = sessionSchema.safeParse(raw);
    if (!r.success) throw new RemoteError("Official", "session_schema", false);
    if (r.data.anchor_info.room_id !== this.roomId)
      throw new RemoteError("Official", "authorized_room_mismatch", false);
    this.lastGameHeartbeat = Date.now();
    this.lastHeartbeat = Date.now();
    const ws = (this.ws = this.socketFactory(r.data.websocket_info));
    ws.on("live", () => {
      this.connected = true;
      this.lastHeartbeat = Date.now();
    });
    ws.on("heartbeat", () => {
      this.lastHeartbeat = Date.now();
    });
    ws.on("msg", (m: any) => {
      try {
        if (m?.cmd === "LIVE_OPEN_PLATFORM_INTERACTION_END") {
          this.error = new RemoteError("Official", "session_ended");
          this.onWake?.();
          return;
        }
        const o = officialObservation(m, this.roomId);
        if (o) this.onObservation(o);
      } catch (e) {
        this.error =
          e instanceof RemoteError
            ? e
            : new RemoteError("Official", "event_processing");
        this.onWake?.();
      }
    });
    ws.on("error", () => {
      this.connected = false;
      this.error = new RemoteError("Official", "socket_error");
      this.onWake?.();
    });
    ws.on("close", () => {
      this.connected = false;
      this.error ??= new RemoteError("Official", "socket_closed");
      this.onWake?.();
    });
  }
  async waitReady(timeout = 12000) {
    const until = Date.now() + timeout;
    while (!this.connected && Date.now() < until) {
      if (this.error) throw this.error;
      await sleep(100);
    }
    if (!this.connected)
      throw new RemoteError("Official", "authentication_timeout");
  }
  onWake?: () => void;
  get nextTickAt() { return Math.min(this.lastGameHeartbeat + 20_000, this.lastHeartbeat + 45_001); }
  async tick() {
    if (this.error) throw this.error;
    if (Date.now() - this.lastHeartbeat > 45000)
      throw new RemoteError("Official", "heartbeat_timeout");
    if (this.gameId && Date.now() - this.lastGameHeartbeat >= 20000) {
      await this.api("heartbeat", { game_id: this.gameId });
      this.lastGameHeartbeat = Date.now();
    }
  }
  async stop() {
    this.connected = false;
    const ws = this.ws;
    this.ws = undefined;
    ws?.removeAllListeners("close");
    ws?.close();
    if (this.gameId) {
      const id = this.gameId;
      await this.api("end", {
        app_id: Number(secret(this.c.detector.official.app_id_env)),
        game_id: id,
      });
      this.gameId = undefined;
    }
  }
}
