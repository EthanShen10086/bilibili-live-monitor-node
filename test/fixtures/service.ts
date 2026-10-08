import { runService } from "../../src/service.js";
import { readConfig } from "../../src/config.js";
const root = process.argv[2];
const mode = process.argv[3];
const c = readConfig(root);
c.schedule = {
  timezone: "Asia/Shanghai",
  weekdays: [1, 2, 3, 4, 5, 6, 7],
  start: "00:00",
  end: "24:00",
};
if (mode === "outside") c.schedule.weekdays = [];
let sends = 0;
if (mode === "minute") {
  let elapsed = 0;
  const realNow = Date.now.bind(Date);
  Date.now = () => realNow() + elapsed;
  setTimeout(() => { elapsed = 50_000; console.log("CLOCK_BEFORE_INTERVAL"); }, 1100);
  setTimeout(() => { elapsed = 60_000; console.log("CLOCK_AFTER_INTERVAL"); }, 3100);
}
let polls = 0;
process.env.FEISHU_WEBHOOK =
  "https://open.feishu.cn/open-apis/bot/v2/hook/fake";
process.env.FEISHU_WEBHOOK_SECRET = "fake";
globalThis.fetch = (async (url: any) => {
  if (mode === "outside") {
    console.log("UNEXPECTED_NETWORK_CALL");
    throw new Error("Network forbidden outside window");
  }
  if (String(url).includes("api.live.bilibili.com")) {
    if (mode === "minute") console.log("POLL_COUNT " + ++polls);
    if (mode === "error") return new Response(JSON.stringify({ code: -412 }));
    return new Response(
      JSON.stringify({
        code: 0,
        data: {
          room_id: 11163068,
          short_id: 1616,
          live_status: mode === "offline" ? 0 : 1,
          title: "集成测试",
          live_time:
            mode === "next" ? "2026-10-04 21:00:00" : "2026-10-04 20:00:00",
        },
      }),
    );
  }
  sends++;
  if (mode === "retry" && sends === 1)
    return new Response("retry", { status: 503 });
  return new Response(JSON.stringify({ code: 0 }));
}) as typeof fetch;
await runService(root, c);
