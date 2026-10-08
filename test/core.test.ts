import { QueueSchedule, StatusWriter, WakeSignal } from "../src/worker-control.js";
import {
  isApproved,
  rememberApproval,
  readApproval,
  parseBootIdentity,
} from "../src/boot-approval.js";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readConfig, validateCredentials, loadEnv, pollingIntervalMs } from "../src/config.js";
import { inWindow, backoff } from "../src/schedule.js";
import { probeRoom, parseRoom, normalizeStart } from "../src/bilibili.js";
import { Store } from "../src/store.js";
import { Feishu, feishuSign } from "../src/feishu.js";
import { RemoteError, jsonRequest, type Fetch } from "../src/http.js";
import {
  officialHeaders,
  officialObservation,
  Official,
} from "../src/official.js";
import {
  switchInstance,
  quote,
  serviceFiles,
  type Side,
  type SwitchOps,
} from "../src/deployment.js";
import { acquire } from "../src/runtime.js";
const root = path.resolve(import.meta.dirname, "../..");
const config = () => structuredClone(readConfig(root));
const room = (
  live = true,
  startTime: string | undefined | null = "2026-10-04T12:00:00.000Z",
  at = 1000,
) => ({
  roomId: 11163068,
  live,
  title: "测试直播",
  startTime: startTime ?? undefined,
  detectedAt: at,
});
function database(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-monitor-test-"));
  const db = new Store(path.join(dir, "state.sqlite"));
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("schedule honors Beijing weekdays and inclusive start/exclusive end", () => {
  const s = config().schedule;
  for (const d of ["2026-09-30", "2026-10-02", "2026-10-03", "2026-10-04"]) {
    assert.equal(inWindow(s, new Date(d + "T09:59:59Z")), false);
    assert.equal(inWindow(s, new Date(d + "T10:00:00Z")), true);
    assert.equal(inWindow(s, new Date(d + "T15:59:59Z")), true);
    assert.equal(inWindow(s, new Date(d + "T16:00:00Z")), false);
  }
  assert.equal(inWindow(s, new Date("2026-10-01T12:00:00Z")), false);
});
test("backoff grows and caps without resetting valid room state", () => {
  assert.equal(backoff(1), 10000);
  assert.equal(backoff(2), 20000);
  assert.equal(backoff(20), 300000);
});
test("Bilibili resolves short ID and excludes rotation", () => {
  const base = {
    code: 0,
    data: {
      room_id: 11163068,
      short_id: 1616,
      live_status: 2,
      title: "轮播",
      live_time: "0000-00-00 00:00:00",
    },
  };
  assert.equal(parseRoom(base, 1616).live, false);
  assert.equal(parseRoom(base, 1616).startTime, undefined);
  assert.throws(() => parseRoom({ ...base, code: -412 }, 1616));
  assert.throws(() => parseRoom(base, 999));
  assert.throws(() =>
    parseRoom({ code: 0, data: { ...base.data, live_status: 3 } }, 1616),
  );
  assert.equal(
    normalizeStart("2026-10-04 20:00:00"),
    "2026-10-04T12:00:00.000Z",
  );
});
test("persistent dedupe across title changes and subsequent sessions", (t) => {
  const db = database(t);
  assert.equal(db.observe(room(), true, 30), true);
  const j = db.due(1000)!;
  assert.equal(JSON.parse(j.payload).catchup, true);
  db.sent(j.key);
  assert.equal(db.observe({ ...room(), title: "新标题" }, false, 30), false);
  assert.equal(db.observe(room(false), false, 30), false);
  assert.equal(
    db.observe(room(true, "2026-10-04T13:00:00.000Z"), false, 30),
    true,
  );
  assert.equal(db.due(1000)?.key, "11163068:start:2026-10-04T13:00:00.000Z");
});
test("missing timestamp, late timestamp, and failed probes do not duplicate", (t) => {
  const db = database(t);
  assert.equal(db.observe(room(true, null), true, 30), true);
  assert.equal(db.observe(room(true, null), true, 30), false);
  assert.equal(db.observe(room(), false, 30), false);
  assert.equal(db.observe(room(), false, 30), false);
  assert.throws(() => parseRoom({ code: -412 }, 1616));
  assert.equal(db.observe(room(), true, 30), false);
  db.observe(room(false, null), false, 30);
  assert.equal(db.observe(room(true, null), false, 30), true);
});
test("TTL, backoff and permanent failure are persisted", (t) => {
  const db = database(t);
  db.observe(room(), false, 1);
  const job = db.due(1000)!;
  db.failed(job, "HTTP failed", true, 1000);
  assert.equal(db.due(5999), undefined);
  assert.equal(db.due(6000)?.attempts, 1);
  db.failed(db.due(6000)!, "permission_denied", false, 6000);
  assert.equal(db.due(50000), undefined);
  db.observe(room(true, "new-session", 100000), false, 1);
  assert.equal(db.due(160000), undefined);
  assert.deepEqual(db.counts(), [
    { status: "expired", count: 1 },
    { status: "failed", count: 1 },
  ]);
});
test("only selected notification and detector credentials are required", () => {
  const c = config();
  process.env.FEISHU_WEBHOOK =
    "https://open.feishu.cn/open-apis/bot/v2/hook/unit-test";
  process.env.FEISHU_WEBHOOK_SECRET = "unit-test";
  validateCredentials(c);
  c.detector.mode = "official";
  assert.throws(() => validateCredentials(c), /BILI_APP_ID/);
});
test("network and invalid JSON errors are sanitized and 429 is retryable", async () => {
  const transport = (async () =>
    new Response("secret-token in body", { status: 429 })) as Fetch;
  await assert.rejects(
    jsonRequest("https://example.com", {}, 1000, transport),
    (e: any) =>
      e instanceof RemoteError &&
      e.retryable &&
      !e.message.includes("secret-token"),
  );
  await assert.rejects(
    jsonRequest(
      "https://example.com",
      {},
      1000,
      (async () => new Response("<html>")) as Fetch,
    ),
    /invalid_json/,
  );
});
test("Feishu webhook sends a signed payload and checks business errors", async () => {
  const c = config();
  process.env.FEISHU_WEBHOOK =
    "https://open.feishu.cn/open-apis/bot/v2/hook/test";
  process.env.FEISHU_WEBHOOK_SECRET = "unit-test";
  let payload: any;
  const transport = (async (_url: any, init: any) => {
    payload = JSON.parse(init.body);
    return response({ code: 0 });
  }) as Fetch;
  await new Feishu(c, transport).send("消息", "key");
  assert.equal(payload.msg_type, "text");
  assert.equal(payload.content.text, "消息");
  assert.equal(payload.sign, feishuSign(payload.timestamp, "unit-test"));
  await assert.rejects(
    new Feishu(c, (async () => response({ code: 19021 })) as Fetch).send(
      "消息",
      "key",
    ),
    (e: any) => e instanceof RemoteError && !e.retryable,
  );
});
test("private notifications cache tokens, use stable UUID, and refresh expired token", async () => {
  const c = config();
  c.notification.mode = "feishu_private";
  process.env.FEISHU_APP_ID = "test-app";
  process.env.FEISHU_APP_SECRET = "test-secret";
  process.env.FEISHU_RECEIVE_ID = "ou_test";
  let tokens = 0,
    messages = 0;
  const uuids: string[] = [];
  const transport = (async (url: any, init: any) => {
    if (String(url).includes("/auth/")) {
      tokens++;
      return response({
        code: 0,
        tenant_access_token: "redacted",
        expire: 7200,
      });
    }
    messages++;
    const body = JSON.parse(init.body);
    assert.equal(body.receive_id, "ou_test");
    assert.equal(JSON.parse(body.content).text, "提醒");
    uuids.push(body.uuid);
    return response({ code: messages === 1 ? 99991663 : 0 });
  }) as Fetch;
  const f = new Feishu(c, transport);
  await f.send("提醒", "session-1");
  await f.send("提醒", "session-1");
  assert.equal(tokens, 2);
  assert.equal(messages, 3);
  assert.equal(new Set(uuids).size, 1);
});
test("official signing and event room validation", () => {
  const h = officialHeaders("{}", "id", "key", 123, "fixed-nonce");
  assert.equal(h["x-bili-content-md5"], "99914b932bd37a50b983c5e7c90ae93b");
  assert.equal(h["x-bili-timestamp"], "123");
  assert.match(h.Authorization, /^[0-9a-f]{64}$/);
  assert.equal(
    officialObservation({ cmd: "LIVE_OPEN_PLATFORM_DM" }, 11163068),
    undefined,
  );
  assert.throws(
    () =>
      officialObservation(
        {
          cmd: "LIVE_OPEN_PLATFORM_LIVE_START",
          data: { room_id: 1, title: "bad" },
        },
        11163068,
      ),
    /wrong_event_room/,
  );
  assert.equal(
    officialObservation(
      {
        cmd: "LIVE_OPEN_PLATFORM_LIVE_START",
        data: { room_id: 11163068, title: "live", timestamp: 1791115200 },
      },
      11163068,
    )?.live,
    true,
  );
});
test("official mismatched authorization cleans up acquired session", async () => {
  const c = config();
  process.env.BILI_APP_ID = "123";
  process.env.BILI_ACCESS_KEY_ID = "key";
  process.env.BILI_ACCESS_KEY_SECRET = "secret";
  process.env.BILI_ANCHOR_CODE = "code";
  const calls: string[] = [];
  const o = new Official(c, 11163068, () => {}, (async (url: any) => {
    calls.push(String(url));
    return response({
      code: 0,
      data: String(url).endsWith("/start")
        ? {
            game_info: { game_id: "game" },
            anchor_info: { room_id: 999 },
            websocket_info: {
              auth_body: "{}",
              wss_link: ["wss://example.com"],
            },
          }
        : {},
    });
  }) as Fetch);
  await assert.rejects(o.start(), /authorized_room_mismatch/);
  await o.stop();
  assert.equal(calls.length, 2);
  assert.ok(calls[1].endsWith("/end"));
});
function switchMock(failHealth = false, failStop = false) {
  const calls: string[] = [];
  let active: Side = "local";
  let targetStarted = false;
  const ops: SwitchOps = {
    preflight: async (s) => {
      calls.push("preflight:" + s);
    },
    stop: async (s) => {
      calls.push("stop:" + s);
      if (failStop && s === "cloud" && targetStarted) throw Error("uncertain");
    },
    assertStopped: async (s) => {
      calls.push("assert:" + s);
    },
    transfer: async (a, b) => {
      calls.push(`transfer:${a}:${b}`);
    },
    setActive: async (s) => {
      active = s;
      calls.push("active:" + s);
    },
    start: async (s) => {
      calls.push("start:" + s);
      if (s === "cloud") targetStarted = true;
    },
    health: async (s) => {
      calls.push("health:" + s);
      if (s === "cloud" && failHealth) throw Error("unhealthy");
    },
  };
  return { calls, ops, active: () => active };
}
test("switch orders stop verification before migration and start", async () => {
  const m = switchMock();
  await switchInstance("local", "cloud", m.ops);
  assert.deepEqual(m.calls, [
    "preflight:cloud",
    "stop:cloud",
    "assert:cloud",
    "stop:local",
    "assert:local",
    "transfer:local:cloud",
    "active:cloud",
    "start:cloud",
    "health:cloud",
  ]);
  assert.equal(m.active(), "cloud");
});
test("switch failure carries target delivery state back before source rollback", async () => {
  const m = switchMock(true);
  await assert.rejects(
    switchInstance("local", "cloud", m.ops),
    /source restored/,
  );
  assert.ok(
    m.calls.indexOf("assert:cloud", m.calls.indexOf("start:cloud")) <
      m.calls.indexOf("start:local"),
  );
  assert.ok(
    m.calls.indexOf("transfer:cloud:local") < m.calls.indexOf("start:local"),
  );
  assert.equal(m.active(), "local");
});
test("uncertain target stop blocks rollback and second start", async () => {
  const m = switchMock(true, true);
  await assert.rejects(switchInstance("local", "cloud", m.ops), /unconfirmed/);
  assert.ok(!m.calls.includes("start:local"));
});
test("preflight failure leaves source untouched", async () => {
  const m = switchMock();
  m.ops.preflight = async () => {
    throw Error("missing credentials");
  };
  await assert.rejects(switchInstance("local", "cloud", m.ops));
  assert.equal(m.calls.length, 0);
});
test("instance and management locks exclude concurrent owners", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const release = await acquire(dir);
  await assert.rejects(acquire(dir), (e: any) => e.code === "ELOCKED");
  await release();
  const next = await acquire(dir);
  await next();
});
test("deployment templates escape paths and use managed sides", () => {
  const files = serviceFiles('/tmp/a & "b"', "/node path/node");
  assert.ok(files.plist.includes("a &amp; &quot;b&quot;"));
  assert.ok(files.unit.includes("--managed cloud"));
  assert.equal(quote("a'b"), "'a'\\''b'");
});
test("official session authenticates, heartbeats, closes, and ends via signed API", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_790_000_000_000 });
  const c = config();
  process.env.BILI_APP_ID = "123";
  process.env.BILI_ACCESS_KEY_ID = "key";
  process.env.BILI_ACCESS_KEY_SECRET = "secret";
  process.env.BILI_ANCHOR_CODE = "code";
  const calls: string[] = [];
  let socket: any;
  const seen: any[] = [];
  const o = new Official(
    c,
    11163068,
    (v) => seen.push(v),
    (async (url: any, init: any) => {
      assert.ok(init.headers.Authorization);
      calls.push(String(url));
      return response({
        code: 0,
        data: String(url).endsWith("/start")
          ? {
              game_info: { game_id: "game" },
              anchor_info: { room_id: 11163068 },
              websocket_info: {
                auth_body: '{"key":"test"}',
                wss_link: ["wss://example.com"],
              },
            }
          : {},
      });
    }) as Fetch,
    (info) => {
      assert.equal(info.auth_body, '{"key":"test"}');
      socket = new EventEmitter();
      socket.close = () => socket.emit("close");
      return socket;
    },
  );
  await o.start();
  socket.emit("live");
  await o.waitReady();
  assert.equal(o.connected, true);
  t.mock.timers.setTime(1_790_000_020_000);
  socket.emit("heartbeat");
  await o.tick();
  assert.ok(calls[1].endsWith("/heartbeat"));
  socket.emit("msg", {
    cmd: "LIVE_OPEN_PLATFORM_LIVE_START",
    data: { room_id: 11163068, title: "测试", timestamp: 1790000020 },
  });
  assert.equal(seen.length, 1);
  socket.emit("msg", { cmd: "LIVE_OPEN_PLATFORM_INTERACTION_END" });
  await assert.rejects(o.tick(), /session_ended/);
  await o.stop();
  assert.ok(calls[2].endsWith("/end"));
  assert.equal(o.connected, false);
});
test("upstream client refuses rejected authentication and malformed frames", async () => {
  const require = createRequire(import.meta.url);
  const { Live } = require(
    path.join(root, "vendor/bilibili-live-ws/src/common.js"),
  );
  const { inflates } = require(
    path.join(root, "vendor/bilibili-live-ws/src/inflate/node.js"),
  );
  for (const code of [0, -101]) {
    let welcome = false,
      error = false,
      closed = false;
    const live = new Live(inflates, {
      send: () => {},
      close: () => {
        closed = true;
      },
      authBody: "{}",
    });
    live.on("live", () => (welcome = true));
    live.on("error", () => (error = true));
    const body = Buffer.from(JSON.stringify({ code }));
    const header = Buffer.alloc(16);
    header.writeInt32BE(16 + body.length, 0);
    header.writeInt16BE(16, 4);
    header.writeInt16BE(1, 6);
    header.writeInt32BE(8, 8);
    live.emit("message", Buffer.concat([header, body]));
    await new Promise((r) => setImmediate(r));
    assert.equal(welcome, code === 0);
    assert.equal(error, code !== 0);
    if (code !== 0) assert.equal(closed, true);
    live.close();
  }
  const live = new Live(inflates, {
    send: () => {},
    close: () => {},
    authBody: "{}",
  });
  let error = false;
  live.on("error", () => (error = true));
  live.emit("message", Buffer.alloc(16));
  await new Promise((r) => setImmediate(r));
  assert.equal(error, true);
  live.close();
});
test("explicit retry only requeues unexpired permanent failures", (t) => {
  const db = database(t);
  db.observe(room(), false, 1);
  const j = db.due(1000)!;
  db.failed(j, "auth_denied", false, 1000);
  assert.equal(db.retryFailed(2000), 1);
  db.failed(db.due(2000)!, "auth_denied", false, 2000);
  assert.equal(db.retryFailed(61000), 0);
});
test("Bilibili HTTP access refusal backs off rather than inventing offline state", async () => {
  await assert.rejects(
    probeRoom(1616, 1000, (async () => response({}, 403)) as Fetch),
    (e: any) => e instanceof RemoteError && e.retryable && e.code === 403,
  );
});

test("credential file rejects broad permissions and respects existing environment values", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-env-"));
  const key = "MONITOR_UNIT_ENV_PRECEDENCE";
  t.after(() => {
    delete process.env[key];
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, key + "=from-file\n", { mode: 0o644 });
  assert.throws(() => loadEnv(dir), /chmod 600/);
  fs.chmodSync(file, 0o600);
  process.env[key] = "from-environment";
  loadEnv(dir);
  assert.equal(process.env[key], "from-environment");
});

test("boot approval survives process restart but never authorizes another boot", () => {
  const a = {
    boot_id: "100:20",
    decision: "approved" as const,
    confirmed_at: 1000,
  };
  assert.equal(isApproved(a, "100:20"), true);
  assert.equal(isApproved(a, "200:20"), false);
  assert.equal(isApproved({ ...a, decision: "declined" }, "100:20"), false);
  assert.equal(isApproved(undefined, "100:20"), false);
});
test("boot decisions persist securely and explicit confirmation replaces decline", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-boot-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  rememberApproval(dir, "100:20", false);
  assert.equal(readApproval(dir)?.decision, "declined");
  rememberApproval(dir, "100:20", true);
  assert.equal(isApproved(readApproval(dir), "100:20"), true);
  assert.equal(
    fs.statSync(path.join(dir, "var/boot-approval.json")).mode & 0o077,
    0,
  );
});
test("macOS boot identity uses both kernel seconds and microseconds", () => {
  assert.equal(
    parseBootIdentity("{ sec = 100, usec = 20 } Sun Oct 4"),
    "100:20",
  );
  assert.throws(() => parseBootIdentity("unavailable"), /Cannot determine/);
});


test("minute polling converts units, preserves legacy seconds, and rejects ambiguous configs", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-interval-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = fs.readFileSync(path.resolve(import.meta.dirname, "../../config.yaml"), "utf8");
  const writeInterval = (lines: string) => fs.writeFileSync(path.join(root, "config.yaml"), original.replace(/^    interval_minutes:.*$/m, lines));
  writeInterval("    interval_minutes: 1");
  assert.equal(pollingIntervalMs(readConfig(root).detector.polling), 60_000);
  writeInterval("    interval_minutes: 5");
  assert.equal(pollingIntervalMs(readConfig(root).detector.polling), 300_000);
  writeInterval("    interval_seconds: 10");
  assert.equal(pollingIntervalMs(readConfig(root).detector.polling), 10_000);
  for (const lines of ["", "    interval_minutes: 0", "    interval_minutes: 61", "    interval_minutes: 1.5", "    interval_minutes: 1\n    interval_seconds: 10"]) {
    writeInterval(lines);
    assert.throws(() => readConfig(root));
  }
  assert.equal(backoff(1, 60_000), 60_000);
  assert.equal(backoff(3, 60_000), 240_000);
  assert.equal(backoff(4, 60_000), 300_000);
  assert.equal(backoff(5, 600_000), 600_000, "failure cannot shorten a long interval");
});


test("idle status writes only on change or ten-second heartbeat", (t) => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"monitor-status-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let now=0;const writer=new StatusWriter(path.join(root,"status.json"),()=>now);
 const state:any={running:true,detector_state:"outside_window"};
 assert.ok(writer.report(state));
 for(let i=1;i<10;i++){now=i*1000;assert.equal(writer.report(state),false)}
 assert.equal(writer.writes,1);now=10000;assert.ok(writer.report(state));
 now=10001;state.detector_state="healthy";assert.ok(writer.report(state));
 assert.equal(writer.writes,3);state.running=false;assert.ok(writer.report(state,true));
});

test("idle queue caches scans and detects external retries through SQLite data_version", (t) => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"monitor-queue-cache-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const db=new Store(path.join(root,"state.sqlite"));const external=new Store(path.join(root,"state.sqlite"));t.after(()=>{db.close();external.close()});
 const q=new QueueSchedule(db);q.refresh(0);
 for(let i=1;i<=20;i++)q.refresh(i*1000);
 assert.equal(q.refreshes,1);assert.equal(q.nextDue,Infinity);
 external.observe({roomId:1,live:true,title:"test",startTime:"2026-10-08T10:00:00.000Z",detectedAt:21000},false,1);
 q.refresh(30000);assert.equal(q.refreshes,2);assert.equal(q.nextDue,21000);
 const job=db.due(30000)!;db.failed(job,"fixed",false,30000);q.dirty=true;q.refresh(30000);assert.equal(q.nextDue,Infinity);
 external.retryFailed(31000);q.refresh(40000);assert.equal(q.nextDue,31000);
 db.db.prepare("UPDATE jobs SET next=200000 WHERE status='pending'").run();q.dirty=true;q.refresh(40001);assert.equal(q.nextDue,81000,"TTL wakes before retry deadline");
});

test("unchanged observations do not rewrite SQLite rows", (t) => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"monitor-stable-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const db=new Store(path.join(root,"state.sqlite"));const observer=new Store(path.join(root,"state.sqlite"));t.after(()=>{db.close();observer.close()});
 const o={roomId:1,live:true,title:"test",startTime:"2026-10-08T10:00:00.000Z",detectedAt:1000};db.observe(o,false,30);
 const version=observer.dataVersion();assert.equal(db.observe({...o,title:"new",detectedAt:2000},false,30),false);assert.equal(observer.dataVersion(),version);
});

test("wake signal interrupts long idle wait and retains a signal before wait", async () => {
 const wake=new WakeSignal();wake.signal();await wake.wait(60000);
 const started=Date.now();const waiting=wake.wait(60000);setTimeout(()=>wake.signal(),10);await waiting;assert.ok(Date.now()-started<1000);
});
