import fs from "node:fs";
import path from "node:path";
export const LOG_LIMIT = 2 * 1024 * 1024;
const CHUNK_LIMIT = 64 * 1024;

function trim(file: string) {
  if (!fs.existsSync(file) || fs.statSync(file).size <= LOG_LIMIT) return;
  const fd = fs.openSync(file, "r");
  const tail = Buffer.alloc(LOG_LIMIT);
  try { fs.readSync(fd, tail, 0, LOG_LIMIT, fs.fstatSync(fd).size - LOG_LIMIT); }
  finally { fs.closeSync(fd); }
  fs.writeFileSync(file, tail, { mode: 0o600 });
}
export function appendBoundedLog(file: string, value: string | Uint8Array) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let bytes = typeof value === "string" ? Buffer.from(value.slice(-CHUNK_LIMIT)) : Buffer.from(value.subarray(Math.max(0, value.length - CHUNK_LIMIT)));
  if (bytes.length > CHUNK_LIMIT) bytes = bytes.subarray(-CHUNK_LIMIT);
  for (const name of [file, file + ".1", file + ".2", file + ".3"]) trim(name);
  if (fs.existsSync(file) && fs.statSync(file).size + bytes.length > LOG_LIMIT) {
    for (let i = 2; i >= 1; i--) if (fs.existsSync(file + "." + i)) fs.renameSync(file + "." + i, file + "." + (i + 1));
    fs.renameSync(file, file + ".1");
  }
  fs.appendFileSync(file, bytes, { mode: 0o600 });
}
export function captureManagedLogs(root: string) {
  const originalOut = process.stdout.write, originalErr = process.stderr.write;
  for (const [stream, name] of [[process.stdout, "service.log"], [process.stderr, "error.log"]] as const) {
    const file = path.join(root, "var", name);
    appendBoundedLog(file, "");
    stream.write = ((chunk: any, encoding: any, cb?: any) => {
      appendBoundedLog(file, typeof chunk === "string" ? chunk : new Uint8Array(chunk));
      const callback = typeof encoding === "function" ? encoding : cb;
      if (callback) queueMicrotask(() => callback());
      return true;
    }) as typeof stream.write;
  }
  return () => { process.stdout.write = originalOut; process.stderr.write = originalErr; };
}
