import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, execFileSync } from "node:child_process";
import type { Config } from "./config.js";
import { acquire, atomicJson, log } from "./runtime.js";
import { HEARTBEAT_MS, StatusWriter, WakeSignal } from "./worker-control.js";
export interface Approval {
  boot_id: string;
  decision: "approved" | "declined";
  confirmed_at: number;
}
export function parseBootIdentity(value: string): string {
  const m = value.match(/sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/);
  if (!m) throw new Error("Cannot determine macOS boot identity");
  return `${m[1]}:${m[2]}`;
}
export function currentBoot(): string {
  if (process.platform !== "darwin")
    throw new Error("Boot confirmation requires macOS");
  try {
    return parseBootIdentity(
      execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch {
    throw new Error(
      "Cannot read macOS kernel boot identity in this execution environment. Boot confirmation stays closed; verify it in the normal macOS user session.",
    );
  }
}

export function readApproval(root: string): Approval | undefined {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(root, "var/boot-approval.json"), "utf8"),
    );
  } catch {
    return;
  }
}
export function isApproved(a: Approval | undefined, boot: string): boolean {
  return a?.boot_id === boot && a.decision === "approved";
}
export function rememberApproval(
  root: string,
  boot: string,
  approved: boolean,
) {
  fs.mkdirSync(path.join(root, "var"), { recursive: true, mode: 0o700 });
  atomicJson(path.join(root, "var/boot-approval.json"), {
    boot_id: boot,
    decision: approved ? "approved" : "declined",
    confirmed_at: Date.now(),
  } satisfies Approval);
}
export async function awaitBootApproval(
  root: string,
  c: Config,
  getBoot = currentBoot,
): Promise<boolean> {
  const boot = getBoot();
  if (isApproved(readApproval(root), boot)) return true;
  const release = await acquire(root, "boot-confirmation");
  let running = true;
  const wake = new WakeSignal();
  const writer = new StatusWriter(path.join(root, "var/status.json"));
  let dialog: ReturnType<typeof execFile> | undefined;
  const stop = () => {
    running = false;
    wake.signal();
    dialog?.kill("SIGTERM");
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const report = (state: string) =>
    writer.report({
      pid: process.pid,
      host: os.hostname(),
      running,
      updated_at: Date.now(),
      mode: c.detector.mode,
      notification: c.notification.mode,
      detector_state: state,
      approval_state: "waiting_confirmation",
    });
  try {
    if (isApproved(readApproval(root), boot)) return true;
    report("waiting_confirmation");
    // A decline (or GUI failure) is remembered for this boot to prevent repeated prompts.
    if (readApproval(root)?.boot_id !== boot) {
      const heartbeat = setInterval(() => report("waiting_confirmation"), HEARTBEAT_MS);
      let approved: boolean;
      try { approved = await new Promise<boolean>((resolve) => {
        const script =
          'return button returned of (display dialog "是否启用本次电脑启动期间的 B 站开播订阅？\\n确认后同次启动期间登录自启动、崩溃自恢复；下次电脑重启重新确认。" with title "B 站开播订阅" buttons {"暂不启用", "启用"} default button "暂不启用")';
        dialog = execFile(
          "/usr/bin/osascript",
          ["-e", script],
          { timeout: 120000 },
          (error, stdout) => resolve(!error && stdout.trim() === "启用"),
        );
      }); } finally { clearInterval(heartbeat); }
      if (running && !isApproved(readApproval(root), boot)) {
        rememberApproval(root, boot, approved);
        log(approved ? "boot_approved" : "boot_waiting_confirmation");
      }
    }
    while (running) {
      if (isApproved(readApproval(root), boot)) return true;
      report("waiting_confirmation");
      await wake.wait(HEARTBEAT_MS);
    }
    report("stopped");
    return false;
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await release();
  }
}
