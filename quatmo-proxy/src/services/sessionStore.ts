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

export const studentAccounts = new Map<string, StudentAccount>();
export const sessions = new Map<string, Session>();
export const sessionStates = new Map<string, StudentSessionState>();
