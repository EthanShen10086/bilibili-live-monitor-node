import path from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { type Config, validateCredentials } from "./config.js";
import { probeRoom } from "./bilibili.js";
import { Store } from "./store.js";
import { Feishu, formatNotice } from "./feishu.js";
import { Official } from "./official.js";
import { inWindow, backoff } from "./schedule.js";
import { RemoteError } from "./http.js";
import { acquire, atomicJson, sleep, log } from "./runtime.js";
export async function runService(root: string, c: Config) {
  validateCredentials(c);
  const release = await acquire(root);
  let store: Store | undefined;
  let running = true;
  const stop = () => {
    running = false;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  let official: Official | undefined;
  const status: any = {
    pid: process.pid,
    host: hostname(),
    instance: randomUUID(),
    running: true,
    mode: c.detector.mode,
    notification: c.notification.mode,
    started_at: Date.now(),
    detector_state: "starting",
    last_observation_at: null,
  };
  let nextPoll = 0,
    failures = 0,
    wasInWindow = false,
    needsCatchup = true,
    nextOfficial = 0,
    officialFailures = 0;
  let pollFatal = false,
    officialFatal = false;
  const report = () => {
    status.updated_at = Date.now();
    status.pending = store?.counts();
    atomicJson(path.join(root, "var/status.json"), status);
  };
  try {
    store = new Store(path.join(root, "var/state.sqlite"));
    const db = store;
    const notify = new Feishu(c);
    report();
    while (running) {
      const now = Date.now();
      const window = inWindow(c.schedule, new Date(now));
      status.in_window = window;
      if (!window) {
        if (official) {
          try {
            await official.stop();
            official = undefined;
          } catch (e) {
            status.detector_state = "session_cleanup_failed";
            status.last_error =
              e instanceof RemoteError ? e.message : "Official cleanup failed";
            report();
            await sleep(1000);
            continue;
          }
        }
        status.detector_state = "outside_window";
        wasInWindow = false;
        needsCatchup = true;
        nextPoll = 0;
      } else if (c.detector.mode === "polling") {
        if (!wasInWindow) {
          needsCatchup = true;
          nextPoll = 0;
        }
        wasInWindow = true;
        if (!pollFatal && now >= nextPoll) {
          try {
            const o = await probeRoom(
              c.subscription.room_id,
              c.detector.polling.timeout_seconds * 1000,
            );
            // A request completing after the configured boundary cannot create a notice.
            if (running && inWindow(c.schedule)) {
              const added = db.observe(
                o,
                needsCatchup,
                c.notification.pending_ttl_minutes,
              );
              needsCatchup = false;
              status.last_observation_at = o.detectedAt;
              status.real_room_id = o.roomId;
              status.live = o.live;
              if (added)
                log("notice_queued", {
                  room: o.roomId,
                  detected_at: o.detectedAt,
                });
            }
            failures = 0;
            status.detector_state = "healthy";
            delete status.last_error;
            nextPoll = Date.now() + c.detector.polling.interval_seconds * 1000;
          } catch (e) {
            failures++;
            pollFatal = e instanceof RemoteError && !e.retryable;
            status.detector_state = pollFatal ? "blocked" : "retrying";
            status.last_error =
              e instanceof RemoteError ? e.message : "Room probe failed";
            nextPoll =
              Date.now() +
              backoff(failures, c.detector.polling.interval_seconds * 1000);
            log("detector_error", {
              code: status.last_error,
              retry_at: nextPoll,
            });
          }
        }
      } else {
        wasInWindow = true;
        if (
          official &&
          status.detector_state === "session_cleanup_failed" &&
          now >= nextOfficial
        ) {
          try {
            await official.stop();
            official = undefined;
            status.detector_state = officialFatal ? "blocked" : "retrying";
          } catch {
            nextOfficial = Date.now() + backoff(++officialFailures);
          }
        }
        if (!officialFatal && now >= nextOfficial) {
          try {
            if (!official) {
              // This snapshot resolves the short ID and reconciles missed state; events remain the primary detector.
              const snapshot = await probeRoom(
                c.subscription.room_id,
                c.detector.polling.timeout_seconds * 1000,
              );
              official = new Official(c, snapshot.roomId, (o) => {
                if (running && inWindow(c.schedule)) {
                  db.observe(o, false, c.notification.pending_ttl_minutes);
                  status.last_observation_at = o.detectedAt;
                  status.live = o.live;
                }
              });
              await official.start();
              await official.waitReady();
              if (
                running &&
                inWindow(c.schedule) &&
                (status.last_observation_at ?? 0) <= snapshot.detectedAt
              ) {
                db.observe(snapshot, true, c.notification.pending_ttl_minutes);
                status.real_room_id = snapshot.roomId;
                status.last_observation_at = snapshot.detectedAt;
                status.live = snapshot.live;
              }
            }
            await official.tick();
            status.detector_state = official.connected
              ? "healthy"
              : "connecting";
            if (official.connected) {
              officialFailures = 0;
              delete status.last_error;
            }
          } catch (e) {
            officialFailures++;
            officialFatal = e instanceof RemoteError && !e.retryable;
            status.last_error =
              e instanceof RemoteError
                ? e.message
                : "Official connection failed";
            status.detector_state = officialFatal ? "blocked" : "retrying";
            if (official) {
              try {
                await official.stop();
                official = undefined;
              } catch {
                status.detector_state = "session_cleanup_failed";
              }
            }
            nextOfficial = Date.now() + backoff(officialFailures);
            log("detector_error", {
              code: status.last_error,
              retry_at: nextOfficial,
            });
          }
        }
      }
      const job = db.due();
      if (job && running) {
        try {
          await notify.send(
            formatNotice(JSON.parse(job.payload), c.subscription.room_id),
            job.key,
          );
          db.sent(job.key);
          status.last_sent_at = Date.now();
          delete status.notification_error;
          log("notification_sent", { key: job.key });
        } catch (e) {
          const error =
            e instanceof RemoteError
              ? e
              : new RemoteError("Notification", "send_failed");
          db.failed(job, error.message, error.retryable);
          status.notification_error = error.message;
          log("notification_error", {
            key: job.key,
            code: error.message,
            retryable: error.retryable,
          });
        }
      }
      report();
      await sleep(1000);
    }
  } finally {
    if (official) {
      try {
        await official.stop();
      } catch {
        log("official_cleanup_failed");
      }
    }
    status.running = false;
    status.detector_state = "stopped";
    report();
    store?.close();
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await release();
  }
}
