#!/usr/bin/env node
import {
  awaitBootApproval,
  currentBoot,
  rememberApproval,
} from "./boot-approval.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { parse, stringify } from "yaml";
import {
  readConfig,
  loadEnv,
  validateCredentials,
  type Config,
} from "./config.js";
import { probeRoom } from "./bilibili.js";
import { Feishu } from "./feishu.js";
import { runService } from "./service.js";
import { acquire, readStatus, configureLogs, log } from "./runtime.js";
import {
  remote,
  deploySwitch,
  serviceControl,
  serviceDoctor,
  recoveryTest,
  setActive,
  importState,
  confirmStopped,
  type Side,
} from "./deployment.js";
import { Official } from "./official.js";
import { Store } from "./store.js";
const args = process.argv.slice(2);
function option(name: string) {
  const i = args.indexOf(name);
  if (i < 0) return;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`Missing value for ${name}`);
  args.splice(i, 2);
  return v;
}
const root = path.resolve(
  option("--root") ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."),
);
const sideOption = option("--side");
const managed = option("--managed");
const probe = args.includes("--probe");
const cmd = args[0] ?? "help";
if (managed) configureLogs(root);
function side(v: string | undefined): Side {
  if (v !== "local" && v !== "cloud")
    throw new Error("Expected local or cloud");
  return v;
}
function input() {
  return fs.readFileSync(0, "utf8");
}
async function withStopped(fn: () => void) {
  await confirmStopped(root);
  const release = await acquire(root);
  try {
    fn();
  } finally {
    await release();
  }
}
function parseImported(text: string): Config {
  // Validate without altering tracked/current config.
  const temporary = fs.mkdtempSync(path.join(root, "var/import-check-"));
  try {
    fs.writeFileSync(path.join(temporary, "config.yaml"), text);
    return readConfig(temporary);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
async function main() {
  if (cmd === "help") {
    console.log(
      `monitor check-config [--probe]\nmonitor probe\nmonitor run\nmonitor status\nmonitor retry-failed\nmonitor confirm-start\nmonitor test-notification\nmonitor service install|start|stop|health|doctor|verify-recovery --side local|cloud\nmonitor switch local|cloud\nmonitor set-active local|cloud (initial setup only)`,
    );
    return;
  }
  if (Number(process.versions.node.split(".")[0]) !== 24)
    throw new Error(
      "Use Node.js 24 LTS; set MONITOR_NODE to its absolute executable path",
    );
  loadEnv(root);
  fs.mkdirSync(path.join(root, "var"), { recursive: true, mode: 0o700 });
  const c = readConfig(root);
  if (cmd === "probe") {
    console.log(
      JSON.stringify(
        await probeRoom(
          c.subscription.room_id,
          c.detector.polling.timeout_seconds * 1000,
        ),
        null,
        2,
      ),
    );
    return;
  }
  if (cmd === "check-config") {
    validateCredentials(c);
    if (probe) {
      const snapshot = await probeRoom(
        c.subscription.room_id,
        c.detector.polling.timeout_seconds * 1000,
      );
      if (args.includes("--official-auth") && c.detector.mode === "official") {
        await confirmStopped(root);
        const o = new Official(c, snapshot.roomId, () => {});
        try {
          await o.start();
          await o.waitReady();
        } finally {
          await o.stop();
        }
      }
    }
    console.log(
      JSON.stringify({
        valid: true,
        detector: c.detector.mode,
        notification: c.notification.mode,
        network_probe: probe,
      }),
    );
    return;
  }
  if (cmd === "run") {
    if (
      side(managed ?? (process.platform === "darwin" ? "local" : "cloud")) !==
      c.deployment.active
    )
      throw new Error("Managed instance disabled by deployment.active");
    if (managed === "local" && c.deployment.local.confirm_each_boot) {
      validateCredentials(c);
      if (!(await awaitBootApproval(root, c))) return;
    }
    await runService(root, c);
    return;
  }
  if (cmd === "confirm-start") {
    validateCredentials(c);
    rememberApproval(root, currentBoot(), true);
    console.log(
      "Confirmed for this Mac boot. A waiting managed service will now resume; otherwise run service start --side local.",
    );
    return;
  }
  if (cmd === "status") {
    const s = readStatus(root);
    let cloud: unknown;
    if (c.deployment.active === "cloud" && !args.includes("--local-only")) {
      try {
        cloud = JSON.parse(remote(c, ["status", "--local-only"]));
      } catch {
        cloud = { error: "Cloud status unavailable; verify SSH connectivity" };
      }
    }
    console.log(
      JSON.stringify(
        {
          configured_active: c.deployment.active,
          local_status: s ?? null,
          status_fresh: !!s && s.running && Date.now() - s.updated_at < 20000,
          cloud_status: cloud,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (cmd === "retry-failed") {
    validateCredentials(c);
    const release = await acquire(root, "management");
    try {
      const db = new Store(path.join(root, "var/state.sqlite"));
      try {
        console.log(JSON.stringify({ requeued: db.retryFailed() }));
      } finally {
        db.close();
      }
    } finally {
      await release();
    }
    return;
  }
  if (cmd === "test-notification") {
    validateCredentials(c);
    await new Feishu(c).send(
      "[B站订阅] 通知测试成功。https://live.bilibili.com/" +
        c.subscription.room_id,
      "test:" + randomUUID(),
    );
    console.log(
      "Notification accepted by Feishu; verify the chat and phone notification.",
    );
    return;
  }
  if (cmd === "service") {
    const action = args[1];
    if (action === "doctor") {
      validateCredentials(c);
      console.log(JSON.stringify(serviceDoctor(side(sideOption))));
      return;
    }
    if (action === "verify-recovery") {
      if (side(sideOption) !== c.deployment.active)
        throw new Error("Selected side differs from deployment.active");
      console.log(JSON.stringify(await recoveryTest(root, side(sideOption))));
      return;
    }
    if (
      !["install", "start", "stop", "health", "assert-stopped"].includes(action)
    )
      throw new Error("Unknown service action");
    if (action === "start") {
      validateCredentials(c);
      if (side(sideOption) !== c.deployment.active)
        throw new Error("Selected side differs from deployment.active");
    }
    await serviceControl(root, side(sideOption), action as any);
    console.log(`Service ${action} completed`);
    return;
  }
  if (cmd === "switch") {
    await deploySwitch(root, c, side(args[1]));
    console.log(`Active deployment: ${args[1]}`);
    return;
  }
  if (cmd === "set-active") {
    await withStopped(() => setActive(root, side(args[1])));
    return;
  }
  if (cmd === "state-export") {
    await withStopped(() => {
      const db = new Store(path.join(root, "var/state.sqlite"));
      db.close();
      console.log(
        fs.readFileSync(path.join(root, "var/state.sqlite")).toString("base64"),
      );
    });
    return;
  }
  if (cmd === "state-import") {
    const b = input();
    await withStopped(() => importState(root, b));
    return;
  }
  if (cmd === "check-import-config") {
    const imported = parseImported(input());
    validateCredentials(imported);
    if (probe)
      await probeRoom(
        imported.subscription.room_id,
        imported.detector.polling.timeout_seconds * 1000,
      );
    console.log("Incoming config valid for this host");
    return;
  }
  if (cmd === "config-import") {
    const text = input();
    const imported = parseImported(text);
    validateCredentials(imported);
    await withStopped(() => {
      fs.writeFileSync(
        path.join(root, "config.yaml.incoming"),
        stringify(imported),
        { mode: 0o600 },
      );
      fs.renameSync(
        path.join(root, "config.yaml.incoming"),
        path.join(root, "config.yaml"),
      );
    });
    return;
  }
  throw new Error("Unknown command; run monitor help");
}
main().catch((e) => {
  const message = e instanceof Error ? e.message : "Operation failed";
  if (managed) log("fatal_error", { message });
  else console.error(message);
  process.exitCode = 1;
});
