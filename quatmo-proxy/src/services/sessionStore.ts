import { Database } from "bun:sqlite";
import path from "path";
import fs from "fs";

export interface StudentAccount {
  studentId: string;
  passwordHash: string;
}

export interface Session {
  sessionCode: string;
  startTime: number;
  durationMinutes: number;
  aiOption: "chatbot" | "agent" | "none";
  aiValidityMinutes: number;
  defaultTokenBudget: number;
  allowedStudentIds: Set<string>;
  createdAt: number;
}

export interface StudentSessionState {
  sessionCode: string;
  studentId: string;
  hasLoggedIn: boolean;
  loginTimestamp: number;
  tokensConsumed: number;
  reassigned: boolean;
}

export interface Group {
  name: string;
  userIds: string[];
}

const logsDir = path.resolve(process.cwd(), "logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}
const dbPath = path.join(logsDir, "quatmo.db");
const db = new Database(dbPath);

db.run(`
  CREATE TABLE IF NOT EXISTS student_accounts (
    student_id TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS sessions (
    session_code TEXT PRIMARY KEY,
    start_time INTEGER NOT NULL,
    duration_minutes INTEGER NOT NULL,
    ai_option TEXT NOT NULL,
    ai_validity_minutes INTEGER NOT NULL,
    default_token_budget INTEGER NOT NULL,
    allowed_student_ids TEXT NOT NULL, -- JSON array
    created_at INTEGER NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS session_states (
    session_code TEXT,
    student_id TEXT,
    has_logged_in INTEGER NOT NULL,
    login_timestamp INTEGER NOT NULL,
    tokens_consumed INTEGER NOT NULL,
    reassigned INTEGER NOT NULL,
    PRIMARY KEY (session_code, student_id)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS student_groups (
    name TEXT PRIMARY KEY,
    user_ids TEXT NOT NULL -- JSON array
  )
`);

const stmtSaveStudent = db.prepare(`
  INSERT OR REPLACE INTO student_accounts (student_id, password_hash)
  VALUES ($id, $hash)
`);

const stmtDeleteStudent = db.prepare(`
  DELETE FROM student_accounts WHERE student_id = $id
`);

const stmtSaveSession = db.prepare(`
  INSERT OR REPLACE INTO sessions (session_code, start_time, duration_minutes, ai_option, ai_validity_minutes, default_token_budget, allowed_student_ids, created_at)
  VALUES ($code, $start, $dur, $ai_opt, $ai_val, $budget, $students, $created)
`);

const stmtDeleteSession = db.prepare(`
  DELETE FROM sessions WHERE session_code = $code
`);

const stmtSaveState = db.prepare(`
  INSERT OR REPLACE INTO session_states (session_code, student_id, has_logged_in, login_timestamp, tokens_consumed, reassigned)
  VALUES ($code, $student, $has_login, $login_time, $tokens, $reassign)
`);

const stmtDeleteState = db.prepare(`
  DELETE FROM session_states WHERE session_code = $code AND student_id = $student
`);

const stmtSaveGroup = db.prepare(`
  INSERT OR REPLACE INTO student_groups (name, user_ids)
  VALUES ($name, $users)
`);

const stmtDeleteGroup = db.prepare(`
  DELETE FROM student_groups WHERE name = $name
`);

export class PersistedStudentAccounts extends Map<string, StudentAccount> {
  set(key: string, value: StudentAccount): this {
    super.set(key, value);
    stmtSaveStudent.run({ $id: key, $hash: value.passwordHash });
    return this;
  }
  delete(key: string): boolean {
    const existed = super.delete(key);
    if (existed) {
      stmtDeleteStudent.run({ $id: key });
    }
    return existed;
  }
}

export class PersistedSessions extends Map<string, Session> {
  set(key: string, value: Session): this {
    super.set(key, value);
    stmtSaveSession.run({
      $code: key,
      $start: value.startTime,
      $dur: value.durationMinutes,
      $ai_opt: value.aiOption,
      $ai_val: value.aiValidityMinutes,
      $budget: value.defaultTokenBudget,
      $students: JSON.stringify(Array.from(value.allowedStudentIds)),
      $created: value.createdAt,
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
    super.set(key, value);
    stmtSaveGroup.run({
      $name: key,
      $users: JSON.stringify(value.userIds),
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

export const studentAccounts = new PersistedStudentAccounts();
export const sessions = new PersistedSessions();
export const sessionStates = new PersistedSessionStates();
export const studentGroups = new PersistedGroups();

try {
  const rowsAccounts = db
    .query("SELECT * FROM student_accounts")
    .all() as any[];
  for (const r of rowsAccounts) {
    Map.prototype.set.call(studentAccounts, r.student_id, {
      studentId: r.student_id,
      passwordHash: r.password_hash,
    });
  }

  const rowsSessions = db.query("SELECT * FROM sessions").all() as any[];
  for (const r of rowsSessions) {
    Map.prototype.set.call(sessions, r.session_code, {
      sessionCode: r.session_code,
      startTime: r.start_time,
      durationMinutes: r.duration_minutes,
      aiOption: r.ai_option,
      aiValidityMinutes: r.ai_validity_minutes,
      defaultTokenBudget: r.default_token_budget,
      allowedStudentIds: new Set(JSON.parse(r.allowed_student_ids)),
      createdAt: r.created_at,
    });
  }

  const rowsStates = db.query("SELECT * FROM session_states").all() as any[];
  for (const r of rowsStates) {
    const key = `${r.session_code}:${r.student_id}`;
    Map.prototype.set.call(sessionStates, key, {
      sessionCode: r.session_code,
      studentId: r.student_id,
      hasLoggedIn: r.has_logged_in === 1,
      loginTimestamp: r.login_timestamp,
      tokensConsumed: r.tokens_consumed,
      reassigned: r.reassigned === 1,
    });
  }

  const rowsGroups = db.query("SELECT * FROM student_groups").all() as any[];
  for (const r of rowsGroups) {
    Map.prototype.set.call(studentGroups, r.name, {
      name: r.name,
      userIds: JSON.parse(r.user_ids),
    });
  }

  console.log(
    `[Db] Loaded from SQLite: ${studentAccounts.size} students, ${sessions.size} sessions, ${sessionStates.size} session states, ${studentGroups.size} groups.`,
  );
} catch (err) {
  console.error("[Db] Error loading from SQLite database:", err);
}
