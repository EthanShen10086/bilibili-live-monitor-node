import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
export const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));
export function atomicJson(file: string, value: unknown) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export async function acquire(root: string, name = "instance") {
  const dir = path.join(root, "var");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${name}.guard`);
  fs.closeSync(fs.openSync(file, "a", 0o600));
  return lockfile.lock(file, {
    stale: 15000,
    update: 2000,
    retries: 0,
    onCompromised: () => {
      process.stderr.write(
        "Runtime lock compromised; exiting to prevent concurrent instances.\n",
      );
      process.exit(1);
    },
  });
}
export function readStatus(root: string) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(root, "var/status.json"), "utf8"),
    );
  } catch {
    return undefined;
  }
}
let logFile: string | undefined;
export function configureLogs(root: string) {
  fs.mkdirSync(path.join(root, "var"), { recursive: true, mode: 0o700 });
  logFile = path.join(root, "var/events.log");
}
export function log(event: string, details: Record<string, unknown> = {}) {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    event,
    ...details,
  });
  if (!logFile) {
    console.log(line);
    return;
  }
  if (fs.existsSync(logFile) && fs.statSync(logFile).size >= 2 * 1024 * 1024) {
    for (let i = 2; i >= 1; i--) {
      const old = logFile + "." + i;
      if (fs.existsSync(old)) fs.renameSync(old, logFile + "." + (i + 1));
    }
    fs.renameSync(logFile, logFile + ".1");
  }
  fs.appendFileSync(logFile, line + "\n", { mode: 0o600 });
}
