import fs from "fs";
import path from "path";
import crypto from "crypto";
import { decryptLogFile } from "./secureLogger";

const LOG_ENCRYPT_KEY = (process.env.LOG_ENCRYPT_KEY || "").trim();

interface PromptTurnRecord {
  timestamp: string;
  createdAt?: string;
  completedAt?: string;
  responseDurationMs?: number;
  conversationId?: string;
  prompt: string;
  output?: string;
  classification?: any;
  aiOption?: string;
  tokenLimit?: number;
  tokensConsumedTotal?: number;
  agentLoops?: any[];
  history?: any[];
  codeSnapshot?: string;
  activeFilePath?: string;
  activeFileLanguageId?: string;
  codeSnapshots?: any[];
  terminalOutput?: string;
  lastTerminalCommand?: string;
  [key: string]: any;
}

export async function atomicWriteJson(
  filePath: string,
  data: any,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const content = JSON.stringify(data, null, 2);
  await fs.promises.writeFile(tmpPath, content, "utf-8");
  await fs.promises.rename(tmpPath, filePath);
}

export function safeParseJson<T = any>(raw: string): T | null {
  if (!raw) return null;
  const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  try {
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

export function isGhostPromptTurn(turn: PromptTurnRecord): boolean {
  if (!turn) return false;
  const p = (turn.prompt || "").toString();
  return (
    p.includes("Text before cursor:") ||
    p.includes("Text after cursor:") ||
    p.includes("You complete code. Return ONLY the completion") ||
    p.startsWith("Complete:\n")
  );
}

export async function reconcileStudentPromptTurns(
  sessionCode: string,
  studentId: string,
  sessionDir: string,
): Promise<{
  turns: PromptTurnRecord[];
  wasRepaired: boolean;
  source: string;
}> {
  const safeStudentId = studentId.toUpperCase();
  let jsonPath = path.join(sessionDir, `${safeStudentId}.json`);
  let logPath = path.join(sessionDir, `${safeStudentId}.log`);
  let studentDir = path.join(sessionDir, safeStudentId);

  if (fs.existsSync(sessionDir)) {
    try {
      const entries = await fs.promises.readdir(sessionDir);
      for (const e of entries) {
        const lower = e.toLowerCase();
        if (
          lower === `${safeStudentId.toLowerCase()}.json` &&
          !fs.existsSync(jsonPath)
        ) {
          jsonPath = path.join(sessionDir, e);
        } else if (
          lower === `${safeStudentId.toLowerCase()}.log` &&
          !fs.existsSync(logPath)
        ) {
          logPath = path.join(sessionDir, e);
        } else if (
          lower === safeStudentId.toLowerCase() &&
          !fs.existsSync(studentDir)
        ) {
          studentDir = path.join(sessionDir, e);
        }
      }
    } catch {}
  }


  let existingTurns: PromptTurnRecord[] = [];
  let hadExistingGhostTurns = false;
  if (fs.existsSync(jsonPath)) {
    try {
      const raw = await fs.promises.readFile(jsonPath, "utf-8");
      const parsed = safeParseJson(raw);
      if (Array.isArray(parsed)) {
        const initialCount = parsed.length;
        existingTurns = parsed.filter((t) => !isGhostPromptTurn(t));
        hadExistingGhostTurns = existingTurns.length < initialCount;
      }
    } catch {}
  }

  let logTurns: PromptTurnRecord[] = [];
  if (fs.existsSync(logPath)) {
    try {
      const candidateKeys = [
        LOG_ENCRYPT_KEY,
        (process.env.CUSTOM_API_KEY || "").trim(),
        "1234",
        "secret",
      ].filter(Boolean);

      for (const key of candidateKeys) {
        try {
          const decrypted = decryptLogFile(logPath, key) as any[];
          const valid = decrypted.filter(
            (t) =>
              t &&
              !t._error &&
              (t.prompt || t.tokensConsumedTotal) &&
              !isGhostPromptTurn(t),
          );
          if (valid.length > 0) {
            logTurns = valid;
            break;
          }
        } catch {}
      }
    } catch {}
  }

  let aiInteractions: any[] = [];
  const examRecordsDir = path.join(studentDir, "exam_records");
  if (fs.existsSync(examRecordsDir)) {
    try {
      const subEntries = await fs.promises.readdir(examRecordsDir, {
        withFileTypes: true,
      });
      for (const sub of subEntries) {
        if (sub.isDirectory()) {
          const aiPath = path.join(
            examRecordsDir,
            sub.name,
            "ai_interactions.jsonl",
          );
          if (fs.existsSync(aiPath)) {
            const raw = await fs.promises.readFile(aiPath, "utf-8");
            for (const line of raw.split("\n")) {
              const trimmed = line.trim();
              if (trimmed) {
                try {
                  aiInteractions.push(JSON.parse(trimmed));
                } catch {}
              }
            }
          }
        }
      }
    } catch {}
  }

  const clientRequests = aiInteractions.filter(
    (e) => e.type === "chat_request",
  );
  const clientResponses = aiInteractions.filter(
    (e) => e.type === "chat_response_complete",
  );

  const clientRespsByReqId = new Map<string, any>();
  for (const resp of clientResponses) {
    const reqId = resp.payload?.requestId;
    if (reqId) {
      clientRespsByReqId.set(reqId, resp);
    }
  }

  let sessionDateStr: string | null = null;
  const uploadInfoPath = path.join(studentDir, "upload_info.json");
  if (fs.existsSync(uploadInfoPath)) {
    try {
      const uInfo = JSON.parse(
        await fs.promises.readFile(uploadInfoPath, "utf-8"),
      );
      if (uInfo.uploadTimeISO) {
        sessionDateStr = uInfo.uploadTimeISO.split("T")[0];
      }
    } catch {}
  }

  const relevantClientRequests: any[] = [];
  for (let i = 0; i < clientRequests.length; i++) {
    const req = clientRequests[i];
    if (sessionDateStr && req.timestamp) {
      const dt = new Date(req.timestamp);
      const reqDateStr = dt.toISOString().split("T")[0];
      if (reqDateStr === sessionDateStr) {
        relevantClientRequests.push(req);
      }
    } else {
      relevantClientRequests.push(req);
    }
  }

  const maxAvailableTurns = Math.max(
    existingTurns.length,
    logTurns.length,
    relevantClientRequests.length,
  );

  if (existingTurns.length >= maxAvailableTurns && existingTurns.length > 0) {
    let modified = hadExistingGhostTurns;
    for (let i = 0; i < existingTurns.length; i++) {
      const turn = existingTurns[i];
      if (
        !turn.createdAt ||
        !turn.completedAt ||
        typeof turn.responseDurationMs !== "number"
      ) {
        const matchingReq =
          relevantClientRequests.find(
            (r) =>
              r.payload?.prompt === turn.prompt ||
              (turn.prompt &&
                r.payload?.messages?.some(
                  (m: any) => m.role === "user" && m.content === turn.prompt,
                )),
          ) || relevantClientRequests[i];

        const reqId = matchingReq?.payload?.requestId;
        const matchingResp = reqId ? clientRespsByReqId.get(reqId) : null;

        let createdMs = matchingReq?.timestamp;
        if (reqId && reqId.startsWith("chat-")) {
          const parsed = parseInt(reqId.split("-")[1], 10);
          if (!isNaN(parsed) && parsed > 1000000000000) {
            createdMs = parsed;
          }
        }
        if (!createdMs && turn.timestamp) {
          createdMs = new Date(turn.timestamp).getTime();
        }

        const completedMs =
          matchingResp?.timestamp ||
          (turn.lastUpdated
            ? new Date(turn.lastUpdated).getTime()
            : turn.timestamp
              ? new Date(turn.timestamp).getTime()
              : createdMs
                ? createdMs + 5000
                : Date.now());
        const durationMs =
          createdMs && completedMs ? Math.max(0, completedMs - createdMs) : 0;

        if (!turn.createdAt && createdMs)
          turn.createdAt = new Date(createdMs).toISOString();
        if (!turn.completedAt && completedMs)
          turn.completedAt = new Date(completedMs).toISOString();
        if (typeof turn.responseDurationMs !== "number")
          turn.responseDurationMs = durationMs;
        modified = true;
      }
    }

    const totalTokens = existingTurns.reduce(
      (acc, t) => acc + (t.tokensConsumedTotal || 0),
      0,
    );

    if (modified) {
      try {
        if (hadExistingGhostTurns && fs.existsSync(jsonPath)) {
          const bakPath = `${jsonPath}.bak.${Date.now()}`;
          try {
            await fs.promises.copyFile(jsonPath, bakPath);
          } catch {}
        }
        await atomicWriteJson(jsonPath, existingTurns);

        // Synchronize tokens consumed in session_manifest.json
        const manifestPath = path.join(sessionDir, "session_manifest.json");
        if (fs.existsSync(manifestPath)) {
          try {
            const mRaw = await fs.promises.readFile(manifestPath, "utf-8");
            const mJson = safeParseJson(mRaw);
            if (mJson && Array.isArray(mJson.students)) {
              const sItem = mJson.students.find(
                (s: any) =>
                  s.studentId &&
                  s.studentId.toUpperCase() === safeStudentId,
              );
              if (sItem) {
                sItem.tokensConsumed = totalTokens;
                sItem.promptTurns = existingTurns.length;
                await atomicWriteJson(manifestPath, mJson);
              }
            }
          } catch {}
        }
      } catch {}
    }

    // Always synchronize SQLite table session_states and Redis if tokens differ
    try {
      const { sessionStates } = await import("./sessionStore");
      const stateKey = `${sessionCode.toUpperCase()}:${safeStudentId}`;
      const st = sessionStates.get(stateKey);
      if (st && (st.tokensConsumed !== totalTokens || modified)) {
        st.tokensConsumed = totalTokens;
        st.promptCount = existingTurns.length;
        sessionStates.set(stateKey, st); // Persist to SQLite
        const { redis } = await import("./redis");
        if (redis && redis.status === "ready") {
          await redis.hset(
            `session:user:${sessionCode.toUpperCase()}:${safeStudentId}`,
            "consumed",
            String(totalTokens),
          );
        }
      }
    } catch {}

    return {
      turns: existingTurns,
      wasRepaired: modified,
      source: hadExistingGhostTurns ? "sanitized_ghost_turns" : "json",
    };
  }

  let synthesizedTurns: PromptTurnRecord[] = [];

  if (relevantClientRequests.length > 0) {
    for (let i = 0; i < relevantClientRequests.length; i++) {
      const req = relevantClientRequests[i];
      const reqPayload = req.payload || {};
      const reqId = reqPayload.requestId;
      const resp =
        (reqId ? clientRespsByReqId.get(reqId) : null) ||
        clientResponses[i] ||
        {};
      const respPayload = resp.payload || {};

      let promptText = reqPayload.prompt || reqPayload.message || "";
      if (
        !promptText &&
        Array.isArray(reqPayload.messages) &&
        reqPayload.messages.length > 0
      ) {
        const userMsgs = reqPayload.messages.filter(
          (m: any) => m.role === "user",
        );
        promptText =
          userMsgs.length > 0
            ? userMsgs[userMsgs.length - 1].content || ""
            : reqPayload.messages[reqPayload.messages.length - 1].content || "";
      }

      const totalTokens =
        respPayload.tokenUsage?.totalTokens ||
        (respPayload.tokenUsage?.promptTokens || 0) +
          (respPayload.tokenUsage?.completionTokens || 0) ||
        0;

      const matchedTurn =
        existingTurns.find(
          (et) =>
            et.prompt === promptText ||
            (promptText &&
              et.prompt &&
              (et.prompt.startsWith(promptText.slice(0, 30)) ||
                promptText.startsWith(et.prompt.slice(0, 30)))),
        ) ||
        logTurns.find(
          (lt) =>
            lt.prompt === promptText ||
            (promptText &&
              lt.prompt &&
              (lt.prompt.startsWith(promptText.slice(0, 30)) ||
                promptText.startsWith(lt.prompt.slice(0, 30)))),
        ) ||
        existingTurns[i] ||
        logTurns[i];

      let createdMs =
        typeof req.timestamp === "number" ? req.timestamp : Date.now();
      if (reqId && reqId.startsWith("chat-")) {
        const parsed = parseInt(reqId.split("-")[1], 10);
        if (!isNaN(parsed) && parsed > 1000000000000) {
          createdMs = parsed;
        }
      }
      const completedMs =
        typeof resp.timestamp === "number"
          ? resp.timestamp
          : matchedTurn?.lastUpdated
            ? new Date(matchedTurn.lastUpdated).getTime()
            : createdMs + 5000;
      const responseDurationMs = Math.max(0, completedMs - createdMs);
      const createdAt = new Date(createdMs).toISOString();
      const completedAt = new Date(completedMs).toISOString();

      const turnObj: PromptTurnRecord = {
        timestamp: completedAt,
        createdAt,
        completedAt,
        responseDurationMs,
        conversationId:
          reqPayload.conversationId || matchedTurn?.conversationId,
        prompt: promptText,
        output:
          respPayload.text || respPayload.content || matchedTurn?.output || "",
        classification: matchedTurn?.classification || {
          label: "mixed",
          currentLabel: "mixed",
          confidence: 0.85,
        },
        aiOption: matchedTurn?.aiOption || "mixed",
        tokensConsumedTotal:
          totalTokens || matchedTurn?.tokensConsumedTotal || 0,
        tokenLimit: matchedTurn?.tokenLimit,
        agentLoops: matchedTurn?.agentLoops || [],
        history: matchedTurn?.history || reqPayload.messages || [],
        codeSnapshot: matchedTurn?.codeSnapshot,
        activeFilePath:
          reqPayload.activeDocumentUri || matchedTurn?.activeFilePath,
        activeFileLanguageId: matchedTurn?.activeFileLanguageId,
        codeSnapshots: matchedTurn?.codeSnapshots,
        terminalOutput: matchedTurn?.terminalOutput,
        lastTerminalCommand: matchedTurn?.lastTerminalCommand,
      };

      synthesizedTurns.push(turnObj);
    }
  } else if (logTurns.length > existingTurns.length) {
    synthesizedTurns = logTurns;
  } else {
    synthesizedTurns = existingTurns;
  }

  for (const turn of synthesizedTurns) {
    if (!turn.createdAt && turn.timestamp) turn.createdAt = turn.timestamp;
    if (!turn.completedAt)
      turn.completedAt = turn.lastUpdated || turn.timestamp;
    if (
      typeof turn.responseDurationMs !== "number" &&
      turn.createdAt &&
      turn.completedAt
    ) {
      const s = new Date(turn.createdAt).getTime();
      const e = new Date(turn.completedAt).getTime();
      turn.responseDurationMs = !isNaN(s) && !isNaN(e) ? Math.max(0, e - s) : 0;
    }
  }

  if (synthesizedTurns.length > existingTurns.length) {
    try {
      await atomicWriteJson(jsonPath, synthesizedTurns);
      const totalTokens = synthesizedTurns.reduce(
        (acc, t) => acc + (t.tokensConsumedTotal || 0),
        0,
      );
      const manifestPath = path.join(sessionDir, "session_manifest.json");
      if (fs.existsSync(manifestPath)) {
        try {
          const mRaw = await fs.promises.readFile(manifestPath, "utf-8");
          const mJson = safeParseJson(mRaw);
          if (mJson && Array.isArray(mJson.students)) {
            const sItem = mJson.students.find(
              (s: any) =>
                s.studentId &&
                s.studentId.toUpperCase() === safeStudentId,
            );
            if (sItem) {
              sItem.tokensConsumed = totalTokens;
              sItem.promptTurns = synthesizedTurns.length;
              await atomicWriteJson(manifestPath, mJson);
            }
          }
        } catch {}
      }

      // Synchronize in SQLite memory & table and Redis
      try {
        const { sessionStates } = await import("./sessionStore");
        const stateKey = `${sessionCode.toUpperCase()}:${safeStudentId}`;
        const st = sessionStates.get(stateKey);
        if (st) {
          st.tokensConsumed = totalTokens;
          st.promptCount = synthesizedTurns.length;
          sessionStates.set(stateKey, st); // Persist to SQLite
        }
        const { redis } = await import("./redis");
        if (redis && redis.status === "ready") {
          await redis.hset(
            `session:user:${sessionCode.toUpperCase()}:${safeStudentId}`,
            "consumed",
            String(totalTokens),
          );
        }
      } catch {}
      return {
        turns: synthesizedTurns,
        wasRepaired: true,
        source: "reconciled",
      };
    } catch (err) {
      console.error(
        `[TelemetryMigration] Failed to write repaired JSON to ${jsonPath}:`,
        err,
      );
    }
  }

  return {
    turns: synthesizedTurns.length > 0 ? synthesizedTurns : existingTurns,
    wasRepaired: false,
    source: "fallback",
  };
}

export async function runTelemetryMigration(): Promise<void> {
  const sessionsBaseDir = path.resolve(process.cwd(), "logs", "sessions");
  if (!fs.existsSync(sessionsBaseDir)) return;

  try {
    const sessionEntries = await fs.promises.readdir(sessionsBaseDir, {
      withFileTypes: true,
    });
    let totalRepaired = 0;

    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) continue;
      const sessionCode = sessionEntry.name.toUpperCase();
      const sessionDir = path.join(sessionsBaseDir, sessionEntry.name);

      const files = await fs.promises.readdir(sessionDir);
      const studentIds = new Set<string>();

      for (const f of files) {
        if (f.endsWith(".json") && !f.includes("manifest")) {
          studentIds.add(f.replace(/\.json$/, "").toUpperCase());
        } else if (f.endsWith(".log")) {
          studentIds.add(f.replace(/\.log$/, "").toUpperCase());
        } else {
          const subPath = path.join(sessionDir, f);
          try {
            const stat = fs.statSync(subPath);
            if (stat.isDirectory()) {
              studentIds.add(f.toUpperCase());
            }
          } catch {}
        }
      }

      for (const studentId of studentIds) {
        try {
          const res = await reconcileStudentPromptTurns(
            sessionCode,
            studentId,
            sessionDir,
          );
          if (res.wasRepaired) {
            totalRepaired++;
            const totalTokens = res.turns.reduce(
              (acc, t) => acc + (t.tokensConsumedTotal || 0),
              0,
            );
            console.log(
              `[TelemetryMigration] [OK] Repaired session ${sessionCode}/${studentId}: upgraded to ${res.turns.length} turns (${totalTokens.toLocaleString()} tokens).`,
            );
          }
        } catch (err: any) {
          console.warn(
            `[TelemetryMigration] Warning for ${sessionCode}/${studentId}:`,
            err?.message || err,
          );
        }
        // Check and sync session_manifest.json if present
        const manifestPath = path.join(sessionDir, "session_manifest.json");
        if (fs.existsSync(manifestPath)) {
          try {
            const mRaw = await fs.promises.readFile(manifestPath, "utf-8");
            const mJson = safeParseJson(mRaw);
            if (mJson && Array.isArray(mJson.students)) {
              const { sessionStates } = await import("./sessionStore");
              const { redis } = await import("./redis");
              for (const sItem of mJson.students) {
                if (!sItem.studentId || typeof sItem.tokensConsumed !== "number") continue;
                const safeSid = sItem.studentId.toUpperCase();
                const stateKey = `${sessionCode}:${safeSid}`;
                const st = sessionStates.get(stateKey);
                if (st && st.tokensConsumed !== sItem.tokensConsumed) {
                  console.log(
                    `[TelemetryMigration] [Manifest Sync] ${stateKey}: tokens ${st.tokensConsumed} -> ${sItem.tokensConsumed}`,
                  );
                  st.tokensConsumed = sItem.tokensConsumed;
                  if (typeof sItem.promptTurns === "number") st.promptCount = sItem.promptTurns;
                  sessionStates.set(stateKey, st);
                  if (redis && redis.status === "ready") {
                    await redis.hset(`session:user:${sessionCode}:${safeSid}`, "consumed", String(sItem.tokensConsumed));
                  }
                }
              }
            }
          } catch {}
        }
      }
    }

    // Also check for any session zip files in process.cwd(), logs/, or parent dir
    try {
      const searchDirs = [
        process.cwd(),
        path.resolve(process.cwd(), "logs"),
        path.resolve(process.cwd(), ".."),
      ];
      const { sessionStates } = await import("./sessionStore");
      const { redis } = await import("./redis");
      const AdmZip = (await import("adm-zip")).default;

      for (const d of searchDirs) {
        if (!fs.existsSync(d)) continue;
        const dFiles = await fs.promises.readdir(d);
        for (const df of dFiles) {
          if (!df.endsWith(".zip") || (!df.includes("SS-") && !df.includes("logs"))) continue;
          try {
            const zipPath = path.join(d, df);
            const zip = new AdmZip(zipPath);
            let zipModified = false;

            // Audit each JSON file inside the zip for ghost turns
            const zipEntries = zip.getEntries();
            const studentTokenMap = new Map<string, number>();
            const studentTurnsMap = new Map<string, number>();

            for (const entry of zipEntries) {
              if (entry.isDirectory || !entry.name.endsWith(".json") || entry.name.includes("manifest")) continue;
              const sId = entry.name.replace(/\.json$/, "").toUpperCase();
              try {
                const parsed = safeParseJson(entry.getData().toString("utf-8"));
                if (Array.isArray(parsed)) {
                  const cleaned = parsed.filter((t: any) => !isGhostPromptTurn(t));
                  const tokens = cleaned.reduce((acc: number, t: any) => acc + (t.tokensConsumedTotal || 0), 0);
                  studentTokenMap.set(sId, tokens);
                  studentTurnsMap.set(sId, cleaned.length);
                  if (cleaned.length < parsed.length) {
                    zip.updateFile(entry.entryName, Buffer.from(JSON.stringify(cleaned, null, 2), "utf-8"));
                    zipModified = true;
                  }
                }
              } catch {}
            }

            const mEntry = zip.getEntry("session_manifest.json");
            if (mEntry) {
              const mJson = safeParseJson(mEntry.getData().toString("utf-8"));
              if (mJson && mJson.sessionCode && Array.isArray(mJson.students)) {
                const sCode = mJson.sessionCode.toUpperCase();
                for (const sItem of mJson.students) {
                  if (!sItem.studentId) continue;
                  const safeSid = sItem.studentId.toUpperCase();
                  if (studentTokenMap.has(safeSid)) {
                    const cleanTokens = studentTokenMap.get(safeSid)!;
                    if (sItem.tokensConsumed !== cleanTokens) {
                      sItem.tokensConsumed = cleanTokens;
                      sItem.promptTurns = studentTurnsMap.get(safeSid) || sItem.promptTurns;
                      zipModified = true;
                    }
                  }
                  if (typeof sItem.tokensConsumed !== "number") continue;
                  const stateKey = `${sCode}:${safeSid}`;
                  const st = sessionStates.get(stateKey);
                  if (st && st.tokensConsumed !== sItem.tokensConsumed) {
                    console.log(
                      `[TelemetryMigration] [Zip Sync] Synchronizing ${stateKey}: ${st.tokensConsumed} -> ${sItem.tokensConsumed}`,
                    );
                    st.tokensConsumed = sItem.tokensConsumed;
                    if (typeof sItem.promptTurns === "number") st.promptCount = sItem.promptTurns;
                    sessionStates.set(stateKey, st);
                    if (redis && redis.status === "ready") {
                      await redis.hset(`session:user:${sCode}:${safeSid}`, "consumed", String(sItem.tokensConsumed));
                    }
                  }
                }
                if (zipModified) {
                  zip.updateFile("session_manifest.json", Buffer.from(JSON.stringify(mJson, null, 2), "utf-8"));
                }
              }
            }

            if (zipModified) {
              zip.writeZip(zipPath);
            }
          } catch {}
        }
      }
    } catch {}

    if (totalRepaired > 0) {
      console.log(
        `[TelemetryMigration] Complete: Successfully audited and repaired ${totalRepaired} student log(s).`,
      );
    } else {
      console.log(
        `[TelemetryMigration] Audit complete: All session logs on disk are fully synchronized.`,
      );
    }
  } catch (err) {
    console.error("[TelemetryMigration] Migration run error:", err);
  }
}
