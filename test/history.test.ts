import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { Store } from "../src/store.js";
test("daily bounded retention preserves pending, recent and current-session dedupe", (t) => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"monitor-history-"));const file=path.join(dir,"state.sqlite");const db=new Store(file);t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true})});
 const day=86_400_000, now=100*day;
 db.observe({roomId:1,live:true,title:"test",startTime:"2026-10-08T10:00:00Z",detectedAt:1000},true,30);
 const job=db.due(1001)!;db.sent(job.key);db.db.prepare("UPDATE jobs SET expires=0").run();
 const insert=db.db.prepare("INSERT INTO jobs(key,payload,status,next,expires) VALUES(?,'{}',?,0,?)");
 db.db.transaction(()=>{for(let i=0;i<205;i++)insert.run("old"+i,["sent","expired","failed"][i%3],0);insert.run("pending","pending",0);insert.run("recent","sent",now);})();
 assert.equal(db.cleanupHistory(90,now),200);
 assert.equal(db.cleanupHistory(90,now+1000),0);
 assert.equal(db.nextCleanupAt(90,now+1000),now+day);
 assert.equal(db.cleanupHistory(90,now+day),5);
 assert.equal(db.pollingPhase(1),"notified_live");
 assert.deepEqual(db.db.prepare("SELECT key FROM jobs ORDER BY key").all().map((r:any)=>r.key),[job.key,"pending","recent"].sort());
 const reopened=new Store(file);assert.equal(reopened.pollingPhase(1),"notified_live");reopened.close();
 assert.equal(db.cleanupHistory(0,now+10*day),0);assert.equal(db.nextCleanupAt(0,now),Infinity);
});

test("legacy database upgrades preserve an already sent current session", (t) => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"monitor-legacy-db-"));const file=path.join(dir,"state.sqlite");t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const legacy=new Database(file);
 legacy.exec(`CREATE TABLE observations(room INTEGER PRIMARY KEY,live INTEGER NOT NULL,start TEXT,key TEXT);
 CREATE TABLE jobs(key TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next INTEGER NOT NULL,expires INTEGER NOT NULL,last_error TEXT);
 INSERT INTO observations VALUES(1,1,'2026-10-08T10:00:00Z','legacy');
 INSERT INTO jobs(key,payload,status,next,expires) VALUES('legacy','{}','sent',0,0);`);legacy.close();
 const upgraded=new Store(file);try{assert.equal(upgraded.cleanupHistory(90,100*86_400_000),0);assert.equal(upgraded.pollingPhase(1),"notified_live");}finally{upgraded.close()}
});

test("pending indexes bound queue scans and preserve migration and expiry semantics", (t) => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"monitor-index-"));const file=path.join(dir,"state.sqlite");const db=new Store(file);t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true})});
 const insert=db.db.prepare("INSERT INTO jobs(key,payload,status,next,expires) VALUES(?,'{}',?,?,?)");
 db.db.transaction(()=>{for(let i=0;i<2000;i++)insert.run("sent"+i,"sent",0,0);insert.run("due","pending",10,100);insert.run("expired","pending",0,5);insert.run("future","pending",200,300);})();
 const plan=(sql:string)=>db.db.prepare("EXPLAIN QUERY PLAN "+sql).all().map((r:any)=>r.detail).join(" ");
 assert.match(plan("SELECT key FROM jobs WHERE status='pending' AND next<=20 ORDER BY next LIMIT 1"),/jobs_pending_next/);
 assert.match(plan("UPDATE jobs SET status='expired' WHERE status='pending' AND expires<=20"),/jobs_pending_expires/);
 assert.equal(db.due(20)?.key,"due");db.sent("due");assert.equal(db.nextWake(),200);
 assert.equal((db.db.prepare("SELECT status FROM jobs WHERE key='expired'").get() as any).status,"expired");
 const reopened=new Store(file);reopened.close();assert.equal((db.db.prepare("SELECT count(*) AS n FROM jobs").get() as any).n,2003);
});
