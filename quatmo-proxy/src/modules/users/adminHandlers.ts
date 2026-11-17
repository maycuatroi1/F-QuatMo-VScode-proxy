import { requireCaller } from "../../shared/http/adminCaller";
import { studentAccounts, sessions, sessionStates, studentGroups, type StudentAccount } from "../../services/sessionStore";

declare const Bun: any;

export async function resetStudentPassword(c: any) {
  const caller = requireCaller(c);
  const rawId = decodeURIComponent(c.req.param("studentId")).trim();
  if (!rawId) {
    return c.json({ error: "Student ID is required." }, 400);
  }

  const studentId = rawId.toUpperCase();
  const body = await c.req.json();
  const { newPassword } = body as { newPassword?: string };

  if (!newPassword || !newPassword.trim()) {
    return c.json({ error: "Field 'newPassword' is required." }, 400);
  }

  const passwordHash = await Bun.password.hash(newPassword.trim(), "bcrypt");
  const creator = caller.username || "admin";
  const now = Date.now();

  const mapKey = `${studentId}:${creator.toLowerCase()}`;
  const existing = studentAccounts.get(mapKey);

  studentAccounts.set(mapKey, {
    studentId,
    passwordHash,
    createdAt: existing?.createdAt || now,
    createdBy: existing?.createdBy || creator,
    updatedAt: now,
    updatedBy: caller.username,
  });

  return c.json({
    success: true,
    message: `Password for student ${studentId} updated successfully.`,
  });
}

export const handleStudentImport = async (c: any) => {
  const caller = requireCaller(c);
  const body = await c.req.json();
  const { students } = body as {
    students?: Array<{ studentId: string; password?: string }>;
  };

  if (!students || !Array.isArray(students)) {
    return c.json(
      { error: "Invalid payload. 'students' array is required." },
      400,
    );
  }

  let importedCount = 0;
  let skippedCount = 0;
  const now = Date.now();
  const creator = (caller.username || "admin").trim();
  const creatorLower = creator.toLowerCase();
  const seenInBatch = new Set<string>();

  const promises = students.map(async (stu) => {
    if (!stu.studentId || !stu.password) return;
    const stuId = stu.studentId.trim().toUpperCase();
    if (!stuId) return;

    if (seenInBatch.has(stuId)) {
      skippedCount++;
      return;
    }
    seenInBatch.add(stuId);

    const mapKey = `${stuId}:${creatorLower}`;
    const existing = studentAccounts.get(mapKey);

    // Validate in isolated scope: if already exists for this lecturer, skip to prevent duplicates/overwriting
    if (existing) {
      skippedCount++;
      return;
    }

    const passwordHash = await Bun.password.hash(stu.password, "bcrypt");
    studentAccounts.set(mapKey, {
      studentId: stuId,
      passwordHash,
      createdAt: now,
      createdBy: creator,
      updatedAt: now,
      updatedBy: caller.username || creator,
    });
    importedCount++;
  });
  await Promise.all(promises);

  let message = `Imported ${importedCount} student account(s).`;
  if (skippedCount > 0) {
    message += ` (${skippedCount} already existed and were skipped)`;
  }

  return c.json({
    success: true,
    message,
    importedCount,
    skippedCount,
  });
};

export async function listStudents(c: any) {
  const caller = requireCaller(c);
  const callerUser = (caller.username || "admin").toLowerCase();
  const callerRole = (caller.role || "admin").toLowerCase();
  const list: any[] = [];
  for (const account of studentAccounts.values()) {
    const creator = (account.createdBy || "admin").toLowerCase();
    if (callerRole !== "admin" && creator !== callerUser) {
      continue;
    }
    list.push({
      studentId: account.studentId,
      createdAt: account.createdAt,
      createdBy: account.createdBy || "admin",
      updatedAt: account.updatedAt,
      updatedBy: account.updatedBy || "admin",
      isDeleted: !!account.isDeleted,
      deletedAt: account.deletedAt || null,
    });
  }
  return c.json({ success: true, students: list });
}

export async function deleteStudent(c: any) {
  const caller = requireCaller(c);
  const studentId = c.req.param("studentId").toUpperCase();
  const callerUser = (caller.username || "admin").toLowerCase();
  const callerRole = (caller.role || "admin").toLowerCase();

  let targetKey: string | null = null;
  let targetAccount: StudentAccount | null = null;

  for (const [key, acc] of studentAccounts.entries()) {
    if (acc.studentId.toUpperCase() === studentId) {
      const creator = (acc.createdBy || "admin").toLowerCase();
      if (callerRole === "admin" || creator === callerUser) {
        targetKey = key;
        targetAccount = acc;
        break;
      }
    }
  }

  if (!targetAccount || !targetKey) {
    return c.json(
      { error: `User with ID ${studentId} not found or not authorized.` },
      404,
    );
  }

  // Check if student has ever been linked to any session
  const isLinkedToAnySession =
    Array.from(sessions.values()).some((s) =>
      s.allowedStudentIds?.has(studentId),
    ) ||
    Array.from(sessionStates.values()).some(
      (st) => st.studentId?.toUpperCase() === studentId,
    );

  if (isLinkedToAnySession) {
    // Soft Delete (Deactivate) to preserve audit trails & exam data
    targetAccount.isDeleted = true;
    targetAccount.deletedAt = Date.now();
    targetAccount.updatedAt = Date.now();
    targetAccount.updatedBy = caller.username;
    studentAccounts.set(targetKey, targetAccount);

    return c.json({
      success: true,
      action: "soft_deleted",
      message: `Tài khoản ${studentId} đã từng tham gia kỳ thi nên đã được tạm khóa để bảo toàn dữ liệu.`,
      studentId,
    });
  } else {
    // Hard Delete: Never participated in any session, no exam records or state
    studentAccounts.delete(targetKey);

    // Membership belongs to the deleted account's creator, even for super-admin callers.
    for (const [gKey, group] of studentGroups.entries()) {
      if (
        (group.createdBy || "admin").toLowerCase() === (targetAccount.createdBy || "admin").toLowerCase() &&
        group.userIds &&
        group.userIds.some((uid) => uid.toUpperCase() === studentId)
      ) {
        group.userIds = group.userIds.filter(
          (uid) => uid.toUpperCase() !== studentId,
        );
        group.updatedAt = Date.now();
        group.updatedBy = caller.username;
        studentGroups.set(gKey, group);
      }
    }

    return c.json({
      success: true,
      action: "hard_deleted",
      message: `Tài khoản ${studentId} chưa từng tham gia kỳ thi nào và đã được xóa vĩnh viễn khỏi hệ thống.`,
      studentId,
    });
  }
}

export async function restoreStudent(c: any) {
  const caller = requireCaller(c);
  const studentId = c.req.param("studentId").toUpperCase();
  const callerUser = (caller.username || "admin").toLowerCase();
  const callerRole = (caller.role || "admin").toLowerCase();

  let targetKey: string | null = null;
  let targetAccount: StudentAccount | null = null;

  for (const [key, acc] of studentAccounts.entries()) {
    if (acc.studentId.toUpperCase() === studentId) {
      const creator = (acc.createdBy || "admin").toLowerCase();
      if (callerRole === "admin" || creator === callerUser) {
        targetKey = key;
        targetAccount = acc;
        break;
      }
    }
  }

  if (!targetAccount || !targetKey) {
    return c.json(
      { error: `User with ID ${studentId} not found or not authorized.` },
      404,
    );
  }

  targetAccount.isDeleted = false;
  targetAccount.deletedAt = null;
  targetAccount.updatedAt = Date.now();
  targetAccount.updatedBy = caller.username;

  studentAccounts.set(targetKey, targetAccount);

  return c.json({
    success: true,
    message: `User ${studentId} has been restored successfully.`,
    studentId,
  });
}

export async function bulkDeleteStudents(c: any) {
  const caller = requireCaller(c);
  const callerUser = (caller.username || "admin").toLowerCase();
  const callerRole = (caller.role || "admin").toLowerCase();

  const body = await c.req.json();
  const { studentIds } = body as { studentIds?: string[] };
  if (!Array.isArray(studentIds) || studentIds.length === 0) {
    return c.json({ error: "studentIds array is required." }, 400);
  }

  let softDeletedCount = 0;
  let hardDeletedCount = 0;
  const now = Date.now();

  for (const rawId of studentIds) {
    const studentId = String(rawId).trim().toUpperCase();
    for (const [key, acc] of studentAccounts.entries()) {
      if (acc.studentId.toUpperCase() === studentId) {
        const creator = (acc.createdBy || "admin").toLowerCase();
        if (callerRole === "admin" || creator === callerUser) {
          const isLinked =
            Array.from(sessions.values()).some((s) =>
              s.allowedStudentIds?.has(studentId),
            ) ||
            Array.from(sessionStates.values()).some(
              (st) => st.studentId?.toUpperCase() === studentId,
            );

          if (isLinked) {
            acc.isDeleted = true;
            acc.deletedAt = now;
            acc.updatedAt = now;
            acc.updatedBy = caller.username;
            studentAccounts.set(key, acc);
            softDeletedCount++;
          } else {
            studentAccounts.delete(key);
            for (const [gKey, group] of studentGroups.entries()) {
              if (
                (group.createdBy || "admin").toLowerCase() === (acc.createdBy || "admin").toLowerCase() &&
                group.userIds &&
                group.userIds.some((uid) => uid.toUpperCase() === studentId)
              ) {
                group.userIds = group.userIds.filter(
                  (uid) => uid.toUpperCase() !== studentId,
                );
                group.updatedAt = Date.now();
                group.updatedBy = caller.username;
                studentGroups.set(gKey, group);
              }
            }
            hardDeletedCount++;
          }
          break;
        }
      }
    }
  }

  return c.json({
    success: true,
    message: `Đã xử lý ${softDeletedCount + hardDeletedCount} tài khoản (${softDeletedCount} tạm khóa, ${hardDeletedCount} xóa vĩnh viễn).`,
    softDeletedCount,
    hardDeletedCount,
  });
}
