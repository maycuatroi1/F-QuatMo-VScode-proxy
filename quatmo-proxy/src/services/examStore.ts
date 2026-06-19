// ─── FLOW ────────────────────────────────────────────────────────────────────
//
//  Quản lý cấu trúc dữ liệu lưu trữ tạm thời trong bộ nhớ RAM (In-Memory Store).
//  Gồm:
//    - studentAccounts: Bảng danh bạ tài khoản & mật khẩu sinh viên (toàn cục)
//    - exams: Cấu hình phòng thi và danh sách MSSV được phép thi
//    - examStates: Trạng thái tiêu thụ token và trạng thái login thực tế của SV
//
// ─────────────────────────────────────────────────────────────────────────────

export interface StudentAccount {
  studentId: string;
  passwordHash: string;
}

export interface Exam {
  examCode: string;
  startTime: number;
  durationMinutes: number;
  aiOption: "chatbot" | "agent" | "none";
  aiValidityMinutes: number;
  defaultTokenBudget: number;
  allowedStudentIds: Set<string>;
  createdAt: number;
}

export interface StudentExamState {
  examCode: string;
  studentId: string;
  hasLoggedIn: boolean;
  loginTimestamp: number;
  tokensConsumed: number;
  reassigned: boolean;
}

export const studentAccounts = new Map<string, StudentAccount>();
export const exams = new Map<string, Exam>();
export const examStates = new Map<string, StudentExamState>();
