import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";

if (process.env.PROXY_REFACTOR_SANDBOX !== "1") throw new Error("Use scripts/test-isolated.ts");
const { adminRouter } = await import("../src/routes/admin");
const { sessions, sessionStates } = await import("../src/services/sessionStore");
const { s3Storage } = await import("../src/services/s3Storage");
const { redisStore } = await import("../src/services/classifier/redisStore");
const app = new Hono();
app.route("/admin", adminRouter);
app.route("/v1/admin", adminRouter);
const headers = { Authorization: `Bearer ${process.env.PROXY_API_KEY}` };
const time = 1700000000000;

function fixture(code: string) {
  const directory = path.join(process.cwd(), "logs", "sessions", code);
  sessions.set(code, { sessionCode: code, createdBy: "admin", createdAt: time, startTime: time / 1000,
    durationMinutes: 60, aiOption: "agent", aiValidityMinutes: 60, defaultTokenBudget: 1000,
    allowedStudentIds: new Set(["SELOCAL", "SEMEMORY"]) });
  for (const studentId of ["SELOCAL", "SEEVENTS", "SEWINDOW", "SERECORD", "SENEW"]) {
    sessionStates.set(`${code}:${studentId}`, { sessionCode: code, studentId, loginTimestamp: time / 1000,
      hasLoggedIn: true, reassigned: false, tokensConsumed: 99 });
  }
  return {
    directory,
    write(name: string, text: string) {
      const target = path.join(directory, name); fs.mkdirSync(path.dirname(target), {recursive:true}); fs.writeFileSync(target, text);
    },
    cleanup() { sessions.delete(code); fs.rmSync(directory, {recursive:true,force:true}); },
  };
}
for (const [index, prefix] of ["/admin", "/v1/admin"].entries()) {
  test(`${prefix}: catalog counts parsed session records instead of stale upload metrics`, async () => {
    const code=`VIS_ACCOUNTS_${index}`, data=fixture(code);
    data.write("SELOCAL.json", JSON.stringify([{timestamp:time+1,prompt:"first"},{timestamp:time+2,prompt:"second",error:"fixture"}]));
    data.write("SELOCAL/upload_info.json", JSON.stringify({metrics:{inWindowEvents:7}}));
    data.write("SELOCAL/events.jsonl", JSON.stringify({timestamp:time+1,type:"save"}));
    data.write("SELOCAL/ai_interactions.jsonl", ["first", "second"].map((prompt, i) => JSON.stringify({timestamp:time+i+1,type:"chat_request",payload:{requestId:`chat-${time+i+1}-${prompt}`,prompt}})).join("\n"));
    data.write("SEEVENTS/exam_records/R/events.jsonl", [time-1,time+1,time+3600001].map(timestamp=>JSON.stringify({timestamp})).join("\n")+"\ncorrupt\n");
    try {
      expect((await app.request(`${prefix}/visualize/sessions/${code}/accounts`)).status).toBe(401);
      const body=await (await app.request(`${prefix}/visualize/sessions/${code}/accounts`,{headers})).json();
      expect(body.accounts).toHaveLength(3);
      expect(body.accounts.find((x:any)=>x.studentId==="SELOCAL")).toMatchObject({hasPromptLog:true,hasEventLog:true,promptTurnsCount:2,eventCount:1,hasErrors:false});
      expect(body.accounts.find((x:any)=>x.studentId==="SEEVENTS")).toMatchObject({eventCount:1});
      expect(body.accounts.find((x:any)=>x.studentId==="SEMEMORY")).toMatchObject({eventCount:0,promptTurnsCount:0,validityWindow:{status:"unresolved"}});
    } finally { data.cleanup(); }
  });
  test(`${prefix}: zero in-window count stays zero when all events are late`, async () => {
    const code=`VIS_SCHEDULE_${index}`,data=fixture(code);
    data.write("SEWINDOW/upload_info.json",JSON.stringify({metrics:{inWindowEvents:99},validityWindow:{signinTimestamp:time,expireTimestamp:time+7200000}}));
    data.write("SEWINDOW/exam_records/R/events.jsonl",JSON.stringify({timestamp:time+3600001}));
    try {
      const body=await (await app.request(`${prefix}/visualize/sessions/${code}/accounts`,{headers})).json();
      expect(body.accounts.find((x:any)=>x.studentId==="SEWINDOW").eventCount).toBe(0);
    } finally {data.cleanup();}
  });
  test(`${prefix}: S3 count uses the same strict window and parsed events as detail`,async()=>{
    const code=`VIS_REMOTE_ACCOUNTS_${index}`,data=fixture(code);
    const spies=[
      spyOn(s3Storage,"isAvailable").mockReturnValue(true),
      spyOn(s3Storage,"getSessionManifest").mockResolvedValue(null),
      spyOn(s3Storage,"listStudentsInSessionFromS3").mockResolvedValue([{studentId:"SERECORD",hasPromptLog:false,hasEventLog:true}]),
      spyOn(s3Storage,"getStudentFile").mockResolvedValue(JSON.stringify({metrics:{inWindowEvents:99},validityWindow:{signinTimestamp:time}})),
      spyOn(s3Storage,"listStudentExamRecords").mockImplementation(async(_c,id)=>id==="SERECORD"?["R"]:[]),
      spyOn(s3Storage,"getExamRecordArtifact").mockImplementation(async(_c,_s,_r,name)=>name==="events.jsonl"?[JSON.stringify({timestamp:time+1}),"corrupt",JSON.stringify({timestamp:time+3600001})].join("\n"):null),
      spyOn(s3Storage,"getStudentPromptLog").mockResolvedValue(null),
    ];
    try{
      const body=await(await app.request(`${prefix}/visualize/sessions/${code}/accounts`,{headers})).json();
      const detail=await(await app.request(`${prefix}/visualize/sessions/${code}/accounts/SERECORD/event-log`,{headers})).json();
      expect(body.accounts.find((x:any)=>x.studentId==="SERECORD").eventCount).toBe(1);
      expect(detail.coreRecords).toHaveLength(1);
    }finally{spies.forEach(s=>s.mockRestore());data.cleanup();}
  });
  test(`${prefix}: Prompt Log uses monitor chat requests without changing proxy evidence`,async()=>{
    const code=`VIS_PROMPTS_${index}`,data=fixture(code);
    const original=JSON.stringify([{timestamp:time+1,createdAt:time+1,prompt:"existing",tokensConsumedTotal:10,classification:{features:{retained:1}}},
      {timestamp:time+2,prompt:"missing",tokensConsumedTotal:6}]);
    data.write("SELOCAL.json",original);
    data.write("SELOCAL/ai_interactions.jsonl",[
      {timestamp:time+1,type:"chat_request",payload:{requestId:`chat-${time+1}-existing`,prompt:"monitor prompt"}},
      {timestamp:time+2,type:"chat_response_complete",payload:{requestId:`chat-${time+1}-existing`,text:"monitor response",tokenUsage:{totalTokens:12}}},
    ].map(record=>JSON.stringify(record)).join("\n"));
    const cached=spyOn(redisStore,"getTurns").mockResolvedValue([{prompt:"missing",featureVector:{added:1}}] as any);
    try{
      const body=await(await app.request(`${prefix}/visualize/sessions/${code}/accounts/SELOCAL/prompt-log`,{headers})).json();
      expect(body.turns).toHaveLength(1);
      expect(body.turns[0]).toMatchObject({prompt:"monitor prompt",output:"monitor response",tokensConsumedTotal:12,source:"client_reconstructed"});
      expect(body.turns[0].classification).toBeUndefined();
      expect(sessionStates.get(`${code}:SELOCAL`)!.tokensConsumed).toBe(99);
      expect(fs.readFileSync(path.join(data.directory,"SELOCAL.json"),"utf8")).toBe(original);
      expect(cached).not.toHaveBeenCalled();
    }finally{cached.mockRestore();data.cleanup();}
  });
}
