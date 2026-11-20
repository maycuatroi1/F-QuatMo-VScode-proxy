import { requireCaller } from "../../shared/http/adminCaller";
import { hasSessionParticipation } from "./statePolicy";
import { redis } from "../../services/redis";
import { toMs } from "../../shared/sessionTime";
import {
  sessions, sessionStates, studentGroups,
  type Session, type StudentSessionState, type SessionRuntimeConfig, type SessionPromptMode,
} from "../../services/sessionStore";

export async function createSession(c: any) {
  const caller = requireCaller(c);
  const body = await c.req.json();
  const {
    durationMinutes,
    aiOption,
    aiValidityMinutes,
    defaultTokenBudget,
    assignedGroups,
    sessionType,
    sessionPrompt,
    promptMode,
    examQuestions,
    runtimeConfig,
  } = body as {
    durationMinutes?: number;
    aiOption?: "chatbot" | "agent" | "none";
    aiValidityMinutes?: number;
    defaultTokenBudget?: number;
    assignedGroups?: string[];
    sessionType?: "basic" | "exam";
    sessionPrompt?: string;
    promptMode?: SessionPromptMode;
    examQuestions?: any[];
    runtimeConfig?: SessionRuntimeConfig;
  };

  if (
    !durationMinutes ||
    !aiOption ||
    aiValidityMinutes === undefined ||
    !defaultTokenBudget
  ) {
    return c.json(
      {
        error:
          "Missing required fields: durationMinutes, aiOption, aiValidityMinutes, defaultTokenBudget",
      },
      400,
    );
  }

  const validPromptModes: SessionPromptMode[] = [
    "standard",
    "scaffolded_code",
    "socratic_tutor",
  ];
  const validatedPromptMode: SessionPromptMode =
    promptMode && validPromptModes.includes(promptMode)
      ? promptMode
      : "scaffolded_code";

  let sessionCode = "";
  do {
    const chars = "ABCDEFGHJKLMNOPQRSTUVWXYZ23456789";
    let code = "SS-";
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    if (!sessions.has(code)) {
      sessionCode = code;
    }
  } while (!sessionCode);

  const allowedStudentIds = new Set<string>();
  const groupNames: string[] = [];

  // Resolve student IDs from assigned groups
  if (Array.isArray(assignedGroups) && assignedGroups.length > 0) {
    for (const rawName of assignedGroups) {
      const groupName = String(rawName).trim();
      if (!groupName) continue;
      groupNames.push(groupName);

      const groupKey = `${groupName}:${caller.username.toLowerCase()}`;
      let group = studentGroups.get(groupKey);
      if (!group) {
        group = studentGroups.get(`${groupName}:admin`);
      }
      if (!group) {
        for (const g of studentGroups.values()) {
          if (
            g.name.toLowerCase() === groupName.toLowerCase() &&
            (g.createdBy || "admin").toLowerCase() ===
              caller.username.toLowerCase()
          ) {
            group = g;
            break;
          }
        }
      }
      if (!group) {
        for (const g of studentGroups.values()) {
          if (g.name.toLowerCase() === groupName.toLowerCase()) {
            group = g;
            break;
          }
        }
      }

      if (group && Array.isArray(group.userIds)) {
        for (const uid of group.userIds) {
          const upperId = uid.toUpperCase();
          allowedStudentIds.add(upperId);
        }
      }
    }
  }

  const now = Date.now();
  const newSession: Session = {
    sessionCode,
    startTime: Math.floor(now / 1000),
    durationMinutes,
    aiOption,
    aiValidityMinutes,
    defaultTokenBudget,
    allowedStudentIds,
    assignedGroups: groupNames,
    sessionType: sessionType || "basic",
    sessionPrompt: sessionPrompt || "",
    promptMode: validatedPromptMode,
    examQuestions: Array.isArray(examQuestions) ? examQuestions : [],
    runtimeConfig:
      runtimeConfig && typeof runtimeConfig === "object"
        ? runtimeConfig
        : undefined,
    createdAt: now,
    createdBy: caller.username,
    updatedAt: now,
    updatedBy: caller.username,
  };

  // Initialize sessionStates for all resolved group member students
  for (const studentId of allowedStudentIds) {
    const stateKey = `${sessionCode}:${studentId}`;
    if (!sessionStates.has(stateKey)) {
      const initialState: StudentSessionState = {
        sessionCode,
        studentId,
        hasLoggedIn: false,
        loginTimestamp: 0,
        tokensConsumed: 0,
        reassigned: false,
      };
      sessionStates.set(stateKey, initialState);
    }
  }

  sessions.set(sessionCode, newSession);

  return c.json({
    success: true,
    sessionCode,
    session: {
      ...newSession,
      allowedStudentIds: Array.from(allowedStudentIds),
      assignedGroups: groupNames,
    },
  });
}

export async function updateSession(c: any) {
  const caller = requireCaller(c);
  const sessionCode = c.req.param("sessionCode").toUpperCase();
  const session = sessions.get(sessionCode);

  if (!session) {
    return c.json(
      { error: `Session with code ${sessionCode} not found.` },
      404,
    );
  }

  // Authorization: admin or creator of session
  if (
    caller.role !== "admin" &&
    (session.createdBy || "admin").toLowerCase() !==
      caller.username.toLowerCase()
  ) {
    return c.json(
      { error: "Unauthorized. You can only update sessions created by you." },
      403,
    );
  }

  const body = await c.req.json();
  const {
    durationMinutes,
    aiOption,
    aiValidityMinutes,
    defaultTokenBudget,
    sessionType,
    sessionPrompt,
    promptMode,
    examQuestions,
    runtimeConfig,
    assignedGroups,
    allowedStudentIds,
    createdBy,
  } = body as any;

  if (typeof durationMinutes === "number")
    session.durationMinutes = durationMinutes;
  if (
    typeof aiOption === "string" &&
    ["chatbot", "agent", "none"].includes(aiOption)
  )
    session.aiOption = aiOption as "chatbot" | "agent" | "none";
  if (typeof aiValidityMinutes === "number")
    session.aiValidityMinutes = aiValidityMinutes;
  if (typeof defaultTokenBudget === "number")
    session.defaultTokenBudget = defaultTokenBudget;
  if (sessionType === "basic" || sessionType === "exam")
    session.sessionType = sessionType;
  if (typeof sessionPrompt === "string") session.sessionPrompt = sessionPrompt;
  if (
    promptMode &&
    ["standard", "scaffolded_code", "socratic_tutor"].includes(promptMode)
  ) {
    session.promptMode = promptMode as SessionPromptMode;
  }
  if (Array.isArray(examQuestions)) session.examQuestions = examQuestions;
  if (runtimeConfig && typeof runtimeConfig === "object")
    session.runtimeConfig = runtimeConfig;

  // Flexible Assigned Groups
  if (Array.isArray(assignedGroups)) {
    session.assignedGroups = assignedGroups;
    for (const gName of assignedGroups) {
      const gMapKey = `${gName}:${(session.createdBy || "admin").toLowerCase()}`;
      const group =
        studentGroups.get(gMapKey) || studentGroups.get(`${gName}:admin`);
      if (group && Array.isArray(group.userIds)) {
        for (const uid of group.userIds) {
          const upperUid = uid.toUpperCase();
          session.allowedStudentIds.add(upperUid);
          const stateKey = `${sessionCode}:${upperUid}`;
          if (!sessionStates.has(stateKey)) {
            sessionStates.set(stateKey, {
              sessionCode,
              studentId: upperUid,
              hasLoggedIn: false,
              loginTimestamp: 0,
              tokensConsumed: 0,
              reassigned: false,
            });
          }
        }
      }
    }
  }

  // Flexible Allowed Students Management
  if (Array.isArray(allowedStudentIds)) {
    const newIdSet = new Set(
      allowedStudentIds
        .map((id: string) => String(id).trim().toUpperCase())
        .filter(Boolean),
    );

    // Also include members of assigned groups if any
    if (Array.isArray(session.assignedGroups)) {
      for (const gName of session.assignedGroups) {
        const gMapKey = `${gName}:${(session.createdBy || "admin").toLowerCase()}`;
        const group =
          studentGroups.get(gMapKey) || studentGroups.get(`${gName}:admin`);
        if (group && Array.isArray(group.userIds)) {
          for (const uid of group.userIds) {
            newIdSet.add(uid.toUpperCase());
          }
        }
      }
    }

    // Always preserve students who have already joined/logged in
    for (const state of sessionStates.values()) {
      if (state.sessionCode === sessionCode && hasSessionParticipation(state)) {
        newIdSet.add(state.studentId);
      }
    }

    // Clean up state for removed students who NEVER logged in
    for (const oldId of session.allowedStudentIds) {
      if (!newIdSet.has(oldId)) {
        const stateKey = `${sessionCode}:${oldId}`;
        const state = sessionStates.get(stateKey);
        if (!hasSessionParticipation(state)) {
          sessionStates.delete(stateKey);
        }
      }
    }

    // Initialize state for newly added students
    for (const newId of newIdSet) {
      const stateKey = `${sessionCode}:${newId}`;
      if (!sessionStates.has(stateKey)) {
        sessionStates.set(stateKey, {
          sessionCode,
          studentId: newId,
          hasLoggedIn: false,
          loginTimestamp: 0,
          tokensConsumed: 0,
          reassigned: false,
        });
      }
    }

    session.allowedStudentIds = newIdSet;
  }

  if (
    caller.role === "admin" &&
    typeof createdBy === "string" &&
    createdBy.trim()
  ) {
    session.createdBy = createdBy.trim();
  }

  session.updatedAt = Date.now();
  session.updatedBy = caller.username;
  sessions.set(sessionCode, session);

  return c.json({
    success: true,
    message: `Session ${sessionCode} updated successfully.`,
    session: {
      ...session,
      allowedStudentIds: Array.from(session.allowedStudentIds),
    },
  });
}

export async function deleteSession(c: any) {
  const caller = requireCaller(c);
  const sessionCode = c.req.param("sessionCode").toUpperCase();
  const session = sessions.get(sessionCode);

  if (!session) {
    return c.json(
      { error: `Session with code ${sessionCode} not found.` },
      404,
    );
  }

  // Authorization: admin or creator of session
  if (
    caller.role !== "admin" &&
    (session.createdBy || "admin").toLowerCase() !==
      caller.username.toLowerCase()
  ) {
    return c.json(
      { error: "Unauthorized. You can only delete sessions created by you." },
      403,
    );
  }

  // Condition: Check if any student has joined the session
  const hasAnyoneJoined = Array.from(sessionStates.values()).some(
    (state) => state.sessionCode === sessionCode && hasSessionParticipation(state),
  );

  if (hasAnyoneJoined) {
    return c.json(
      {
        error: `Cannot delete session ${sessionCode} because one or more students have already joined this session.`,
      },
      400,
    );
  }

  // Check Redis for active session states
  if (redis && redis.status === "ready") {
    try {
      const keys = await redis.keys(`session:user:${sessionCode}:*`);
      for (const k of keys) {
        const val = await redis.hget(k, "hasLoggedIn");
        if (val === "true") {
          return c.json(
            {
              error: `Cannot delete session ${sessionCode} because active student records exist in Redis.`,
            },
            400,
          );
        }
      }
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch (err) {
      console.warn(`[Admin] Redis cleanup warning on session delete:`, err);
    }
  }

  // Delete session from store (which cascades delete in SQLite and session_states)
  sessions.delete(sessionCode);

  return c.json({
    success: true,
    message: `Session ${sessionCode} deleted successfully.`,
    sessionCode,
  });
}

export async function removeSessionStudent(c: any) {
  const caller = requireCaller(c);
  const sessionCode = c.req.param("sessionCode").toUpperCase();
  const studentId = c.req.param("studentId").toUpperCase();
  const session = sessions.get(sessionCode);

  if (!session) {
    return c.json(
      { error: `Session with code ${sessionCode} not found.` },
      404,
    );
  }

  if (
    caller.role !== "admin" &&
    (session.createdBy || "admin").toLowerCase() !==
      caller.username.toLowerCase()
  ) {
    return c.json(
      { error: "Unauthorized. You can only manage sessions created by you." },
      403,
    );
  }

  const stateKey = `${sessionCode}:${studentId}`;
  const state = sessionStates.get(stateKey);

  if (hasSessionParticipation(state)) {
    return c.json(
      {
        error: `Cannot remove student ${studentId} because they have already joined this session.`,
      },
      400,
    );
  }

  session.allowedStudentIds.delete(studentId);
  session.updatedAt = Date.now();
  session.updatedBy = caller.username;
  sessions.set(sessionCode, session);

  if (state) {
    sessionStates.delete(stateKey);
  }

  return c.json({
    success: true,
    message: `Removed student ${studentId} from session ${sessionCode}.`,
    totalStudents: session.allowedStudentIds.size,
  });
}

export async function addSessionStudents(c: any) {
  const caller = requireCaller(c);
  const sessionCode = c.req.param("sessionCode").toUpperCase();
  const session = sessions.get(sessionCode);

  if (!session) {
    return c.json(
      { error: `Session with code ${sessionCode} not found.` },
      404,
    );
  }

  const body = await c.req.json();
  const { studentIds } = body as { studentIds?: string[] };

  if (!studentIds || !Array.isArray(studentIds)) {
    return c.json(
      { error: "Invalid payload. 'studentIds' array is required." },
      400,
    );
  }

  let addedCount = 0;
  for (const rawId of studentIds) {
    const id = rawId.toUpperCase();
    session.allowedStudentIds.add(id);

    const stateKey = `${sessionCode}:${id}`;
    if (!sessionStates.has(stateKey)) {
      const initialState: StudentSessionState = {
        sessionCode,
        studentId: id,
        hasLoggedIn: false,
        loginTimestamp: 0,
        tokensConsumed: 0,
        reassigned: false,
      };
      sessionStates.set(stateKey, initialState);
    }
    addedCount++;
  }

  session.updatedAt = Date.now();
  session.updatedBy = caller.username;
  sessions.set(sessionCode, session);

  return c.json({
    success: true,
    message: `Added ${addedCount} students to session ${sessionCode}.`,
    totalStudents: session.allowedStudentIds.size,
  });
}

export async function reassignSessionStudent(c: any) {
    const sessionCode = c.req.param("sessionCode").toUpperCase();
    const studentId = c.req.param("studentId").toUpperCase();
    const stateKey = `${sessionCode}:${studentId}`;

    const state = sessionStates.get(stateKey);
    if (!state) {
      return c.json({ error: "Student session state not found." }, 404);
    }

    state.reassigned = true;
    state.hasLoggedIn = false;
    sessionStates.set(stateKey, state);

    // Revoke active Redis session cache to immediately invalidate existing JWT token
    if (redis && redis.status === "ready") {
      try {
        const redisKey = `session:user:${sessionCode}:${studentId}`;
        await redis.del(redisKey);
      } catch (err) {
        console.error(
          `[Admin] Failed to delete Redis session for ${stateKey}:`,
          err,
        );
      }
    }

    return c.json({
      success: true,
      message: `Student ${studentId} reassigned successfully in session ${sessionCode}.`,
    });
  }

export async function listSessions(c: any) {
  const caller = requireCaller(c);
  const callerUser = (caller.username || "admin").toLowerCase();
  const callerRole = (caller.role || "admin").toLowerCase();

  const allSessions = Array.from(sessions.values());
  const scopedSessions = allSessions.filter((s) => {
    if (callerRole === "admin") return true;
    return (s.createdBy || "admin").toLowerCase() === callerUser;
  });

  const sessionPromises = scopedSessions.map(async (session) => {
    const code = session.sessionCode;
    const studentIds = new Set(session.allowedStudentIds);
    for (const state of sessionStates.values()) {
      if (state.sessionCode === code) {
        studentIds.add(state.studentId);
      }
    }

    const studentStatesPromises = Array.from(studentIds).map(
      async (studentId) => {
        const stateKey = `${code}:${studentId}`;
        const state = sessionStates.get(stateKey);

        let consumed = state?.tokensConsumed ?? 0;
        if (redis && redis.status === "ready") {
          try {
            const val = await redis.hget(
              `session:user:${code}:${studentId}`,
              "consumed",
            );
            if (val !== null) {
              consumed = parseInt(val, 10);
            }
          } catch (err) {
            // Redis error fallback to SQLite state
          }
        }

        return {
          studentId,
          hasLoggedIn: state?.hasLoggedIn ?? false,
          loginTimestamp: state?.loginTimestamp ?? 0,
          tokensConsumed: consumed,
          reassigned: state?.reassigned ?? false,
          latestClassification: state?.latestClassification ?? "none",
          instrumentalCount: state?.instrumentalCount ?? 0,
          executiveCount: state?.executiveCount ?? 0,
          mixedCount: state?.mixedCount ?? 0,
          promptCount: state?.promptCount ?? 0,
        };
      },
    );

    const studentStates = await Promise.all(studentStatesPromises);

    return {
      sessionCode: session.sessionCode,
      startTime: session.startTime,
      durationMinutes: session.durationMinutes,
      aiOption: session.aiOption,
      aiValidityMinutes: session.aiValidityMinutes,
      defaultTokenBudget: session.defaultTokenBudget,
      assignedGroups: session.assignedGroups || [],
      sessionType: session.sessionType || "basic",
      sessionPrompt: session.sessionPrompt || "",
      promptMode: session.promptMode || "scaffolded_code",
      examQuestions: session.examQuestions || [],
      runtimeConfig: session.runtimeConfig,
      createdAt: toMs(session.createdAt) ?? toMs(session.startTime) ?? 0,
      createdBy: session.createdBy || "admin",
      updatedAt: session.updatedAt || session.createdAt || Date.now(),
      updatedBy: session.updatedBy || "admin",
      students: studentStates,
    };
  });

  const sessionList = await Promise.all(sessionPromises);
  return c.json({ success: true, sessions: sessionList });
}
