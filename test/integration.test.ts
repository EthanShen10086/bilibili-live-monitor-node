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
    let retryState: any;
    for (let i = 0; i < 200; i++) {
      await sleep(50);
      try {
        const s = JSON.parse(
          fs.readFileSync(path.join(root, "var/status.json"), "utf8"),
        );
        if (mode === "retry" && s.pid === child.pid && s.notification_error) {
          if (!s.last_sent_at) retryState = s;
        }
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
    const state = JSON.parse(fs.readFileSync(path.join(root, "var/status.json"), "utf8"));
    if (mode === "retry") {
      assert.equal(retryState?.polling_phase, "awaiting_notification");
      assert.equal(retryState?.effective_polling_interval_seconds, 60);
    }
    if (["live", "next", "retry"].includes(mode)) {
      assert.equal(state.polling_phase, "notified_live");
      assert.equal(state.effective_polling_interval_seconds, 300);
      assert.ok(state.next_poll_at - state.last_observation_at >= 300_000);
    } else if (mode === "offline") {
      assert.equal(state.polling_phase, "awaiting_start");
      assert.equal(state.effective_polling_interval_seconds, 60);
    }
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


test("minute interval worker waits before the next query", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-minute-worker-"));
  fs.copyFileSync(path.join(project, "config.yaml"), path.join(root, "config.yaml"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, [path.join(project, "dist/test/fixtures/service.js"), root, "minute"], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "", error = "";
  child.stdout.on("data", (d) => output += d);
  child.stderr.on("data", (d) => error += d);
  const done = new Promise<number | null>((resolve) => child.on("exit", resolve));
  try {
    for (let i = 0; i < 300 && !output.includes("POLL_COUNT 2"); i++) await sleep(50);
    assert.ok(output.includes("POLL_COUNT 2"), "second query missing: " + error + output);
    assert.ok(output.indexOf("POLL_COUNT 2") > output.indexOf("CLOCK_AFTER_INTERVAL"), "queried before configured minute");
    const state = JSON.parse(fs.readFileSync(path.join(root, "var/status.json"), "utf8"));
    assert.equal(state.polling_interval_seconds, 60);
    assert.ok(state.next_poll_at - state.last_observation_at >= 60_000);
    child.kill("SIGTERM");
    assert.equal(await done, 0, error);
  } finally {
    if (child.exitCode === null) { child.kill("SIGKILL"); await done; }
  }
});


test("idle worker keeps its status file stable and stops promptly", async (t) => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"monitor-idle-"));fs.copyFileSync(path.join(project,"config.yaml"),path.join(root,"config.yaml"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const child=spawn(process.execPath,[path.join(project,"dist/test/fixtures/service.js"),root,"outside"],{stdio:["ignore","pipe","pipe"]});
 let error="";child.stderr.on("data",d=>error+=d);const done=new Promise<number|null>(resolve=>child.on("exit",resolve));
 try {
  let first:any;
  for(let i=0;i<100;i++){await sleep(50);try{first=JSON.parse(fs.readFileSync(path.join(root,"var/status.json"),"utf8"));if(first.detector_state==="outside_window")break}catch{}}
  assert.equal(first?.runtime_optimization_version,1,error);const mtime=fs.statSync(path.join(root,"var/status.json")).mtimeMs;
  await sleep(2300);const second=JSON.parse(fs.readFileSync(path.join(root,"var/status.json"),"utf8"));
  assert.equal(second.updated_at,first.updated_at);assert.equal(second.queue_refreshes,1);assert.equal(fs.statSync(path.join(root,"var/status.json")).mtimeMs,mtime);
  const stoppedAt=Date.now();child.kill("SIGTERM");assert.equal(await done,0,error);assert.ok(Date.now()-stoppedAt<2500,"shutdown waited for idle timer");
 }finally{if(child.exitCode===null){child.kill("SIGKILL");await done}}
});

test("declined boot confirmation stays idle and SIGTERM interrupts its wait", async (t) => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"monitor-approval-idle-"));fs.copyFileSync(path.join(project,"config.yaml"),path.join(root,"config.yaml"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const child=spawn(process.execPath,[path.join(project,"dist/test/fixtures/service.js"),root,"approval-wait"],{stdio:["ignore","pipe","pipe"]});
 let error="";child.stderr.on("data",d=>error+=d);const done=new Promise<number|null>(resolve=>child.on("exit",resolve));
 try {
  let first:any;
  for(let i=0;i<100;i++){await sleep(50);try{first=JSON.parse(fs.readFileSync(path.join(root,"var/status.json"),"utf8"));if(first.detector_state==="waiting_confirmation")break}catch{}}
  assert.equal(first?.detector_state,"waiting_confirmation",error);
  await sleep(1300);assert.equal(JSON.parse(fs.readFileSync(path.join(root,"var/status.json"),"utf8")).updated_at,first.updated_at);
  const start=Date.now();child.kill("SIGTERM");assert.equal(await done,0,error);assert.ok(Date.now()-start<1500);
 }finally{if(child.exitCode===null){child.kill("SIGKILL");await done}}
});

test("managed output is captured and shutdown drains normally", async (t) => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"monitor-managed-logs-"));fs.copyFileSync(path.join(project,"config.yaml"),path.join(root,"config.yaml"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const child=spawn(process.execPath,[path.join(project,"dist/test/fixtures/service.js"),root,"managed-logs"],{stdio:["ignore","pipe","pipe"]});
 let output="",error="";child.stdout.on("data",d=>output+=d);child.stderr.on("data",d=>error+=d);const done=new Promise<number|null>(resolve=>child.on("exit",resolve));
 try {
  let state:any;
  for(let i=0;i<100;i++){await sleep(50);try{state=JSON.parse(fs.readFileSync(path.join(root,"var/status.json"),"utf8"));if(state.detector_state==="outside_window")break}catch{}}
  assert.equal(state?.detector_state,"outside_window");
  child.kill("SIGTERM");assert.equal(await done,0,error);
  assert.equal(output,"");assert.equal(error,"");
  assert.ok(fs.readFileSync(path.join(root,"var/service.log"),"utf8").includes("CAPTURED_STDOUT"));
  assert.ok(fs.readFileSync(path.join(root,"var/error.log"),"utf8").includes("CAPTURED_STDERR"));
 }finally{if(child.exitCode===null){child.kill("SIGKILL");await done}}
});
