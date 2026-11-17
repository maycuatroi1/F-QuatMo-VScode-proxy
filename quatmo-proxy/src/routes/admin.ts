import { Hono } from "hono";
import { limitSummaryGeneration } from "../modules/visualization/summaryGuard";
import { getStudentSummary, generateStudentSummary, getSessionSummaryManifest, generateSessionSummaries, generateSummaryFromZip, listSessionSummaries, summaryZipLimit } from "../modules/visualization/summaryHandlers";
import { uploadVisualizeRecord } from "../modules/visualization/recordHandlers";
import { getStorageStatus } from "../modules/storage/adminHandlers";

export { getClientIP } from "../shared/http/clientIP";
import { authenticateAdmin, requireSuperAdmin, requireSessionOwner } from "../middleware/adminAuth";
import { adminLogin, changeAdminPassword } from "../modules/auth/adminHandlers";
import { listSecurityLockouts, unlockSecurityTarget } from "../modules/security/adminHandlers";

import { syncSessionTokens } from "../modules/telemetry/adminHandlers";
import { handleSessionLogDownload, handleAllLogsDownload, handleGuestLogsDownload, handleStudentLogDownload, handleGuestLogDownload } from "../modules/telemetry/downloadHandlers";

import { listVisualizeSessionAccounts } from "../modules/visualization/sessionAccountsHandler";
import { getVisualizeStudentPromptLog } from "../modules/visualization/promptHandlers";
import { listVisualizeSessions } from "../modules/visualization/sessionListHandler";
import { listVisualizeGuests, getVisualizeGuestPromptLog } from "../modules/visualization/guestHandlers";

export { appendJsonLines } from "../modules/telemetry/jsonl";

import { createSession, updateSession, deleteSession, removeSessionStudent, addSessionStudents, reassignSessionStudent, listSessions } from "../modules/sessions/adminHandlers";
import { resetStudentPassword, handleStudentImport, listStudents, deleteStudent, restoreStudent, bulkDeleteStudents } from "../modules/users/adminHandlers";
import { listGroups, saveGroup, addGroupStudents, removeGroupStudent, deleteGroup } from "../modules/groups/adminHandlers";
import { listLecturers, getLecturerDetails, createLecturer, setLecturerStatus, resetLecturerPassword } from "../modules/lecturers/adminHandlers";
import { getVisualizeStudentEventLog } from "../modules/visualization/eventHandlers";

type AdminVariables = {
  caller?: { username: string; role: string; name: string };
};

const adminRouter = new Hono<{ Variables: AdminVariables }>();

// ─── FLOW ────────────────────────────────────────────────────────────────────
//  Middleware protecting Admin data endpoints via PROXY_API_KEY or Admin/Lecturer JWT Token
// ─────────────────────────────────────────────────────────────────────────────

adminRouter.use("*", authenticateAdmin);

// ─── Role / ownership guards ─────────────────────────────────────────────────

adminRouter.use("/sessions/:sessionCode", requireSessionOwner);
adminRouter.use("/sessions/:sessionCode/*", requireSessionOwner);
adminRouter.use("/visualize/sessions/:sessionCode/*", requireSessionOwner);
adminRouter.use("/logs/*", requireSuperAdmin);
adminRouter.use("/guests/*", requireSuperAdmin);
adminRouter.use("/visualize/guests", requireSuperAdmin);
adminRouter.use("/visualize/guests/*", requireSuperAdmin);
adminRouter.use("/s3/*", requireSuperAdmin);
adminRouter.use("/security/*", requireSuperAdmin);

// Admin / Lecturer login endpoint validating credentials and returning signed JWT token
adminRouter.post("/login", adminLogin);

// ─── SECURITY & AUDIT LOCKOUT ENDPOINTS (Super Admin Only) ───────────────────
adminRouter.get("/security/lockouts", listSecurityLockouts);

adminRouter.post("/security/unlock", unlockSecurityTarget);

// ─── LECTURER MANAGEMENT ENDPOINTS (Super Admin Only) ─────────────────────────
adminRouter.get("/lecturers", listLecturers);

adminRouter.get("/lecturers/:username/details", getLecturerDetails);

adminRouter.post("/lecturers", createLecturer);

adminRouter.patch("/lecturers/:username/status", setLecturerStatus);

adminRouter.post("/lecturers/:username/reset-password", resetLecturerPassword);

// Self-service change password for logged-in Lecturer / Admin
adminRouter.post("/change-password", changeAdminPassword);

// ─── STUDENT ACCOUNT ENDPOINTS ────────────────────────────────────────────────
adminRouter.post("/students/:studentId/reset-password", resetStudentPassword);


adminRouter.post("/students", handleStudentImport);
adminRouter.post("/students/import", handleStudentImport);

adminRouter.get("/students", listStudents);

adminRouter.delete("/students/:studentId", deleteStudent);

adminRouter.post("/students/:studentId/restore", restoreStudent);

adminRouter.post("/students/bulk-delete", bulkDeleteStudents);

// ─── SESSION ENDPOINTS ───────────────────────────────────────────────────────
adminRouter.post("/sessions", createSession);

adminRouter.patch("/sessions/:sessionCode", updateSession);

// DELETE Session endpoint (permitted ONLY if no one has joined)
adminRouter.delete("/sessions/:sessionCode", deleteSession);

// DELETE Student from Session (permitted if student has not joined yet)
adminRouter.delete("/sessions/:sessionCode/students/:studentId", removeSessionStudent);

adminRouter.post("/sessions/:sessionCode/students", addSessionStudents);

adminRouter.post("/sessions/:sessionCode/students/:studentId/reassign", reassignSessionStudent);

adminRouter.get("/sessions", listSessions);

// ─── SYNC TOKENS (RECALCULATE FROM LOGS / MANIFEST & UPDATE SQLITE + REDIS) ────
adminRouter.post("/sessions/:sessionCode/sync-tokens", syncSessionTokens);

// ─── LOG DOWNLOAD HELPER & ENDPOINTS ──────────────────────────────────────────

// 1. Session logs (supports multiple path aliases)
adminRouter.get("/sessions/:sessionCode/logs", handleSessionLogDownload);
adminRouter.get("/sessions/:sessionCode/logs/zip", handleSessionLogDownload);
adminRouter.get(
  "/sessions/:sessionCode/download-logs",
  handleSessionLogDownload,
);

// 2. All logs archive (supports /logs/download-all, /logs/zip, /logs/download)
adminRouter.get("/logs/download-all", handleAllLogsDownload);
adminRouter.get("/logs/zip", handleAllLogsDownload);
adminRouter.get("/logs/download", handleAllLogsDownload);

// 3. Guest logs archive
adminRouter.get("/logs/download-guest-logs", handleGuestLogsDownload);
adminRouter.get("/guests/logs/zip", handleGuestLogsDownload);
adminRouter.get("/guests/logs", handleGuestLogsDownload);

// 4. Single student / account log download
adminRouter.get("/sessions/:sessionCode/accounts/:studentId/download", handleStudentLogDownload);

adminRouter.get("/guests/:guestId/download", handleGuestLogDownload);

// ─── VISUALIZE LOGS ENDPOINTS ─────────────────────────────────────────────

// 1. List all sessions with log stats
adminRouter.get("/visualize/sessions", listVisualizeSessions);

// 2. List accounts for a session
adminRouter.get("/visualize/sessions/:sessionCode/accounts", listVisualizeSessionAccounts);

// 3. Get student prompt log
adminRouter.get("/visualize/sessions/:sessionCode/accounts/:studentId/prompt-log", getVisualizeStudentPromptLog);


// 4. Get student event log
adminRouter.get("/visualize/sessions/:sessionCode/accounts/:studentId/event-log", getVisualizeStudentEventLog);

// 5. List guest accounts
adminRouter.get("/visualize/guests", listVisualizeGuests);

// 6. Get guest prompt log
adminRouter.get("/visualize/guests/:guestId/prompt-log", getVisualizeGuestPromptLog);

// 7. Upload full exam record for student / session
adminRouter.post("/visualize/sessions/:sessionCode/accounts/:studentId/upload-record", uploadVisualizeRecord);

// 8. S3 Storage healthcheck & status
adminRouter.get("/s3/status", getStorageStatus);

// ─── GROUP ENDPOINTS ─────────────────────────────────────────────────────────

adminRouter.get("/groups", listGroups);

adminRouter.post("/groups", saveGroup);

adminRouter.post("/groups/:name/students", addGroupStudents);

adminRouter.delete("/groups/:name/students/:studentId", removeGroupStudent);

adminRouter.delete("/groups/:name", deleteGroup);

adminRouter.get("/visualize/sessions/:sessionCode/accounts/:studentId/summary", getStudentSummary);
adminRouter.post("/visualize/sessions/:sessionCode/accounts/:studentId/summary/generate", limitSummaryGeneration, generateStudentSummary);
adminRouter.get("/visualize/sessions/:sessionCode/summary-manifest", getSessionSummaryManifest);
adminRouter.post("/visualize/sessions/:sessionCode/summary/generate-all", limitSummaryGeneration, generateSessionSummaries);
adminRouter.post("/visualize/summary/generate-from-zip", limitSummaryGeneration, summaryZipLimit, generateSummaryFromZip);
adminRouter.get("/visualize/sessions/:sessionCode/summaries", listSessionSummaries);

export { adminRouter };
