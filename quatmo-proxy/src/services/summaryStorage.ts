import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { randomUUID } from "node:crypto";
import { s3Storage } from "./s3Storage";
import { createSummaryArchive, validateSummaryZip } from "./summaryArchive";
import type { SummaryProgressCallback } from "./summaryProgress";

const execFileAsync = promisify(execFile);

export function getSummaryEngineDiagnostic(stdout: unknown) {
  if (typeof stdout !== "string") return undefined;
  const line = stdout.trim().split(/\r?\n/).at(-1)!;
  if (line.length > 8192) return undefined;
  try {
    const result = JSON.parse(line);
    if (result?.ok !== false) return undefined;
    const phases = ["memory_limit", "archive_validation", "student_validation", "pipeline_initialization", "single_generation", "batch_generation"];
    const types = ["MemoryError", "ValueError", "BadZipFile", "LargeZipFile", "PermissionError", "FileNotFoundError", "OSError", "RuntimeError", "KeyError", "TypeError", "AttributeError", "JSONDecodeError", "UnicodeDecodeError"];
    const reasons = new Map([
      ["Summary archive exceeds size limits.", "archive_size_limit"],
      ["Summary archive contains too many entries.", "archive_file_limit"],
      ["Summary archive contains unsafe or duplicate paths.", "archive_unsafe_paths"],
      ["Summary archive exceeds decompression limits.", "archive_decompression_limit"],
      ["Summary archive is empty.", "archive_empty"],
      ["Unsafe or ambiguous student ID in summary archive.", "student_identity_invalid"],
      ["Invalid summary memory limit.", "memory_limit_invalid"],
      ["Invalid summary archive limits.", "archive_limits_invalid"],
    ]);
    return {
      phase: phases.includes(result.phase) ? result.phase : "unknown",
      errorType: types.includes(result.error_type) ? result.error_type : "unknown",
      reason: reasons.get(result.error) || "unclassified",
    };
  } catch { return undefined; }
}

async function writeSummaryFile(filename: string, content: string): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.promises.rename(temporary, filename);
  } finally {
    await fs.promises.unlink(temporary).catch(() => {});
  }
}

function sanitizeSegment(name: string): string {
  return name.replace(/[^a-zA-Z0-9\-_]/g, "");
}

export interface StudentSummaryResult {
  ok: boolean;
  sessionCode: string;
  studentId: string;
  markdown: string;
  metadata?: any;
  source: "s3" | "local";
}

export class SummaryStorageService {

  /**
   * Resolves the local session storage directory: logs/sessions/{SESSION}/{STUDENT}/
   */
  public getLocalStudentDir(sessionCode: string, studentId: string): string {
    const safeSession = sanitizeSegment(sessionCode).toUpperCase();
    const safeStudent = sanitizeSegment(studentId).toUpperCase();
    return path.resolve(
      process.cwd(),
      "logs",
      "sessions",
      safeSession,
      safeStudent,
    );
  }

  public getLocalSessionDir(sessionCode: string): string {
    const safeSession = sanitizeSegment(sessionCode).toUpperCase();
    return path.resolve(process.cwd(), "logs", "sessions", safeSession);
  }

  public getResolvedEngineBin(): string | null {
    const rawBin =
      process.env.SUMMARY_ENGINE_BIN ||
      (process.platform === "win32" ? "bin/summary_engine.exe" : "bin/summary_engine");
    const candidate = path.isAbsolute(rawBin)
      ? rawBin
      : path.resolve(process.cwd(), rawBin);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    return null;
  }

  private async runEngine(sessionCode: string, studentId?: string, customZipPath?: string, onProgress?: SummaryProgressCallback): Promise<any> {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionCode) || (studentId !== undefined && !/^[A-Za-z0-9_-]+$/.test(studentId))) throw new Error("Invalid summary session or student ID.");
    const binary = this.getResolvedEngineBin();
    const cliScriptPath = process.env.SUMMARY_CLI_PATH || path.resolve("summary_tool", "generate_cli.py");
    if (!binary && !fs.existsSync(cliScriptPath)) {
      throw new Error("Summary engine unavailable. Configure SUMMARY_ENGINE_BIN or SUMMARY_CLI_PATH.");
    }
    const tempRoot = path.resolve("logs", "temp_summaries");
    await fs.promises.mkdir(tempRoot, { recursive: true });
    const jobDir = await fs.promises.mkdtemp(path.join(tempRoot, "job-"));
    try {
      const zipPath = customZipPath || await createSummaryArchive(sessionCode, jobDir);
      if (customZipPath) validateSummaryZip(await fs.promises.readFile(zipPath));
      onProgress?.({ stage: "validating" });
      const outputDir = path.join(jobDir, "output");
      const args = ["--zip", zipPath, "--output-dir", outputDir, "--json"];
      if (studentId) args.push("--student", studentId);
      if (onProgress && !binary) args.push("--progress");
      const command = binary || process.env.SUMMARY_PYTHON_BIN || (process.platform === "win32" ? "py" : "python3");
      // The engine needs model credentials, never proxy/JWT/DB/storage credentials.
      const allowedEnv = new Set([
        "PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ",
        "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
        "CUSTOM_BASE_URL", "CUSTOM_API_KEY", "CUSTOM_MODEL_NAME", "CUSTOM_MODEL_ALIASES",
        "CLASSIFIER_API_URL", "CLASSIFIER_API_KEY", "CLASSIFIER_MODEL",
        "LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "LLM_ENABLED", "LLM_TEMPERATURE", "LLM_TIMEOUT_S", "LLM_MAX_RETRIES",
        "SUMMARY_LLM_BASE_URL", "SUMMARY_LLM_API_KEY", "SUMMARY_LLM_MODEL", "SUMMARY_LLM_ALIASES", "SUMMARY_LLM_ENABLED", "SUMMARY_LLM_TIMEOUT_S",
        "SUMMARY_ENGINE_MEMORY_MB", "MAX_UPLOAD_BYTES", "MAX_UPLOAD_FILES",
        "SUMMARY_MAX_ARCHIVE_BYTES", "SUMMARY_MAX_ARCHIVE_FILES",
      ]);
      const engineEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowedEnv.has(name)));
      const execution = execFileAsync(command, binary ? args : [cliScriptPath, ...args], {
        env: { ...engineEnv, PYTHONDONTWRITEBYTECODE: "1" },
        timeout: studentId ? 300000 : 1800000,
        maxBuffer: 50 * 1024 * 1024,
      });
      let pending = "";
      execution.child.stderr?.on("data", (chunk: Buffer | string) => {
        if (!onProgress) return;
        pending += chunk.toString();
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || "";
        if (pending.length > 4096) pending = "";
        for (const line of lines) {
          if (!line.startsWith("SUMMARY_PROGRESS ") || line.length > 4096) continue;
          try {
            const event = JSON.parse(line.slice(17));
            if (Number.isSafeInteger(event.completed) && Number.isSafeInteger(event.total) && event.total >= 0 && event.completed >= 0 && event.completed <= event.total) {
              onProgress({ stage: "generating", completed: event.completed, total: event.total });
            }
          } catch { /* Non-progress stderr is never exposed through the progress API. */ }
        }
      });
      const { stdout } = await execution.catch(error => {
        // Keep only allowlisted diagnostic fields from the worker's final JSON.
        const failure = Object.assign(new Error("Summary engine execution failed."), {
          code: error.code,
          signal: error.signal,
          engineDiagnostic: getSummaryEngineDiagnostic(error.stdout),
        });
        throw failure;
      });
      // The existing CLI writes progress before its final one-line JSON payload.
      const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!);
      if (!result.ok) throw new Error(result.error || "Summary engine failed.");
      if (result.analysisRuleVersion !== "scheduled-signin-v1") {
        throw new Error("Summary engine must implement scheduled-signin-v1; update the configured engine.");
      }
      if (studentId && (result.student_id !== studentId || typeof result.markdown !== "string" || !result.markdown)) {
        throw new Error("Summary engine returned an invalid student result.");
      }
      if (!studentId) {
        if (!Array.isArray(result.students) || typeof result.manifest_content !== "string") throw new Error("Summary engine returned an invalid session result.");
        const stem = path.basename(zipPath, path.extname(zipPath));
        const generatedRoot = path.join(outputDir, stem);
        const reports: Record<string, any> = Object.create(null);
        for (const id of result.students) {
          if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Summary engine returned an invalid student ID.");
          let markdownPath = path.join(generatedRoot, "students", `${id}_summary.md`);
          // Earlier standalone engines wrote reports directly in the session output folder.
          if (!fs.existsSync(markdownPath)) markdownPath = path.join(generatedRoot, `${id}_summary.md`);
          if (!fs.existsSync(markdownPath)) throw new Error(`Summary missing for student ${id}.`);
          const metadataPath = path.join(generatedRoot, "stages", id, "check_report.json");
          reports[id] = {
            student_id: id,
            summaryRuleVersion: result.summaryRuleVersion, analysisRuleVersion: result.analysisRuleVersion,
            markdown: await fs.promises.readFile(markdownPath, "utf8"),
            check_report: fs.existsSync(metadataPath) ? JSON.parse(await fs.promises.readFile(metadataPath, "utf8")) : undefined,
          };
        }
        result.reports = reports;
      }
      return result;
    } finally {
      await fs.promises.rm(jobDir, { recursive: true, force: true });
    }
  }

  public async generateStudentSummary(sessionCode: string, studentId: string, customZipPath?: string, persist = true, onProgress?: SummaryProgressCallback): Promise<any> {
    const result = await this.runEngine(sessionCode, studentId, customZipPath, onProgress);
    onProgress?.({ stage: "saving", completed: 1, total: 1 });
    if (persist) await this.saveStudentSummary(sessionCode, studentId, result.markdown, { check_report: result.check_report, metrics: result.metrics, summaryRuleVersion: result.summaryRuleVersion, analysisRuleVersion: result.analysisRuleVersion });
    return result;
  }

  public async generateSessionSummaries(sessionCode: string, customZipPath?: string, persist = true, onProgress?: SummaryProgressCallback): Promise<any> {
    const result = await this.runEngine(sessionCode, undefined, customZipPath, onProgress);
    const total = Object.keys(result.reports).length;
    onProgress?.({ stage: "saving", completed: total, total });
    if (persist) {
      for (const [studentId, report] of Object.entries<any>(result.reports)) {
        await this.saveStudentSummary(sessionCode, studentId, report.markdown, { check_report: report.check_report, metrics: report.metrics, summaryRuleVersion: result.summaryRuleVersion, analysisRuleVersion: result.analysisRuleVersion });
      }
      await this.saveSessionManifest(sessionCode, result.manifest_content);
    }
    return result;
  }

  /**
   * Saves student summary markdown and json metadata.
   * Dual-mode: Always saves locally (dev/test & cache) and syncs to S3 when S3 is configured.
   * If S3 is not configured, silently succeeds with local storage.
   */
  public async saveStudentSummary(
    sessionCode: string,
    studentId: string,
    markdown: string,
    metadata?: any,
  ): Promise<{
    ok: boolean;
    localSaved: boolean;
    s3Saved: boolean;
    localPath: string;
  }> {
    const studentDir = this.getLocalStudentDir(sessionCode, studentId);
    await fs.promises.mkdir(studentDir, { recursive: true });

    const mdPath = path.join(studentDir, "summary.md");
    const jsonPath = path.join(studentDir, "summary.json");

    // Persist local copy
    await writeSummaryFile(mdPath, markdown);
    if (metadata) {
      const jsonContent =
        typeof metadata === "string"
          ? metadata
          : JSON.stringify(metadata, null, 2);
      await writeSummaryFile(jsonPath, jsonContent);
    }

    let s3Saved = false;
    // Sync to remote S3 storage if configured
    if (s3Storage.isAvailable()) {
      s3Saved = await s3Storage.uploadStudentSummary(
        sessionCode,
        studentId,
        markdown,
        metadata,
      );
      if (s3Saved) {
        console.log(
          `[Summary Storage] Successfully synced summary to S3 for ${studentId} in session ${sessionCode}`,
        );

        // Optional purge of local copy after successful S3 sync
        if (process.env.PURGE_LOCAL_SUMMARY_AFTER_S3 === "true") {
          try {
            await fs.promises.unlink(mdPath).catch(() => {});
            await fs.promises.unlink(jsonPath).catch(() => {});
            console.log(
              `[Summary Storage] Pruned local summary copy for ${studentId} (PURGE_LOCAL_SUMMARY_AFTER_S3=true)`,
            );
          } catch {}
        }
      }
    } else {
      console.log(
        `[Summary Storage] S3 not configured or inactive. Persisted summary locally at ${mdPath}`,
      );
    }

    return { ok: true, localSaved: true, s3Saved, localPath: mdPath };
  }

  /**
   * Retrieves student summary.
   * Tries local storage first for speed, then checks S3 if not found locally.
   */
  public async getStudentSummary(
    sessionCode: string,
    studentId: string,
  ): Promise<StudentSummaryResult | null> {
    const studentDir = this.getLocalStudentDir(sessionCode, studentId);
    const mdPath = path.join(studentDir, "summary.md");
    const jsonPath = path.join(studentDir, "summary.json");

    // Check local filesystem cache
    if (fs.existsSync(mdPath)) {
      try {
        const markdown = await fs.promises.readFile(mdPath, "utf-8");
        let metadata: any = null;
        if (fs.existsSync(jsonPath)) {
          const jsonStr = await fs.promises.readFile(jsonPath, "utf-8");
          try {
            metadata = JSON.parse(jsonStr);
          } catch {}
        }
        return {
          ok: true,
          sessionCode,
          studentId,
          markdown,
          metadata,
          source: "local",
        };
      } catch (err) {
        console.warn(
          `[Summary Storage] Failed reading local summary for ${studentId}:`,
          err,
        );
      }
    }

    // Query remote S3 storage if available
    if (s3Storage.isAvailable()) {
      try {
        const s3Data = await s3Storage.getStudentSummary(
          sessionCode,
          studentId,
        );
        if (s3Data && s3Data.markdown) {
          return {
            ok: true,
            sessionCode,
            studentId,
            markdown: s3Data.markdown,
            metadata: s3Data.metadata,
            source: "s3",
          };
        }
      } catch (err) {
        console.error(
          `[Summary Storage] S3 fetch error for ${studentId}:`,
          err,
        );
      }
    }

    return null;
  }

  /**
   * Saves master session manifest summary.
   */
  public async saveSessionManifest(
    sessionCode: string,
    manifestMarkdown: string,
  ): Promise<boolean> {
    const sessionDir = this.getLocalSessionDir(sessionCode);
    await fs.promises.mkdir(sessionDir, { recursive: true });

    const localManifestPath = path.join(
      sessionDir,
      "session_manifest_summary.md",
    );
    await writeSummaryFile(localManifestPath, manifestMarkdown);

    if (s3Storage.isAvailable()) {
      await s3Storage.uploadSessionSummaryManifest(
        sessionCode,
        manifestMarkdown,
      );
    }
    return true;
  }

  /**
   * Retrieves master session manifest summary.
   */
  public async getSessionManifest(
    sessionCode: string,
  ): Promise<{ manifestMarkdown: string; source: "s3" | "local" } | null> {
    const sessionDir = this.getLocalSessionDir(sessionCode);
    const localManifestPath = path.join(
      sessionDir,
      "session_manifest_summary.md",
    );

    if (fs.existsSync(localManifestPath)) {
      const manifestMarkdown = await fs.promises.readFile(
        localManifestPath,
        "utf-8",
      );
      return { manifestMarkdown, source: "local" };
    }

    if (s3Storage.isAvailable()) {
      const s3Manifest =
        await s3Storage.getSessionSummaryManifest(sessionCode);
      if (s3Manifest) {
        return { manifestMarkdown: s3Manifest, source: "s3" };
      }
    }

    return null;
  }

  /**
   * Lists summary availability for students in a session.
   */
  public async listSessionSummaries(
    sessionCode: string,
  ): Promise<
    Array<{
      studentId: string;
      hasSummary: boolean;
      source: "s3" | "local" | "none";
    }>
  > {
    const safeSession = sanitizeSegment(sessionCode).toUpperCase();
    const sessionDir = this.getLocalSessionDir(safeSession);
    const resultMap = new Map<
      string,
      {
        studentId: string;
        hasSummary: boolean;
        source: "s3" | "local" | "none";
      }
    >();

    // Scan local directory
    if (fs.existsSync(sessionDir)) {
      try {
        const entries = await fs.promises.readdir(sessionDir, {
          withFileTypes: true,
        });
        for (const e of entries) {
          if (e.isDirectory()) {
            const sId = e.name;
            const mdPath = path.join(sessionDir, sId, "summary.md");
            if (fs.existsSync(mdPath)) {
              resultMap.set(sId, {
                studentId: sId,
                hasSummary: true,
                source: "local",
              });
            } else {
              resultMap.set(sId, {
                studentId: sId,
                hasSummary: false,
                source: "none",
              });
            }
          }
        }
      } catch {}
    }

    // Check S3
    if (s3Storage.isAvailable()) {
      try {
        const s3Students =
          await s3Storage.listStudentSummariesFromS3(safeSession);
        for (const sId of s3Students) {
          const existing = resultMap.get(sId);
          if (!existing || !existing.hasSummary) {
            resultMap.set(sId, {
              studentId: sId,
              hasSummary: true,
              source: "s3",
            });
          }
        }
      } catch {}
    }

    return Array.from(resultMap.values());
  }

}

export const summaryStorageService = new SummaryStorageService();
