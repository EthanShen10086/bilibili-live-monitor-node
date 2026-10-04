import test from "node:test";
import assert from "node:assert/strict";
import { verifyRecovery, type RecoveryOps } from "../src/recovery.js";
import { serviceFiles } from "../src/deployment.js";

test("cloud template restarts exits and avoids restart rate lockout", () => {
  const { unit } = serviceFiles("/opt/live-monitor", "/opt/node/bin/node");
  assert.match(unit, /Restart=always\nRestartSec=20/);
  assert.match(unit, /StartLimitIntervalSec=0/);
  assert.match(unit, /WantedBy=default.target/);
  assert.match(unit, /--managed cloud/);
});
test("recovery waits for a different healthy manager-owned PID", async () => {
  let polls = 0;
  let crashed = false;
  const ops: RecoveryOps = {
    healthyPid: async () => {
      if (!crashed) return 100;
      if (++polls === 1) throw new Error("not ready");
      return polls === 2 ? 100 : 200;
    },
    managerPid: async () => crashed ? 200 : 100,
    crash: async pid => { assert.equal(pid, 100); crashed = true; },
    pause: async () => {},
  };
  assert.deepEqual(await verifyRecovery(ops, 5), { before_pid: 100, after_pid: 200, recovered: true });
});
test("recovery refuses mismatched manager PID without sending a signal", async () => {
  let signals = 0;
  await assert.rejects(verifyRecovery({
    healthyPid: async () => 100,
    managerPid: async () => 200,
    crash: async () => { signals++; },
    pause: async () => {},
  }), /does not match/);
  assert.equal(signals, 0);
});
test("permission denied is surfaced, not retried or declared recovered", async () => {
  let polls = 0;
  await assert.rejects(verifyRecovery({
    healthyPid: async () => 100,
    managerPid: async () => 100,
    crash: async () => { throw new Error("operation not permitted"); },
    pause: async () => { polls++; },
  }), /not permitted/);
  assert.equal(polls, 0);
});
test("recovery fails if manager owns a different replacement process", async () => {
  let crashed = false;
  await assert.rejects(verifyRecovery({
    healthyPid: async () => crashed ? 200 : 100,
    managerPid: async () => crashed ? 300 : 100,
    crash: async () => { crashed = true; },
    pause: async () => {},
  }, 2), /no new healthy/);
});
