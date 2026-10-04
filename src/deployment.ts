import { currentBoot, readApproval, isApproved } from "./boot-approval.js";
import { verifyRecovery } from "./recovery.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { parse, stringify } from "yaml";
import type { Config } from "./config.js";
import { acquire, atomicJson, readStatus, sleep } from "./runtime.js";
export type Side = "local" | "cloud";
const label = "com.bilibili.live-monitor";
export const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const xml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
export function command(
  executable: string,
  args: string[],
  input?: string | Buffer,
): string {
  try {
    return execFileSync(executable, args, {
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    throw new Error(
      `Command failed: ${path.basename(executable)} ${args[0] ?? ""}; inspect the service/SSH logs (sensitive command output suppressed)`,
    );
  }
}
const uid = () => String(process.getuid?.() ?? "");
const userUnit = () =>
  path.join(os.homedir(), ".config/systemd/user/live-monitor.service");
const plistFile = () =>
  path.join(os.homedir(), "Library/LaunchAgents", `${label}.plist`);
function systemdEscape(s: string) {
  return (
    '"' +
    s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%") +
    '"'
  );
}
export function serviceFiles(root: string, node: string) {
  const args = [
    node,
    path.join(root, "dist/src/cli.js"),
    "--root",
    root,
    "run",
    "--managed",
    "local",
  ];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array><key>WorkingDirectory</key><string>${xml(root)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>20</integer><key>StandardOutPath</key><string>${xml(path.join(root, "var/service.log"))}</string><key>StandardErrorPath</key><string>${xml(path.join(root, "var/error.log"))}</string></dict></plist>\n`;
  const unit = `[Unit]\nDescription=Bilibili live subscription monitor\nAfter=network-online.target\nStartLimitIntervalSec=0\n\n[Service]\nType=simple\nWorkingDirectory=${systemdEscape(root)}\nExecStart=${systemdEscape(node)} ${systemdEscape(path.join(root, "dist/src/cli.js"))} --root ${systemdEscape(root)} run --managed cloud\nRestart=always\nRestartSec=20\nTimeoutStopSec=45\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
  return { plist, unit };
}
function assertPlatform(side: Side) {
  if (
    (side === "local" && process.platform !== "darwin") ||
    (side === "cloud" && process.platform !== "linux")
  )
    throw new Error(
      `Service ${side} requires ${side === "local" ? "macOS" : "Linux"}`,
    );
}
function loaded(side: Side) {
  try {
    command(
      side === "local" ? "launchctl" : "systemctl",
      side === "local"
        ? ["print", `gui/${uid()}/${label}`]
        : ["--user", "is-active", "--quiet", "live-monitor.service"],
    );
    return true;
  } catch {
    return false;
  }
}
export function serviceDoctor(side: Side) {
  assertPlatform(side);
  const installed = fs.existsSync(side === "local" ? plistFile() : userUnit());
  if (!installed) throw new Error("Service not installed; run service install first");
  if (side === "cloud") {
    command("systemctl", ["--user", "show-environment"]);
    const linger = command("loginctl", ["show-user", uid(), "--property=Linger", "--value"]).trim();
    if (linger !== "yes")
      throw new Error("Cloud reboot/SSH logout persistence requires linger: ask the administrator to run loginctl enable-linger for this service user");
    return { platform: "linux", installed, user_manager: true, linger: true };
  }
  return { platform: "darwin", installed };
}
export async function recoveryTest(root: string, side: Side) {
  const release = await acquire(root, "management");
  try {
    return await verifyRecovery({
      healthyPid: async () => {
        await serviceControl(root, side, "health");
        return readStatus(root)!.pid;
      },
      managerPid: async () => {
        if (side === "cloud")
          return Number(command("systemctl", ["--user", "show", "live-monitor.service", "--property=MainPID", "--value"]).trim());
        const output = command("launchctl", ["print", `gui/${uid()}/${label}`]);
        return Number(output.match(/^\s*pid = (\d+)\s*$/m)?.[1]);
      },
      crash: async (pid) => {
        try { process.kill(pid, "SIGKILL"); }
        catch { throw new Error("Cannot signal managed worker in this execution environment; recovery remains unverified"); }
      },
      pause: () => sleep(1000),
    });
  } finally { await release(); }
}
export async function serviceControl(
  root: string,
  side: Side,
  action: "install" | "start" | "stop" | "assert-stopped" | "health",
) {
  assertPlatform(side);
  if (action === "install") {
    fs.mkdirSync(path.join(root, "var"), { recursive: true, mode: 0o700 });
    const { plist, unit } = serviceFiles(root, process.execPath);
    const file = side === "local" ? plistFile() : userUnit();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, side === "local" ? plist : unit, { mode: 0o600 });
    if (side === "cloud") command("systemctl", ["--user", "daemon-reload"]);
    return;
  }
  if (action === "start") {
    serviceDoctor(side);
    if (side === "local") {
      if (!fs.existsSync(plistFile()))
        throw new Error("Run service install first");
      command("launchctl", ["enable", `gui/${uid()}/${label}`]);
      if (!loaded(side))
        command("launchctl", ["bootstrap", `gui/${uid()}`, plistFile()]);
      else command("launchctl", ["kickstart", `gui/${uid()}/${label}`]);
    } else
      command("systemctl", [
        "--user",
        "enable",
        "--now",
        "live-monitor.service",
      ]);
    return;
  }
  if (action === "stop") {
    if (side === "local") {
      command("launchctl", ["disable", `gui/${uid()}/${label}`]);
      if (loaded(side))
        command("launchctl", ["bootout", `gui/${uid()}/${label}`]);
    } else
      command("systemctl", [
        "--user",
        "disable",
        "--now",
        "live-monitor.service",
      ]);
    await confirmStopped(root);
    return;
  }
  if (action === "assert-stopped") {
    if (loaded(side))
      throw new Error("Service manager still reports an active service");
    await confirmStopped(root);
    return;
  }
  if (action === "health") {
    const s = readStatus(root);
    if (
      !loaded(side) ||
      !s?.running ||
      s.host !== os.hostname() ||
      Date.now() - s.updated_at > 20000 ||
      !["healthy", "outside_window"].includes(s.detector_state)
    )
      throw new Error("Managed instance is not healthy");
    const release = await tryLock(root);
    if (release) {
      await release();
      throw new Error("Status is stale: no running instance lock");
    }
  }
}
async function tryLock(root: string) {
  try {
    return await acquire(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOCKED") return;
    throw e;
  }
}
export async function confirmStopped(root: string) {
  for (let i = 0; i < 50; i++) {
    const s = readStatus(root);
    if (s?.running && s.host === os.hostname()) {
      try {
        process.kill(s.pid, 0);
        await sleep(500);
        continue;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH")
          throw new Error("Cannot prove previous process exited");
      }
    }
    const release = await tryLock(root);
    if (release) {
      await release();
      return;
    }
    await sleep(500);
  }
  throw new Error("Cannot prove old instance has stopped; refusing switch");
}
export interface SwitchOps {
  preflight(side: Side): Promise<void>;
  stop(side: Side): Promise<void>;
  assertStopped(side: Side): Promise<void>;
  transfer(from: Side, to: Side): Promise<void>;
  setActive(side: Side): Promise<void>;
  start(side: Side): Promise<void>;
  health(side: Side): Promise<void>;
}
export async function switchInstance(from: Side, to: Side, ops: SwitchOps) {
  if (from === to) {
    await ops.health(to);
    return;
  }
  await ops.preflight(to);
  await ops.stop(to);
  await ops.assertStopped(to);
  await ops.stop(from);
  await ops.assertStopped(from);
  let attemptedStart = false;
  try {
    await ops.transfer(from, to);
    await ops.setActive(to);
    attemptedStart = true;
    await ops.start(to);
    await ops.health(to);
  } catch (e) {
    // No rollback starts until the possibly-started target is proven stopped.
    try {
      await ops.stop(to);
      await ops.assertStopped(to);
    } catch {
      throw new Error(
        "Switch failed and target stop is unconfirmed. Both automatic rollback and new starts are blocked; inspect both hosts.",
      );
    }
    try {
      if (attemptedStart) await ops.transfer(to, from);
      await ops.setActive(from);
      await ops.start(from);
      await ops.health(from);
    } catch {
      throw new Error(
        "Switch failed; rollback could not restore the source. Inspect both hosts.",
      );
    }
    throw new Error("Switch failed; source restored.");
  }
}
export function setActive(root: string, side: Side) {
  const file = path.join(root, "config.yaml");
  const c = parse(fs.readFileSync(file, "utf8"));
  c.deployment.active = side;
  const tmp = file + ".switch.tmp";
  fs.writeFileSync(tmp, stringify(c), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export function remote(c: Config, args: string[], input?: string | Buffer) {
  const dir = c.deployment.cloud.install_dir;
  const shell = `cd ${quote(dir)} && ${quote(path.join(dir, "bin/monitor"))} ${args.map(quote).join(" ")}`;
  return command(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      c.deployment.cloud.ssh_host,
      shell,
    ],
    input,
  );
}
export async function deploySwitch(root: string, c: Config, to: Side) {
  const release = await acquire(root, "management");
  try {
    if (c.deployment.active === to) {
      if (to === "cloud") remote(c, ["service", "health", "--side", "cloud"]);
      else await serviceControl(root, "local", "health");
      return;
    }
    const ops: SwitchOps = {
      preflight: async (side) => {
        if (
          side === "local" &&
          c.deployment.local.confirm_each_boot &&
          !isApproved(readApproval(root), currentBoot())
        )
          throw new Error(
            "Confirm this Mac boot with bin/monitor confirm-start before switching to local",
          );
        if (side === "cloud")
          serviceDoctorRemote(c);
        if (side === "cloud")
          remote(
            c,
            ["check-import-config", "--probe"],
            fs.readFileSync(path.join(root, "config.yaml")),
          );
        else
          command(process.execPath, [
            path.join(root, "dist/src/cli.js"),
            "--root",
            root,
            "check-config",
            "--probe",
          ]);
      },
      stop: async (side) => {
        if (side === "cloud") remote(c, ["service", "stop", "--side", "cloud"]);
        else await serviceControl(root, "local", "stop");
      },
      assertStopped: async (side) => {
        if (side === "cloud")
          remote(c, ["service", "assert-stopped", "--side", "cloud"]);
        else await serviceControl(root, "local", "assert-stopped");
      },
      transfer: async (from, to) => {
        // Both services are stopped. DELETE journal mode avoids detached WAL state.
        const source =
          from === "local"
            ? command(process.execPath, [
                path.join(root, "dist/src/cli.js"),
                "--root",
                root,
                "state-export",
              ]).trim()
            : remote(c, ["state-export"]).trim();
        if (to === "local") importState(root, source);
        else remote(c, ["state-import"], source);
        if (to === "cloud")
          remote(
            c,
            ["config-import"],
            fs.readFileSync(path.join(root, "config.yaml")),
          );
        // Mac is the configuration source for either destination; secrets never transfer.
      },
      setActive: async (side) => {
        setActive(root, side);
        remote(c, ["set-active", side]);
      },
      start: async (side) => {
        if (side === "cloud")
          remote(c, ["service", "start", "--side", "cloud"]);
        else await serviceControl(root, "local", "start");
      },
      health: async (side) => {
        for (let i = 0; i < 20; i++) {
          try {
            if (side === "cloud")
              remote(c, ["service", "health", "--side", "cloud"]);
            else await serviceControl(root, "local", "health");
            return;
          } catch {
            await sleep(1000);
          }
        }
        throw new Error("Target failed health check");
      },
    };
    // Validate the exact incoming configuration against the destination's own secrets.
    remote(
      c,
      ["check-import-config"],
      fs.readFileSync(path.join(root, "config.yaml")),
    );
    await switchInstance(c.deployment.active, to, ops);
    atomicJson(path.join(root, "var/deployment.json"), {
      active: to,
      switched_at: Date.now(),
    });
  } finally {
    await release();
  }
}
function serviceDoctorRemote(c: Config) {
  remote(c, ["service", "doctor", "--side", "cloud"]);
}
export function importState(root: string, b64: string) {
  const data = Buffer.from(b64.trim(), "base64");
  if (data.subarray(0, 16).toString() !== "SQLite format 3\u0000")
    throw new Error("Invalid SQLite snapshot");
  fs.mkdirSync(path.join(root, "var"), { recursive: true, mode: 0o700 });
  const file = path.join(root, "var/state.sqlite");
  if (fs.existsSync(file)) fs.copyFileSync(file, file + ".previous");
  const tmp = file + ".incoming";
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
