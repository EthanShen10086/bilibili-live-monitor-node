import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
const envName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const schema = z.object({
  subscription: z.object({ room_id: z.number().int().positive() }),
  detector: z.object({
    mode: z.enum(["polling", "official"]),
    polling: z.object({
      interval_minutes: z.number().int().min(1).max(60).optional(),
      interval_seconds: z.number().min(10).max(3600).optional(),
      notified_live_interval_minutes: z.number().int().min(1).max(60).default(5),
      timeout_seconds: z.number().min(1).max(60),
    }).refine(
      (p) => (p.interval_minutes === undefined) !== (p.interval_seconds === undefined),
      "Configure exactly one of interval_minutes or legacy interval_seconds",
    ),
    official: z.object({
      app_id_env: envName,
      access_key_id_env: envName,
      access_key_secret_env: envName,
      anchor_code_env: envName,
    }),
  }),
  schedule: z
    .object({
      timezone: z.string().refine((s) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: s });
          return true;
        } catch {
          return false;
        }
      }, "Invalid timezone"),
      weekdays: z
        .array(z.number().int().min(1).max(7))
        .min(1)
        .refine((a) => new Set(a).size === a.length),
      start: time,
      end: z.union([time, z.literal("24:00")]),
    })
    .refine(
      (s) => s.start < s.end,
      "Require start < end; overnight windows must be split",
    ),
  notification: z.object({
    mode: z.enum(["feishu_group", "feishu_private"]),
    pending_ttl_minutes: z.number().positive().max(1440),
    group: z.object({ webhook_env: envName, secret_env: envName }),
    private: z.object({
      app_id_env: envName,
      app_secret_env: envName,
      receive_id_type: z.enum(["open_id", "user_id", "union_id"]),
      receive_id_env: envName,
    }),
  }),
  maintenance: z.object({ history_retention_days: z.number().int().min(0).max(3650).default(90) }).default({ history_retention_days: 90 }),
  deployment: z.object({
    active: z.enum(["local", "cloud"]),
    local: z
      .object({ confirm_each_boot: z.boolean().default(true) })
      .default({ confirm_each_boot: true }),
    cloud: z.object({
      ssh_host: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$/),
      install_dir: z
        .string()
        .regex(/^\/[a-zA-Z0-9_./-]+$/)
        .refine((p) => !p.split("/").includes("..")),
    }),
  }),
});
export type Config = z.infer<typeof schema>;
export function readConfig(root: string): Config {
  try {
    return schema.parse(
      parse(fs.readFileSync(path.join(root, "config.yaml"), "utf8")),
    );
  } catch (e) {
    if (e instanceof z.ZodError)
      throw new Error(
        e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
    throw new Error("Cannot read config.yaml or invalid YAML");
  }
}
export function secret(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing environment variable: ${name}`);
  return value;
}
export function validateCredentials(c: Config) {
  if (c.notification.mode === "feishu_group") {
    const u = new URL(secret(c.notification.group.webhook_env));
    if (
      u.protocol !== "https:" ||
      u.hostname !== "open.feishu.cn" ||
      !u.pathname.startsWith("/open-apis/bot/v2/hook/")
    )
      throw new Error("Expected a Feishu HTTPS bot webhook");
    secret(c.notification.group.secret_env);
  } else
    Object.values(c.notification.private)
      .filter((v) => v !== "open_id" && v !== "user_id" && v !== "union_id")
      .forEach(secret);
  if (c.detector.mode === "official") {
    Object.values(c.detector.official).forEach(secret);
    if (!/^\d+$/.test(secret(c.detector.official.app_id_env)))
      throw new Error("Bilibili app ID must be numeric");
  }
}
export function loadEnv(root: string) {
  const p = path.join(root, ".env");
  if (fs.existsSync(p)) {
    if ((fs.statSync(p).mode & 0o077) !== 0)
      throw new Error("Restrict .env permissions: chmod 600 .env");
    process.loadEnvFile(p);
  }
}

// Retain legacy seconds configs; minute-based settings are preferred.
export function pollingIntervalMs(p: Config["detector"]["polling"]): number {
  if (p.interval_minutes !== undefined && p.interval_seconds === undefined)
    return p.interval_minutes * 60_000;
  if (p.interval_seconds !== undefined && p.interval_minutes === undefined)
    return p.interval_seconds * 1_000;
  throw new Error("Configure exactly one polling interval unit");
}

export function notifiedLiveIntervalMs(p: Config["detector"]["polling"]): number {
  return Math.max(pollingIntervalMs(p), (p.notified_live_interval_minutes ?? 5) * 60_000);
}
