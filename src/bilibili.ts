import { z } from "zod";
import { jsonRequest, RemoteError, type Fetch } from "./http.js";
export interface Observation {
  roomId: number;
  live: boolean;
  title: string;
  startTime?: string;
  detectedAt: number;
  eventId?: string;
}
const responseSchema = z.object({
  code: z.number(),
  data: z.object({
    room_id: z.number().int().positive(),
    short_id: z.number().int().nonnegative().optional(),
    live_status: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    title: z.string(),
    live_time: z.union([z.string(), z.number()]).optional(),
  }),
});
export function normalizeStart(value: unknown): string | undefined {
  if (typeof value === "number" && value > 0 && Number.isFinite(value)) {
    const d = new Date(value * 1000);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ||
    value.startsWith("0000")
  )
    return;
  const d = new Date(value.replace(" ", "T") + "+08:00");
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
export function parseRoom(
  payload: unknown,
  requested: number,
  now = Date.now(),
): Observation {
  if (
    typeof payload !== "object" ||
    payload === null ||
    (payload as any).code !== 0
  )
    throw new RemoteError(
      "Bilibili",
      (payload as any)?.code ?? "invalid_response",
      true,
    );
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success)
    throw new RemoteError("Bilibili", "schema_changed", true);
  const d = parsed.data.data;
  if (d.room_id !== requested && d.short_id !== requested)
    throw new RemoteError("Bilibili", "wrong_room", false);
  return {
    roomId: d.room_id,
    live: d.live_status === 1,
    title: d.title,
    startTime: normalizeStart(d.live_time),
    detectedAt: now,
  };
}
export async function probeRoom(
  room: number,
  timeout = 5000,
  transport: Fetch = fetch,
) {
  try {
    return parseRoom(
      await jsonRequest(
        `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${room}`,
        { headers: { Accept: "application/json" } },
        timeout,
        transport,
      ),
      room,
    );
  } catch (e) {
    if (e instanceof RemoteError && e.service === "HTTP")
      throw new RemoteError("Bilibili HTTP", e.code, true);
    throw e;
  }
}
