export interface RecoveryOps {
  healthyPid(): Promise<number>;
  managerPid(): Promise<number>;
  crash(pid: number): Promise<void>;
  pause(): Promise<void>;
}
// An explicit acceptance action: only kill a healthy PID owned by the selected manager.
export async function verifyRecovery(ops: RecoveryOps, attempts = 60) {
  const before = await ops.healthyPid();
  if (!Number.isSafeInteger(before) || before <= 1 || before !== await ops.managerPid())
    throw new Error("Refusing recovery test: service manager PID does not match healthy worker");
  await ops.crash(before);
  for (let i = 0; i < attempts; i++) {
    await ops.pause();
    try {
      const after = await ops.healthyPid();
      if (after > 1 && after !== before && after === await ops.managerPid())
        return { before_pid: before, after_pid: after, recovered: true };
    } catch {
      // The manager and application heartbeat become ready at different times.
    }
  }
  throw new Error("Recovery test failed: no new healthy managed worker within 60 seconds; inspect logs");
}
