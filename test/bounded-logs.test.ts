import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { appendBoundedLog } from "../src/bounded-logs.js";
test("logs cap old files, large chunks and retained archives", (t) => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"monitor-log-limit-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,"events.log");fs.writeFileSync(file,Buffer.alloc(3*1024*1024));
 const chunk=Buffer.alloc(64*1024,65);
 for(let i=0;i<140;i++)appendBoundedLog(file,chunk);
 appendBoundedLog(file,"TAIL_MARKER");
 assert.ok(fs.readFileSync(file,"utf8").endsWith("TAIL_MARKER"));
 assert.ok(fs.existsSync(file+".3"));assert.ok(!fs.existsSync(file+".4"));
 for(const p of fs.readdirSync(dir))assert.ok(fs.statSync(path.join(dir,p)).size<=2*1024*1024);
});
