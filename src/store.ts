import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { Observation } from "./bilibili.js";
import { backoff } from "./schedule.js";
export interface Notice extends Observation {
  key: string;
  catchup: boolean;
}
export interface Job {
  key: string;
  payload: string;
  attempts: number;
  expires: number;
}
export class Store {
  db: Database.Database;
  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file);
    fs.chmodSync(file, 0o600);
    this.db.pragma("journal_mode = DELETE");
    this.db.exec(`
    CREATE TABLE IF NOT EXISTS observations (room INTEGER PRIMARY KEY, live INTEGER NOT NULL, start TEXT, key TEXT);
    CREATE TABLE IF NOT EXISTS jobs (key TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next INTEGER NOT NULL,expires INTEGER NOT NULL,last_error TEXT);
  `);
  }
  observe(o: Observation, catchup: boolean, ttl: number): boolean {
    return this.db.transaction(() => {
      const prev = this.db
        .prepare("SELECT * FROM observations WHERE room=?")
        .get(o.roomId) as any;
      let key: string | undefined;
      if (o.live) {
        if (o.startTime) key = `${o.roomId}:start:${o.startTime}`;
        else if (prev?.live) key = prev.key;
        else key = `${o.roomId}:local:${randomUUID()}`;
        // A start timestamp appearing late must not create a second notification.
        if (
          prev?.live &&
          prev.key &&
          (!o.startTime || !prev.start || prev.start === o.startTime)
        ) {
          key = prev.key;
        }
      }
      const actualStart = o.live
        ? (o.startTime ?? (prev?.live ? prev.start : undefined))
        : undefined;
      if (!prev || prev.live !== Number(o.live) || prev.start !== (actualStart ?? null) || prev.key !== (key ?? null))
        this.db.prepare("INSERT OR REPLACE INTO observations(room,live,start,key) VALUES(?,?,?,?)")
          .run(o.roomId, Number(o.live), actualStart ?? null, key ?? null);
      if (o.live && prev?.live && prev.key === key) return false;
      if (!o.live || !key) return false;
      const notice: Notice = {
        ...o,
        startTime: actualStart ?? undefined,
        key,
        catchup,
      };
      return (
        this.db
          .prepare(
            "INSERT OR IGNORE INTO jobs(key,payload,next,expires) VALUES(?,?,?,?)",
          )
          .run(
            key,
            JSON.stringify(notice),
            o.detectedAt,
            o.detectedAt + ttl * 60000,
          ).changes > 0
      );
    })();
  }
  due(now = Date.now()): Job | undefined {
    this.db
      .prepare(
        "UPDATE jobs SET status='expired' WHERE status='pending' AND expires<=?",
      )
      .run(now);
    return this.db
      .prepare(
        "SELECT key,payload,attempts,expires FROM jobs WHERE status='pending' AND next<=? ORDER BY next LIMIT 1",
      )
      .get(now) as Job | undefined;
  }
  sent(key: string) {
    this.db
      .prepare("UPDATE jobs SET status='sent',last_error=NULL WHERE key=?")
      .run(key);
  }
  failed(job: Job, code: string, retryable: boolean, now = Date.now()) {
    this.db
      .prepare(
        "UPDATE jobs SET status=?,attempts=attempts+1,next=?,last_error=? WHERE key=?",
      )
      .run(
        retryable ? "pending" : "failed",
        now + backoff(job.attempts + 1, 5000),
        code,
        job.key,
      );
  }
  retryFailed(now = Date.now()) {
    return this.db
      .prepare(
        "UPDATE jobs SET status='pending',next=?,last_error=NULL WHERE status='failed' AND expires>?",
      )
      .run(now, now).changes;
  }
  dataVersion(): number { return this.db.pragma("data_version", { simple: true }) as number; }
  nextWake(): number {
    const row = this.db.prepare("SELECT MIN(next) AS next, MIN(expires) AS expires FROM jobs WHERE status='pending'").get() as { next: number | null; expires: number | null };
    return Math.min(row.next ?? Infinity, row.expires ?? Infinity);
  }
  counts() {
    return this.db
      .prepare("SELECT status, count(*) AS count FROM jobs GROUP BY status")
      .all();
  }
  close() {
    this.db.close();
  }
}
