import { test, expect, spyOn } from "bun:test";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import AdmZip from "adm-zip";
import fs from "node:fs";
import path from "node:path";
import { sessionEndMs } from "../src/shared/sessionTime";
if (process.env.PROXY_REFACTOR_SANDBOX !== "1") throw new Error("Use scripts/test-isolated.ts");
const { sessions, sessionStates } = await import("../src/services/sessionStore");
const { s3Storage } = await import("../src/services/s3Storage");
const { getJwtSecret } = await import("../src/services/jwtKey");
const { unifiedAuthMiddleware } = await import("../src/middleware/authUnified");
const { sessionAuthRouter } = await import("../src/routes/sessionAuth");
const { adminRouter } = await import("../src/routes/admin");
const app = new Hono();
app.route("/session", sessionAuthRouter); app.route("/admin", adminRouter);
app.get("/ai-probe", unifiedAuthMiddleware(), c => c.json({ok:true}));
const admin = {Authorization:`Bearer ${process.env.PROXY_API_KEY}`};
function fixture(code: string, created = Date.now(), duration = 60) {
  const root = path.resolve("logs", "sessions", code);
  sessions.set(code, {sessionCode:code, createdAt:created, startTime:created,
    durationMinutes:duration, aiValidityMinutes:duration, aiOption:"agent", defaultTokenBudget:1000, allowedStudentIds:new Set(["S1"]), createdBy:"admin"});
  sessionStates.set(`${code}:S1`, {sessionCode:code,studentId:"S1",loginTimestamp:created,hasLoggedIn:true,reassigned:false,tokensConsumed:0});
  return {root, write(name:string,content:string|Buffer){const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);},
    cleanup(){sessions.delete(code);fs.rmSync(root,{recursive:true,force:true});}};
}
async function jwt(code:string, created:number) {
  return sign({sessionCode:code,studentId:"S1",loginTime:created,aiValidityMinutes:1000,
    sessionEndTime:Math.floor(Date.now()/1000)+3600,exp:Math.floor(Date.now()/1000)+3600},getJwtSecret(),"HS256");
}
async function upload(code:string, token:string, files:any[]) {
  return app.request("/session/upload-logs",{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({sessionCode:code,studentId:"S1",files})});
}
test("a valid future JWT cannot extend a scheduled deadline; legacy milliseconds remain usable before expiry",async()=>{
  for (const expired of [false,true]) {
    const created=Date.now()-(expired?7200000:60000),code=`WINDOW_AUTH_${String(expired).toUpperCase()}`,f=fixture(code,created);
    try {
      const token=await jwt(code,created);
      const response=await app.request("/ai-probe",{headers:{Authorization:`Bearer ${token}`}});
      expect(response.status).toBe(expired?403:200);
      const status=await (await app.request("/session/status",{headers:{Authorization:`Bearer ${token}`}})).json();
      expect(status.sessionRemainingMinutes).toBe(expired?0:59);
      if(expired) expect((await app.request("/session/events/stream",{headers:{Authorization:`Bearer ${token}`}})).status).toBe(403);
    }finally{f.cleanup();}
  }
});
test("strict prompt window uses request creation, preserves source bytes and flags conflicting request IDs",async()=>{
  const created=1700000000000,code="WINDOW_PROMPTS",f=fixture(code,created);
  const raw=[{timestamp:created+1,prompt:"valid",tokensConsumedTotal:3},{timestamp:created+3600001,prompt:"late"},{timestamp:created-1,prompt:"prior"}];
  f.write("S1.json",JSON.stringify(raw));
  f.write("S1/exam_records/R/ai_interactions.jsonl",[
    {timestamp:created+3,type:"chat_request",payload:{requestId:"conflict",prompt:"one"}},
    {timestamp:created+4,type:"chat_request",payload:{requestId:"conflict",prompt:"two"}},
  ].map(r=>JSON.stringify(r)).join("\n"));
  try{
    const body=await(await app.request(`/admin/visualize/sessions/${code}/accounts/S1/prompt-log`,{headers:admin})).json();
    expect(body.turns.map((t:any)=>t.prompt)).toEqual(["valid"]);
    const full=await(await app.request(`/admin/visualize/sessions/${code}/accounts/S1/prompt-log?unclamped=true`,{headers:admin})).json();
    expect(full.turns.filter((t:any)=>t.associationStatus==="DUPLICATE_CONFLICT")).toHaveLength(2);
    expect(fs.readFileSync(path.join(f.root,"S1.json"),"utf8")).toBe(JSON.stringify(raw));
    expect(sessionStates.get(`${code}:S1`)!.tokensConsumed).toBe(0);
  }finally{f.cleanup();}
});
test("historical session export never overwrites its manifest, even without in-memory state",async()=>{
  const code="WINDOW_EXPORT",f=fixture(code),manifest='{"createdAt":1700000000000,"durationMinutes":1000,"students":[{"studentId":"S1","loginTimestamp":1700000000}]}';
  f.write("session_manifest.json",manifest);f.write("S1/events.jsonl","{\"timestamp\":1700000000001}\n");sessions.delete(code);
  try{
    const response=await app.request(`/admin/sessions/${code}/logs`,{headers:admin});expect(response.status).toBe(200);
    const zip=new AdmZip(Buffer.from(await response.arrayBuffer()));expect(zip.readAsText("session_manifest.json")).toBe(manifest);
    expect(fs.readFileSync(path.join(f.root,"session_manifest.json"),"utf8")).toBe(manifest);
  }finally{f.cleanup();}
});
test("a fresh local instance preserves the remote snapshot/log baseline, never purges S3 and reports partial sync",async()=>{
  const code="WINDOW_REMOTE_BASELINE",created=Date.now(),f=fixture(code,created);
  const old=JSON.stringify({timestamp:created-1,type:"old",groupId:71})+"\n",incoming=JSON.stringify({timestamp:created+1,type:"new",groupId:9})+"\n";
  const writes=new Map<string,string|Buffer>();
  const spies=[spyOn(s3Storage,"isAvailable").mockReturnValue(true),
    spyOn(s3Storage,"getStudentFile").mockImplementation(async(_c,_s,file)=>file.endsWith("snapshot_start.zip")?Buffer.from("original snapshot"):file.endsWith("events.jsonl")?old:null),
    spyOn(s3Storage,"uploadStudentFile").mockImplementation(async(_c,_s,file,content)=>{writes.set(file,content);return file!=="upload_info.json";}),
    spyOn(s3Storage,"purgeStudentExamRecords").mockResolvedValue(true)];
  try{
    const response=await upload(code,await jwt(code,created),[{relativePath:"exam_records/R/events.jsonl",content:incoming},{relativePath:"exam_records/R/snapshot_start.zip",content:"replacement"}]);
    expect(response.status).toBe(200);expect((await response.json()).s3Synced).toBe(false);
    expect(spies[3]).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(f.root,"S1/exam_records/R/snapshot_start.zip"),"utf8")).toBe("original snapshot");
    expect(writes.get("exam_records/R/snapshot_start.zip")!.toString()).toBe("original snapshot");
    expect(writes.get("exam_records/R/events.jsonl")!.toString()).toBe(old+incoming);
    const info=JSON.parse(fs.readFileSync(path.join(f.root,"S1/upload_info.json"),"utf8"));
    expect(info.validityWindow.expireTimestamp).toBe(sessionEndMs(sessions.get(code)));
  }finally{spies.forEach(s=>s.mockRestore());f.cleanup();}
});
test("concurrent uploads append evidence without rewriting IDs or losing either request",async()=>{
  const code="WINDOW_UPLOAD_RACE",created=Date.now(),f=fixture(code,created),token=await jwt(code,created);
  try{
    const events=[{timestamp:created-1,groupId:91},{timestamp:created+7200000,groupId:4}];
    const responses=await Promise.all(events.map(e=>upload(code,token,[{relativePath:"exam_records/R/events.jsonl",content:JSON.stringify(e)+"\n"}])));
    expect(responses.map(r=>r.status)).toEqual([200,200]);
    const saved=fs.readFileSync(path.join(f.root,"S1/exam_records/R/events.jsonl"),"utf8").trim().split("\n").map(l=>JSON.parse(l));
    expect(saved.sort((a,b)=>a.timestamp-b.timestamp)).toEqual(events);
  }finally{f.cleanup();}
});
test("mixed local and S3 records share the same artifact precedence in detail, counts and summary input",async()=>{
  const code="WINDOW_MIXED_SOURCES",created=1700000000000,f=fixture(code,created);
  const event=(n:number)=>JSON.stringify({timestamp:created+n,type:"save"})+"\n";
  f.write("S1/exam_records/R1/events.jsonl",event(1));
  const remote: Record<string,string>={
    "exam_records/R1/events.jsonl":event(99),
    "exam_records/R1/ai_interactions.jsonl":JSON.stringify({timestamp:created+2,type:"chat_request",payload:{requestId:"A",prompt:"remote request"}}),
    "exam_records/R2/events.jsonl":event(3),
  };
  const spies=[spyOn(s3Storage,"isAvailable").mockReturnValue(true),spyOn(s3Storage,"getSessionManifest").mockResolvedValue(null),
    spyOn(s3Storage,"listStudentsInSessionFromS3").mockResolvedValue([{studentId:"S1",hasPromptLog:false,hasEventLog:true}]),
    spyOn(s3Storage,"listStudentExamRecords").mockResolvedValue(["R1","R2"]),
    spyOn(s3Storage,"getExamRecordArtifact").mockImplementation(async(_c,_s,r,name)=>remote[`exam_records/${r}/${name}`]??null),
    spyOn(s3Storage,"getStudentFile").mockImplementation(async(_c,_s,name)=>remote[name]??null),
    spyOn(s3Storage,"getStudentPromptLog").mockResolvedValue([]),
    spyOn(s3Storage,"listSessionTelemetryFiles").mockResolvedValue(Object.keys(remote).map(n=>"S1/"+n))];
  const temp=fs.mkdtempSync(path.resolve("mixed-summary-fixture-"));
  try{
    const detail=await(await app.request(`/admin/visualize/sessions/${code}/accounts/S1/event-log`,{headers:admin})).json();
    expect(detail.coreRecords.map((r:any)=>r.timestamp)).toEqual([created+1,created+3]);
    expect(detail.aiRecords).toHaveLength(1);
    const catalog=await(await app.request(`/admin/visualize/sessions/${code}/accounts`,{headers:admin})).json();
    expect(catalog.accounts[0]).toMatchObject({eventCount:2,promptTurnsCount:1});
    const {createSummaryArchive}=await import("../src/services/summaryArchive");
    const zip=new AdmZip(await createSummaryArchive(code,temp));
    expect(zip.readAsText("S1/exam_records/R1/events.jsonl")).toBe(event(1));
    expect(zip.readAsText("S1/exam_records/R1/ai_interactions.jsonl")).toBe(remote["exam_records/R1/ai_interactions.jsonl"]);
    expect(zip.readAsText("S1/exam_records/R2/events.jsonl")).toBe(event(3));
  }finally{spies.forEach(s=>s.mockRestore());fs.rmSync(temp,{recursive:true,force:true});f.cleanup();}
});
