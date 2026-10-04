import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { sleep } from "../src/runtime.js";
import { Store } from "../src/store.js";
const project = path.resolve(import.meta.dirname, "../..");
async function runOnce(root: string, mode: string) {
  const child = spawn(
    process.execPath,
    [path.join(project, "dist/test/fixtures/service.js"), root, mode],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "",
    err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const done = new Promise<number | null>((r) => child.on("exit", r));
  try {
    let observed = false;
    for (let i = 0; i < 200; i++) {
      await sleep(50);
      try {
        const s = JSON.parse(
          fs.readFileSync(path.join(root, "var/status.json"), "utf8"),
        );
        if (
          s.pid === child.pid &&
          (mode === "outside"
            ? s.detector_state === "outside_window"
            : mode === "retry"
              ? s.last_sent_at
              : s.last_observation_at || s.detector_state === "retrying")
        ) {
          observed = true;
          break;
        }
      } catch {}
    }
    assert.ok(observed, "service did not become ready: " + err);
    child.kill("SIGTERM");
    assert.equal(await done, 0, err);
    return out;
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
test("real worker persists dedupe through restart, probe failure, and next session", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-integration-"));
  fs.copyFileSync(
    path.join(project, "config.yaml"),
    path.join(root, "config.yaml"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.ok((await runOnce(root, "live")).includes("notification_sent"));
  assert.ok(!(await runOnce(root, "live")).includes("notification_sent"));
  assert.ok((await runOnce(root, "error")).includes("detector_error"));
  assert.ok(!(await runOnce(root, "live")).includes("notification_sent"));
  await runOnce(root, "offline");
  assert.ok((await runOnce(root, "next")).includes("notification_sent"));
  const db = new Store(path.join(root, "var/state.sqlite"));
  assert.deepEqual(db.counts(), [{ status: "sent", count: 2 }]);
  db.close();
});

test("outside scheduled windows the worker makes no network calls", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-outside-"));
  fs.copyFileSync(
    path.join(project, "config.yaml"),
    path.join(root, "config.yaml"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = await runOnce(root, "outside");
  assert.ok(!output.includes("UNEXPECTED_NETWORK_CALL"));
  const db = new Store(path.join(root, "var/state.sqlite"));
  assert.deepEqual(db.counts(), []);
  db.close();
});
test("worker retries a transient Feishu failure and persists one successful delivery", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-retry-"));
  fs.copyFileSync(
    path.join(project, "config.yaml"),
    path.join(root, "config.yaml"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = await runOnce(root, "retry");
  assert.ok(output.includes("notification_error"));
  assert.equal(output.split('"event":"notification_sent"').length - 1, 1);
  const db = new Store(path.join(root, "var/state.sqlite"));
  assert.deepEqual(db.counts(), [{ status: "sent", count: 1 }]);
  assert.equal(
    (db.db.prepare("SELECT attempts FROM jobs").get() as any).attempts,
    1,
  );
  db.close();
});
