import { requireCaller } from "../../shared/http/adminCaller";
import { getAdminUsername } from "../../services/adminCredentials";
import {
  lecturerAccounts, sessions, studentGroups, studentAccounts,
  type LecturerAccount,
} from "../../services/sessionStore";

declare const Bun: any;

export async function listLecturers(c: any) {
  const caller = requireCaller(c);
  if (caller.role !== "admin") {
    return c.json({ error: "Forbidden. Super Admin access required." }, 403);
  }

  const list = Array.from(lecturerAccounts.values()).map((l) => ({
    username: l.username,
    name: l.name,
    status: l.status,
    createdAt: l.createdAt,
    createdBy: l.createdBy,
    updatedAt: l.updatedAt,
    updatedBy: l.updatedBy,
  }));

  return c.json({ success: true, lecturers: list });
}

export async function getLecturerDetails(c: any) {
  const caller = requireCaller(c);
  if (caller.role !== "admin") {
    return c.json({ error: "Forbidden. Super Admin access required." }, 403);
  }

  const targetUser = decodeURIComponent(c.req.param("username")).trim();
  const lecturer = lecturerAccounts.get(targetUser);
  if (!lecturer) {
    return c.json({ error: `Lecturer '${targetUser}' not found.` }, 404);
  }

  const lecturerSessions = Array.from(sessions.values())
    .filter(
      (s) =>
        (s.createdBy || "admin").toLowerCase() === targetUser.toLowerCase(),
    )
    .map((s) => ({
      sessionCode: s.sessionCode,
      startTime: s.startTime,
      durationMinutes: s.durationMinutes,
      aiOption: s.aiOption,
      allowedStudentCount: s.allowedStudentIds.size,
      assignedGroups: s.assignedGroups || [],
      sessionType: s.sessionType || "basic",
      sessionPrompt: s.sessionPrompt || "",
      examQuestions: s.examQuestions || [],
      runtimeConfig: s.runtimeConfig,
      createdAt: s.createdAt,
    }));

  const lecturerGroups = Array.from(studentGroups.values())
    .filter(
      (g) =>
        (g.createdBy || "admin").toLowerCase() === targetUser.toLowerCase(),
    )
    .map((g) => ({
      name: g.name,
      userCount: g.userIds.length,
      userIds: g.userIds,
      createdAt: g.createdAt,
    }));

  const lecturerStudents: any[] = [];
  for (const acc of studentAccounts.values()) {
    if ((acc.createdBy || "admin").toLowerCase() === targetUser.toLowerCase()) {
      lecturerStudents.push({
        studentId: acc.studentId,
        createdAt: acc.createdAt,
        updatedAt: acc.updatedAt,
      });
    }
  }

  return c.json({
    success: true,
    lecturer: {
      username: lecturer.username,
      name: lecturer.name,
      status: lecturer.status,
      createdAt: lecturer.createdAt,
      createdBy: lecturer.createdBy,
      updatedAt: lecturer.updatedAt,
      updatedBy: lecturer.updatedBy,
    },
    sessions: lecturerSessions,
    groups: lecturerGroups,
    students: lecturerStudents,
  });
}

export async function createLecturer(c: any) {
  const caller = requireCaller(c);
  if (caller.role !== "admin") {
    return c.json({ error: "Forbidden. Super Admin access required." }, 403);
  }

  const body = await c.req.json();
  const { username, password, name } = body as {
    username?: string;
    password?: string;
    name?: string;
  };

  if (!username || !password || !name) {
    return c.json(
      { error: "Missing required fields: username, password, name" },
      400,
    );
  }

  const cleanUser = username.trim();
  if (lecturerAccounts.has(cleanUser) || cleanUser === getAdminUsername()) {
    return c.json(
      { error: `Account with username '${cleanUser}' already exists.` },
      400,
    );
  }

  const passwordHash = await Bun.password.hash(password, "bcrypt");
  const now = Date.now();
  const newLecturer: LecturerAccount = {
    username: cleanUser,
    name: name.trim(),
    passwordHash,
    status: "active",
    createdAt: now,
    createdBy: caller.username,
    updatedAt: now,
    updatedBy: caller.username,
  };

  lecturerAccounts.set(cleanUser, newLecturer);

  return c.json({
    success: true,
    message: `Lecturer '${cleanUser}' created successfully.`,
    lecturer: {
      username: newLecturer.username,
      name: newLecturer.name,
      status: newLecturer.status,
      createdAt: newLecturer.createdAt,
      createdBy: newLecturer.createdBy,
      updatedAt: newLecturer.updatedAt,
      updatedBy: newLecturer.updatedBy,
    },
  });
}

export async function setLecturerStatus(c: any) {
  const caller = requireCaller(c);
  if (caller.role !== "admin") {
    return c.json({ error: "Forbidden. Super Admin access required." }, 403);
  }

  const targetUser = decodeURIComponent(c.req.param("username")).trim();
  const lecturer = lecturerAccounts.get(targetUser);
  if (!lecturer) {
    return c.json({ error: `Lecturer '${targetUser}' not found.` }, 404);
  }

  const body = await c.req.json();
  const { status } = body as { status?: "active" | "inactive" };
  const newStatus =
    status || (lecturer.status === "active" ? "inactive" : "active");

  lecturer.status = newStatus;
  lecturer.updatedAt = Date.now();
  lecturer.updatedBy = caller.username;

  lecturerAccounts.set(targetUser, lecturer);

  return c.json({
    success: true,
    message: `Lecturer '${targetUser}' status updated to ${newStatus}.`,
    lecturer: {
      username: lecturer.username,
      name: lecturer.name,
      status: lecturer.status,
      createdAt: lecturer.createdAt,
      createdBy: lecturer.createdBy,
      updatedAt: lecturer.updatedAt,
      updatedBy: lecturer.updatedBy,
    },
  });
}

export async function resetLecturerPassword(c: any) {
  const caller = requireCaller(c);
  if (caller.role !== "admin") {
    return c.json({ error: "Forbidden. Super Admin access required." }, 403);
  }

  const targetUser = decodeURIComponent(c.req.param("username")).trim();
  const lecturer = lecturerAccounts.get(targetUser);
  if (!lecturer) {
    return c.json({ error: `Lecturer '${targetUser}' not found.` }, 404);
  }

  let body: any = {};
  try {
    body = await c.req.json();
  } catch {}

  const randomPassword = String(Math.floor(100000 + Math.random() * 900000));
  const newPassword = body?.newPassword?.trim() || randomPassword;

  const passwordHash = await Bun.password.hash(newPassword, "bcrypt");
  lecturer.passwordHash = passwordHash;
  lecturer.updatedAt = Date.now();
  lecturer.updatedBy = caller.username;

  lecturerAccounts.set(targetUser, lecturer);

  return c.json({
    success: true,
    message: `Password for lecturer '${targetUser}' reset successfully.`,
    newPassword,
  });
}
