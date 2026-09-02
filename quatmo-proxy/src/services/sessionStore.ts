import { Database } from "bun:sqlite";
import path from "path";
import fs from "fs";

export interface LecturerAccount {
  username: string;
  name: string;
  passwordHash: string;
  status: "active" | "inactive";
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
}

export interface StudentAccount {
  studentId: string;
  passwordHash: string;
  createdAt?: number;
  createdBy?: string;
  updatedAt?: number;
  updatedBy?: string;
}

export interface Session {
  sessionCode: string;
  startTime: number;
  durationMinutes: number;
  aiOption: "chatbot" | "agent" | "none";
  aiValidityMinutes: number;
  defaultTokenBudget: number;
  allowedStudentIds: Set<string>;
  assignedGroups?: string[];
  createdAt: number;
  createdBy?: string;
  updatedAt?: number;
  updatedBy?: string;
}

export interface StudentSessionState {
  sessionCode: string;
  studentId: string;
  hasLoggedIn: boolean;
  loginTimestamp: number;
  tokensConsumed: number;
  reassigned: boolean;
  latestClassification?: string;
  instrumentalCount?: number;
  executiveCount?: number;
  mixedCount?: number;
  promptCount?: number;
}

export interface Group {
  name: string;
  userIds: string[];
  createdAt?: number;
  createdBy?: string;
  updatedAt?: number;
  updatedBy?: string;
}

const logsDir = path.resolve(process.cwd(), "logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}
const dbPath = path.join(logsDir, "quatmo.db");
const db = new Database(dbPath);

db.run(`
  CREATE TABLE IF NOT EXISTS lecturer_accounts (
    username TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL DEFAULT 'admin',
    updated_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL DEFAULT 'admin'
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS student_accounts (
    student_id TEXT NOT NULL,
    created_by TEXT NOT NULL DEFAULT 'admin',
    password_hash TEXT NOT NULL,
    created_at INTEGER,
    updated_at INTEGER,
    updated_by TEXT DEFAULT 'admin',
    PRIMARY KEY (student_id, created_by)
  )
`);

// Safe SQLite migration to composite PRIMARY KEY (student_id, created_by)
try {
  const tableInfo = db.query("PRAGMA table_info(student_accounts)").all() as any[];
  if (tableInfo && tableInfo.length > 0) {
    const colNames = new Set(tableInfo.map((col) => col.name));
    const pkColumns = tableInfo.filter((col) => col.pk > 0);

    if (pkColumns.length === 1 || !colNames.has("created_by") || !colNames.has("created_at")) {
      console.log("[Db] Migrating student_accounts table to composite PRIMARY KEY (student_id, created_by)...");
      db.run(`CREATE TABLE IF NOT EXISTS student_accounts_new (
        student_id TEXT NOT NULL,
        created_by TEXT NOT NULL DEFAULT 'admin',
        password_hash TEXT NOT NULL,
        created_at INTEGER,
        updated_at INTEGER,
        updated_by TEXT DEFAULT 'admin',
        PRIMARY KEY (student_id, created_by)
      )`);

      const createdBySel = colNames.has("created_by") ? "COALESCE(created_by, 'admin')" : "'admin'";
      const createdAtSel = colNames.has("created_at") ? "created_at" : "CAST(strftime('%s', 'now') AS INTEGER) * 1000";
      const updatedAtSel = colNames.has("updated_at") ? "updated_at" : "CAST(strftime('%s', 'now') AS INTEGER) * 1000";
      const updatedBySel = colNames.has("updated_by") ? "COALESCE(updated_by, 'admin')" : "'admin'";

      db.run(`INSERT OR IGNORE INTO student_accounts_new (student_id, created_by, password_hash, created_at, updated_at, updated_by)
        SELECT student_id, ${createdBySel}, password_hash, ${createdAtSel}, ${updatedAtSel}, ${updatedBySel} FROM student_accounts`);
      db.run(`DROP TABLE student_accounts`);
      db.run(`ALTER TABLE student_accounts_new RENAME TO student_accounts`);
      console.log("[Db] Migration of student_accounts to composite key completed successfully.");
    }
  }
} catch (err) {
  console.error("[Db] Error during student_accounts migration:", err);
}

try { db.run("ALTER TABLE student_accounts ADD COLUMN created_by TEXT NOT NULL DEFAULT 'admin'"); } catch (e) {}
try { db.run("ALTER TABLE student_accounts ADD COLUMN created_at INTEGER"); } catch (e) {}
try { db.run("ALTER TABLE student_accounts ADD COLUMN updated_at INTEGER"); } catch (e) {}
try { db.run("ALTER TABLE student_accounts ADD COLUMN updated_by TEXT DEFAULT 'admin'"); } catch (e) {}

db.run(`
  CREATE TABLE IF NOT EXISTS sessions (
    session_code TEXT PRIMARY KEY,
    start_time INTEGER NOT NULL,
    duration_minutes INTEGER NOT NULL,
    ai_option TEXT NOT NULL,
    ai_validity_minutes INTEGER NOT NULL,
    default_token_budget INTEGER NOT NULL,
    allowed_student_ids TEXT NOT NULL,
    assigned_groups TEXT,
    created_at INTEGER NOT NULL,
    created_by TEXT DEFAULT 'admin',
    updated_at INTEGER,
    updated_by TEXT DEFAULT 'admin'
  )
`);

try { db.run("ALTER TABLE sessions ADD COLUMN assigned_groups TEXT"); } catch (e) {}
try { db.run("ALTER TABLE sessions ADD COLUMN created_by TEXT DEFAULT 'admin'"); } catch (e) {}
try { db.run("ALTER TABLE sessions ADD COLUMN updated_at INTEGER"); } catch (e) {}
try { db.run("ALTER TABLE sessions ADD COLUMN updated_by TEXT DEFAULT 'admin'"); } catch (e) {}

db.run(`
  CREATE TABLE IF NOT EXISTS session_states (
    session_code TEXT,
    student_id TEXT,
    has_logged_in INTEGER NOT NULL,
    login_timestamp INTEGER NOT NULL,
    tokens_consumed INTEGER NOT NULL,
    reassigned INTEGER NOT NULL,
    latest_classification TEXT,
    PRIMARY KEY (session_code, student_id)
  )
`);

try { db.run("ALTER TABLE session_states ADD COLUMN latest_classification TEXT"); } catch (e) {}

db.run(`
  CREATE TABLE IF NOT EXISTS student_groups (
    name TEXT PRIMARY KEY,
    user_ids TEXT NOT NULL,
    created_at INTEGER,
    created_by TEXT DEFAULT 'admin',
    updated_at INTEGER,
    updated_by TEXT DEFAULT 'admin'
  )
`);

try { db.run("ALTER TABLE student_groups ADD COLUMN created_at INTEGER"); } catch (e) {}
try { db.run("ALTER TABLE student_groups ADD COLUMN created_by TEXT DEFAULT 'admin'"); } catch (e) {}
try { db.run("ALTER TABLE student_groups ADD COLUMN updated_at INTEGER"); } catch (e) {}
try { db.run("ALTER TABLE student_groups ADD COLUMN updated_by TEXT DEFAULT 'admin'"); } catch (e) {}

// High-volume performance indexes
try { db.run("CREATE INDEX IF NOT EXISTS idx_sessions_created_by ON sessions(created_by)"); } catch (e) {}
try { db.run("CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at)"); } catch (e) {}
try { db.run("CREATE INDEX IF NOT EXISTS idx_student_accounts_created_by ON student_accounts(created_by)"); } catch (e) {}
try { db.run("CREATE INDEX IF NOT EXISTS idx_student_groups_created_by ON student_groups(created_by)"); } catch (e) {}
try { db.run("CREATE INDEX IF NOT EXISTS idx_session_states_code ON session_states(session_code)"); } catch (e) {}
try { db.run("CREATE INDEX IF NOT EXISTS idx_session_states_student ON session_states(student_id)"); } catch (e) {}

const stmtSaveLecturer = db.prepare(`
  INSERT OR REPLACE INTO lecturer_accounts (username, name, password_hash, status, created_at, created_by, updated_at, updated_by)
  VALUES ($username, $name, $hash, $status, $created_at, $created_by, $updated_at, $updated_by)
`);

const stmtDeleteLecturer = db.prepare(`
  DELETE FROM lecturer_accounts WHERE username = $username
`);

const stmtSaveStudent = db.prepare(`
  INSERT OR REPLACE INTO student_accounts (student_id, created_by, password_hash, created_at, updated_at, updated_by)
  VALUES ($id, $created_by, $hash, $created_at, $updated_at, $updated_by)
`);

const stmtDeleteStudent = db.prepare(`
  DELETE FROM student_accounts WHERE student_id = $id AND created_by = $created_by
`);

const stmtSaveSession = db.prepare(`
  INSERT OR REPLACE INTO sessions (session_code, start_time, duration_minutes, ai_option, ai_validity_minutes, default_token_budget, allowed_student_ids, assigned_groups, created_at, created_by, updated_at, updated_by)
  VALUES ($code, $start, $dur, $ai_opt, $ai_val, $budget, $students, $groups, $created, $created_by, $updated_at, $updated_by)
`);

const stmtDeleteSession = db.prepare(`
  DELETE FROM sessions WHERE session_code = $code
`);

const stmtSaveState = db.prepare(`
  INSERT OR REPLACE INTO session_states (session_code, student_id, has_logged_in, login_timestamp, tokens_consumed, reassigned, latest_classification)
  VALUES ($code, $student, $has_login, $login_time, $tokens, $reassign, $classification)
`);

const stmtDeleteState = db.prepare(`
  DELETE FROM session_states WHERE session_code = $code AND student_id = $student
`);

const stmtSaveGroup = db.prepare(`
  INSERT OR REPLACE INTO student_groups (name, user_ids, created_at, created_by, updated_at, updated_by)
  VALUES ($name, $users, $created_at, $created_by, $updated_at, $updated_by)
`);

const stmtDeleteGroup = db.prepare(`
  DELETE FROM student_groups WHERE name = $name
`);

export class PersistedLecturers extends Map<string, LecturerAccount> {
  set(key: string, value: LecturerAccount): this {
    const now = Date.now();
    super.set(key, value);
    stmtSaveLecturer.run({
      $username: key,
      $name: value.name,
      $hash: value.passwordHash,
      $status: value.status,
      $created_at: value.createdAt || now,
      $created_by: value.createdBy || "admin",
      $updated_at: value.updatedAt || now,
      $updated_by: value.updatedBy || "admin",
    });
    return this;
  }
  delete(key: string): boolean {
    const existed = super.delete(key);
    if (existed) {
      stmtDeleteLecturer.run({ $username: key });
    }
    return existed;
  }
}

export class PersistedStudentAccounts extends Map<string, StudentAccount> {
  set(key: string, value: StudentAccount): this {
    const now = Date.now();
    const creator = (value.createdBy || "admin").trim();
    const stuId = value.studentId.toUpperCase();
    const mapKey = `${stuId}:${creator.toLowerCase()}`;
    const accToStore: StudentAccount = {
      ...value,
      studentId: stuId,
      createdBy: creator,
    };
    super.set(mapKey, accToStore);
    stmtSaveStudent.run({
      $id: accToStore.studentId,
      $created_by: accToStore.createdBy,
      $hash: accToStore.passwordHash,
      $created_at: accToStore.createdAt || now,
      $updated_at: accToStore.updatedAt || now,
      $updated_by: accToStore.updatedBy || creator,
    });
    return this;
  }
  delete(key: string): boolean {
    const existedAccount = super.get(key);
    const existed = super.delete(key);
    if (existed && existedAccount) {
      stmtDeleteStudent.run({
        $id: existedAccount.studentId,
        $created_by: existedAccount.createdBy || "admin",
      });
    }
    return existed;
  }
}

export class PersistedSessions extends Map<string, Session> {
  set(key: string, value: Session): this {
    const now = Date.now();
    super.set(key, value);
    stmtSaveSession.run({
      $code: key,
      $start: value.startTime,
      $dur: value.durationMinutes,
      $ai_opt: value.aiOption,
      $ai_val: value.aiValidityMinutes,
      $budget: value.defaultTokenBudget,
      $students: JSON.stringify(Array.from(value.allowedStudentIds)),
      $groups: JSON.stringify(value.assignedGroups || []),
      $created: value.createdAt || now,
      $created_by: value.createdBy || "admin",
      $updated_at: value.updatedAt || now,
      $updated_by: value.updatedBy || "admin",
    });
    return this;
  }
  delete(key: string): boolean {
    const existed = super.delete(key);
    if (existed) {
      stmtDeleteSession.run({ $code: key });
      db.run(`DELETE FROM session_states WHERE session_code = ?`, [key]);
    }
    return existed;
  }
}

export class PersistedSessionStates extends Map<string, StudentSessionState> {
  set(key: string, value: StudentSessionState): this {
    super.set(key, value);
    stmtSaveState.run({
      $code: value.sessionCode,
      $student: value.studentId,
      $has_login: value.hasLoggedIn ? 1 : 0,
      $login_time: value.loginTimestamp,
      $tokens: value.tokensConsumed,
      $reassign: value.reassigned ? 1 : 0,
      $classification: value.latestClassification || "none",
    });
    return this;
  }
  delete(key: string): boolean {
    const existed = super.delete(key);
    if (existed) {
      const [code, student] = key.split(":");
      stmtDeleteState.run({ $code: code, $student: student });
    }
    return existed;
  }
}

export class PersistedGroups extends Map<string, Group> {
  set(key: string, value: Group): this {
    const now = Date.now();
    super.set(key, value);
    stmtSaveGroup.run({
      $name: key,
      $users: JSON.stringify(value.userIds),
      $created_at: value.createdAt || now,
      $created_by: value.createdBy || "admin",
      $updated_at: value.updatedAt || now,
      $updated_by: value.updatedBy || "admin",
    });
    return this;
  }
  delete(key: string): boolean {
    const existed = super.delete(key);
    if (existed) {
      stmtDeleteGroup.run({ $name: key });
    }
    return existed;
  }
}

export const lecturerAccounts = new PersistedLecturers();
export const studentAccounts = new PersistedStudentAccounts();
export const sessions = new PersistedSessions();
export const sessionStates = new PersistedSessionStates();
export const studentGroups = new PersistedGroups();

export function getStudentAccount(studentId: string, creator = "admin"): StudentAccount | undefined {
  const upperId = studentId.toUpperCase();
  const exactKey = `${upperId}:${creator.toLowerCase()}`;
  if (studentAccounts.has(exactKey)) {
    return studentAccounts.get(exactKey);
  }
  const adminKey = `${upperId}:admin`;
  if (studentAccounts.has(adminKey)) {
    return studentAccounts.get(adminKey);
  }
  for (const acc of studentAccounts.values()) {
    if (acc.studentId.toUpperCase() === upperId) {
      return acc;
    }
  }
  return undefined;
}

export async function verifyPasswordSafely(password: string, hash: string): Promise<boolean> {
  if (!password || !hash) return false;
  if (password === hash) return true;
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

export async function findValidStudentAccount(
  studentId: string,
  password?: string,
  preferredCreator?: string
): Promise<StudentAccount | null> {
  const upperId = studentId.toUpperCase();
  const matching: StudentAccount[] = [];

  for (const acc of studentAccounts.values()) {
    if (acc.studentId.toUpperCase() === upperId) {
      matching.push(acc);
    }
  }

  if (matching.length === 0) return null;

  if (!password) {
    if (preferredCreator) {
      const preferred = matching.find(
        (a) => (a.createdBy || "admin").toLowerCase() === preferredCreator.toLowerCase()
      );
      if (preferred) return preferred;
    }
    return matching[0];
  }

  if (preferredCreator) {
    const preferred = matching.find(
      (a) => (a.createdBy || "admin").toLowerCase() === preferredCreator.toLowerCase()
    );
    if (preferred) {
      const isValid = await verifyPasswordSafely(password, preferred.passwordHash);
      if (isValid) return preferred;
    }
  }

  for (const acc of matching) {
    const isValid = await verifyPasswordSafely(password, acc.passwordHash);
    if (isValid) return acc;
  }

  return null;
}

try {
  const rowsLecturers = db
    .query("SELECT * FROM lecturer_accounts")
    .all() as any[];
  for (const r of rowsLecturers) {
    Map.prototype.set.call(lecturerAccounts, r.username, {
      username: r.username,
      name: r.name,
      passwordHash: r.password_hash,
      status: r.status || "active",
      createdAt: r.created_at || Date.now(),
      createdBy: r.created_by || "admin",
      updatedAt: r.updated_at || Date.now(),
      updatedBy: r.updated_by || "admin",
    });
  }

  const rowsAccounts = db
    .query("SELECT * FROM student_accounts")
    .all() as any[];
  for (const r of rowsAccounts) {
    const creator = r.created_by || "admin";
    const mapKey = `${r.student_id.toUpperCase()}:${creator.toLowerCase()}`;
    Map.prototype.set.call(studentAccounts, mapKey, {
      studentId: r.student_id.toUpperCase(),
      passwordHash: r.password_hash,
      createdAt: r.created_at || Date.now(),
      createdBy: creator,
      updatedAt: r.updated_at || Date.now(),
      updatedBy: r.updated_by || "admin",
    });
  }

  const rowsSessions = db.query("SELECT * FROM sessions").all() as any[];
  for (const r of rowsSessions) {
    let parsedGroups: string[] = [];
    try {
      if (r.assigned_groups) parsedGroups = JSON.parse(r.assigned_groups);
    } catch {
      parsedGroups = [];
    }
    Map.prototype.set.call(sessions, r.session_code, {
      sessionCode: r.session_code,
      startTime: r.start_time,
      durationMinutes: r.duration_minutes,
      aiOption: r.ai_option,
      aiValidityMinutes: r.ai_validity_minutes,
      defaultTokenBudget: r.default_token_budget,
      allowedStudentIds: new Set(JSON.parse(r.allowed_student_ids)),
      assignedGroups: parsedGroups,
      createdAt: r.created_at || Date.now(),
      createdBy: r.created_by || "admin",
      updatedAt: r.updated_at || r.created_at || Date.now(),
      updatedBy: r.updated_by || "admin",
    });
  }

  const rowsStates = db.query("SELECT * FROM session_states").all() as any[];
  const repairedSessionCodes = new Set<string>();
  for (const r of rowsStates) {
    const key = `${r.session_code}:${r.student_id}`;
    Map.prototype.set.call(sessionStates, key, {
      sessionCode: r.session_code,
      studentId: r.student_id,
      hasLoggedIn: r.has_logged_in === 1,
      loginTimestamp: r.login_timestamp,
      tokensConsumed: r.tokens_consumed,
      reassigned: r.reassigned === 1,
      latestClassification: r.latest_classification || "none",
    });

    const session = sessions.get(r.session_code);
    if (session && !session.allowedStudentIds.has(r.student_id)) {
      session.allowedStudentIds.add(r.student_id);
      repairedSessionCodes.add(r.session_code);
    }
  }

  for (const sessionCode of repairedSessionCodes) {
    const session = sessions.get(sessionCode);
    if (session) {
      sessions.set(sessionCode, session);
    }
  }

  const rowsGroups = db.query("SELECT * FROM student_groups").all() as any[];
  for (const r of rowsGroups) {
    Map.prototype.set.call(studentGroups, r.name, {
      name: r.name,
      userIds: JSON.parse(r.user_ids),
      createdAt: r.created_at || Date.now(),
      createdBy: r.created_by || "admin",
      updatedAt: r.updated_at || Date.now(),
      updatedBy: r.updated_by || "admin",
    });
  }

  console.log(
    `[Db] Loaded from SQLite: ${lecturerAccounts.size} lecturers, ${studentAccounts.size} students, ${sessions.size} sessions, ${sessionStates.size} session states, ${studentGroups.size} groups.`,
  );
} catch (err) {
  console.error("[Db] Error loading from SQLite database:", err);
}

// Re-populate RAM cache from SQLite after server restart or Redis flush.
// Ensures active student exam sessions retain token limits and authentication state without forcing re-login.
export async function syncAllDataToRedis() {
  const { redis } = await import("./redis");
  if (!redis || redis.status !== "ready") {
    console.log("[Db] Redis is not ready yet. Skipping Redis auto-hydration.");
    return;
  }

  let hydratedCount = 0;
  const nowSec = Math.floor(Date.now() / 1000);

  try {
    for (const session of sessions.values()) {
      const startSec = session.startTime || Math.floor((session.createdAt || Date.now()) / 1000);
      const durationSec = session.durationMinutes === -1 ? 86400 * 30 : (session.durationMinutes || 60) * 60;
      const endSec = startSec + durationSec;

      if (nowSec >= endSec) continue;

      const remainingSec = Math.max(60, endSec - nowSec);

      for (const state of sessionStates.values()) {
        if (state.sessionCode !== session.sessionCode) continue;
        if (!state.hasLoggedIn || state.reassigned) continue;

        const redisKey = `session:user:${session.sessionCode}:${state.studentId}`;
        await redis.hset(redisKey, {
          studentId: state.studentId,
          sessionCode: session.sessionCode,
          hasLoggedIn: "true",
          tokensConsumed: String(state.tokensConsumed || 0),
          budget: String(session.defaultTokenBudget || 100000000),
          latestClassification: state.latestClassification || "none",
        });
        await redis.expire(redisKey, remainingSec);
        hydratedCount++;
      }
    }
    console.log(
      `[Db] Redis auto-hydration complete. Hydrated ${hydratedCount} active student sessions into Redis.`,
    );
  } catch (err: any) {
    console.error("[Db] Error during Redis auto-hydration:", err?.message || err);
  }
}
