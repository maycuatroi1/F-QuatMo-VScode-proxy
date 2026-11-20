import { requireCaller } from "../../shared/http/adminCaller";
import { sessionEndMs } from "../../shared/sessionTime";
import { hasSessionParticipation } from "../sessions/statePolicy";
import { redis } from "../../services/redis";
import { sessions, sessionStates, studentGroups, type Group } from "../../services/sessionStore";

async function syncGroupWithActiveSessions(
  groupName: string,
  createdBy: string,
  addedUserIds: string[] = [],
  removedUserIds: string[] = [],
) {
  const upperAddedIds = addedUserIds.map((id) => id.toUpperCase());
  const upperRemovedIds = removedUserIds.map((id) => id.toUpperCase());
  const nowSec = Math.floor(Date.now() / 1000);

  for (const session of sessions.values()) {
    if (
      !session.assignedGroups ||
      !session.assignedGroups.includes(groupName)
    ) {
      continue;
    }

    if (
      createdBy &&
      createdBy.toLowerCase() !== "admin" &&
      (session.createdBy || "admin").toLowerCase() !== createdBy.toLowerCase()
    ) {
      continue;
    }

    const endSec = Math.floor((sessionEndMs(session) ?? 0) / 1000);
    const isActive = nowSec < endSec;

    for (const uid of upperAddedIds) {
      session.allowedStudentIds.add(uid);

      const stateKey = `${session.sessionCode}:${uid}`;
      let state = sessionStates.get(stateKey);
      if (!state) {
        state = {
          sessionCode: session.sessionCode,
          studentId: uid,
          hasLoggedIn: false,
          loginTimestamp: 0,
          tokensConsumed: 0,
          reassigned: false,
        };
        sessionStates.set(stateKey, state);
      }

      if (isActive && state.hasLoggedIn && !state.reassigned) {
        if (redis && redis.status === "ready") {
          const redisKey = `session:user:${session.sessionCode}:${uid}`;
          const remainingSec = Math.max(60, endSec - nowSec);
          await redis
            .hset(redisKey, {
              studentId: uid,
              sessionCode: session.sessionCode,
              hasLoggedIn: "true",
              tokensConsumed: String(state.tokensConsumed || 0),
              budget: String(session.defaultTokenBudget || 100000000),
              latestClassification: state.latestClassification || "none",
            })
            .catch(() => {});
          await redis.expire(redisKey, remainingSec).catch(() => {});
        }
      }
    }

    for (const uid of upperRemovedIds) {
      // Group membership can change, but participation evidence must survive.
      if (hasSessionParticipation(sessionStates.get(`${session.sessionCode}:${uid}`))) continue;
      let stillBelongsToOtherGroup = false;
      for (const otherGroupName of session.assignedGroups) {
        if (otherGroupName === groupName) continue;
        const otherGroupKey = `${otherGroupName}:${(session.createdBy || "admin").toLowerCase()}`;
        const otherGroup =
          studentGroups.get(otherGroupKey) ||
          studentGroups.get(`${otherGroupName}:admin`);
        if (otherGroup && Array.isArray(otherGroup.userIds)) {
          if (otherGroup.userIds.some((id) => id.toUpperCase() === uid)) {
            stillBelongsToOtherGroup = true;
            break;
          }
        }
      }

      if (!stillBelongsToOtherGroup) {
        session.allowedStudentIds.delete(uid);
        const stateKey = `${session.sessionCode}:${uid}`;
        sessionStates.delete(stateKey);

        if (redis && redis.status === "ready") {
          const redisKey = `session:user:${session.sessionCode}:${uid}`;
          await redis.del(redisKey).catch(() => {});
        }
      }
    }

    sessions.set(session.sessionCode, session);
  }
}

export async function listGroups(c: any) {
  const caller = requireCaller(c);
  const callerUser = (caller.username || "admin").toLowerCase();
  const callerRole = (caller.role || "admin").toLowerCase();
  const groupsList = Array.from(studentGroups.values()).filter((g) => {
    if (callerRole === "admin") return true;
    return (g.createdBy || "admin").toLowerCase() === callerUser;
  });

  return c.json({ success: true, groups: groupsList });
}

export async function saveGroup(c: any) {
  const caller = requireCaller(c);
  const body = await c.req.json();
  const { name, userIds } = body as { name?: string; userIds?: string[] };

  if (!name) {
    return c.json({ error: "Missing required field: name" }, 400);
  }

  const groupName = name.trim();
  const members = Array.isArray(userIds)
    ? userIds.map((uid) => uid.toUpperCase())
    : [];

  const now = Date.now();
  const mapKey = `${groupName}:${caller.username.toLowerCase()}`;
  const existing = studentGroups.get(mapKey);

  const updatedGroup: Group = {
    name: groupName,
    userIds: members,
    createdAt: existing?.createdAt || now,
    createdBy: existing?.createdBy || caller.username,
    updatedAt: now,
    updatedBy: caller.username,
  };

  studentGroups.set(mapKey, updatedGroup);

  if (members.length > 0) {
    await syncGroupWithActiveSessions(groupName, caller.username, members, []);
  }

  return c.json({
    success: true,
    message: `Group '${groupName}' saved.`,
    group: updatedGroup,
  });
}

export async function addGroupStudents(c: any) {
  const caller = requireCaller(c);
  const groupName = decodeURIComponent(c.req.param("name")).trim();
  const mapKey = `${groupName}:${caller.username.toLowerCase()}`;
  let group = studentGroups.get(mapKey);
  if (!group && caller.role === "admin") {
    group =
      studentGroups.get(`${groupName}:admin`) ||
      Array.from(studentGroups.values()).find(
        (g) => g.name.toLowerCase() === groupName.toLowerCase(),
      );
  }

  if (!group) {
    return c.json({ error: `Group '${groupName}' not found.` }, 404);
  }

  const body = await c.req.json();
  const { studentIds, userIds } = body as {
    studentIds?: string[];
    userIds?: string[];
  };
  const rawIds = Array.isArray(studentIds)
    ? studentIds
    : Array.isArray(userIds)
      ? userIds
      : [];

  if (rawIds.length === 0) {
    return c.json({ error: "No student IDs provided." }, 400);
  }

  const newMembersSet = new Set(group.userIds.map((id) => id.toUpperCase()));
  const addedUserIds: string[] = [];

  for (const rawId of rawIds) {
    const upperId = String(rawId).trim().toUpperCase();
    if (upperId && !newMembersSet.has(upperId)) {
      newMembersSet.add(upperId);
      addedUserIds.push(upperId);
    }
  }

  const now = Date.now();
  const updatedGroup: Group = {
    ...group,
    userIds: Array.from(newMembersSet),
    updatedAt: now,
    updatedBy: caller.username,
  };

  const targetKey = `${group.name}:${(group.createdBy || caller.username).toLowerCase()}`;
  studentGroups.set(targetKey, updatedGroup);

  if (addedUserIds.length > 0) {
    await syncGroupWithActiveSessions(
      group.name,
      group.createdBy || caller.username,
      addedUserIds,
      [],
    );
  }

  return c.json({
    success: true,
    message: `Added ${addedUserIds.length} student(s) to group '${groupName}'.`,
    group: updatedGroup,
  });
}

export async function removeGroupStudent(c: any) {
  const caller = requireCaller(c);
  const groupName = decodeURIComponent(c.req.param("name")).trim();
  const studentId = decodeURIComponent(c.req.param("studentId"))
    .trim()
    .toUpperCase();

  const mapKey = `${groupName}:${caller.username.toLowerCase()}`;
  let group = studentGroups.get(mapKey);
  if (!group && caller.role === "admin") {
    group =
      studentGroups.get(`${groupName}:admin`) ||
      Array.from(studentGroups.values()).find(
        (g) => g.name.toLowerCase() === groupName.toLowerCase(),
      );
  }

  if (!group) {
    return c.json({ error: `Group '${groupName}' not found.` }, 404);
  }

  const updatedUserIds = group.userIds.filter(
    (id) => id.toUpperCase() !== studentId,
  );
  const now = Date.now();
  const updatedGroup: Group = {
    ...group,
    userIds: updatedUserIds,
    updatedAt: now,
    updatedBy: caller.username,
  };

  const targetKey = `${group.name}:${(group.createdBy || caller.username).toLowerCase()}`;
  studentGroups.set(targetKey, updatedGroup);
  await syncGroupWithActiveSessions(
    group.name,
    group.createdBy || caller.username,
    [],
    [studentId],
  );

  return c.json({
    success: true,
    message: `Removed student ${studentId} from group '${groupName}'.`,
    group: updatedGroup,
  });
}

export async function deleteGroup(c: any) {
  const caller = requireCaller(c);
  const groupName = decodeURIComponent(c.req.param("name")).trim();
  const mapKey = `${groupName}:${caller.username.toLowerCase()}`;
  let group = studentGroups.get(mapKey);
  if (!group && caller.role === "admin") {
    group =
      studentGroups.get(`${groupName}:admin`) ||
      Array.from(studentGroups.values()).find(
        (g) => g.name.toLowerCase() === groupName.toLowerCase(),
      );
  }

  if (!group) {
    return c.json({ error: `Group '${groupName}' not found.` }, 404);
  }

  const targetKey = `${group.name}:${(group.createdBy || caller.username).toLowerCase()}`;
  const existed = studentGroups.delete(targetKey);

  if (!existed) {
    return c.json({ error: `Group '${groupName}' not found.` }, 404);
  }

  if (group && Array.isArray(group.userIds)) {
    await syncGroupWithActiveSessions(
      group.name,
      group.createdBy || caller.username,
      [],
      group.userIds,
    );
  }

  return c.json({ success: true, message: `Group '${groupName}' deleted.` });
}
