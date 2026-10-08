import { atomicJson } from "./runtime.js";
import { Store } from "./store.js";
export const HEARTBEAT_MS = 10_000;

export class StatusWriter {
  private fingerprint = "";
  lastWrite = -Infinity;
  writes = 0;
  constructor(private file: string, private now = Date.now) {}
  report(status: Record<string, any>, force = false) {
    const { updated_at: ignored, ...snapshot } = status;
    const fingerprint = JSON.stringify(snapshot);
    const now = this.now();
    if (!force && fingerprint === this.fingerprint && now - this.lastWrite < HEARTBEAT_MS) return false;
    status.updated_at = now;
    atomicJson(this.file, status);
    this.fingerprint = fingerprint;
    this.lastWrite = now;
    this.writes++;
    return true;
  }
}

export class QueueSchedule {
  dirty = true;
  nextCheck = 0;
  nextDue = Infinity;
  refreshes = 0;
  counts: ReturnType<Store["counts"]> = [];
  private version = -1;
  constructor(private store: Store) {}
  refresh(now = Date.now()) {
    if (!this.dirty && now < this.nextCheck) return;
    const version = this.store.dataVersion();
    if (this.dirty || version !== this.version) {
      this.counts = this.store.counts();
      this.nextDue = this.store.nextWake();
      this.refreshes++;
    }
    this.version = version;
    this.dirty = false;
    this.nextCheck = now + HEARTBEAT_MS;
  }
}

// A signal arriving before wait is retained; shutdown and official events do not wait for a timer.
export class WakeSignal {
  private pending = false;
  private resume?: () => void;
  signal() { this.pending = true; this.resume?.(); }
  async wait(ms: number) {
    if (this.pending) { this.pending = false; return; }
    await new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(timer); this.resume = undefined; this.pending = false; resolve(); };
      const timer = setTimeout(finish, Math.max(1, ms));
      this.resume = finish;
    });
  }
}
