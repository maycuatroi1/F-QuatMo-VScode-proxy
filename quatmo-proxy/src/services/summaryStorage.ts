import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { s3Storage } from "./s3Storage";

const execFileAsync = promisify(execFile);

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
  private serviceUrl: string;
  private cliScriptPath: string;
  private engineBinPath?: string;

  constructor() {
    this.serviceUrl =
      process.env.SUMMARY_SERVICE_URL || "http://127.0.0.1:5050";
    this.cliScriptPath =
      process.env.SUMMARY_CLI_PATH ||
      path.resolve(
        process.cwd(),
        "..",
        "..",
        "PhaseSUMMARY",
        "summary_tool",
        "generate_cli.py",
      );
    this.engineBinPath = process.env.SUMMARY_ENGINE_BIN;
  }

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
      this.engineBinPath ||
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
    await fs.promises.writeFile(mdPath, markdown, "utf-8");
    if (metadata) {
      const jsonContent =
        typeof metadata === "string"
          ? metadata
          : JSON.stringify(metadata, null, 2);
      await fs.promises.writeFile(jsonPath, jsonContent, "utf-8");
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
    await fs.promises.writeFile(localManifestPath, manifestMarkdown, "utf-8");

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

  /**
   * Finds the session zip archive path on local disk.
   */
  public findSessionZip(sessionCode: string): string | null {
    const safeSession = sanitizeSegment(sessionCode).toUpperCase();
    const exactCandidates = [
      path.resolve(process.cwd(), "logs", "sessions", `${safeSession}-logs.zip`),
      path.resolve(process.cwd(), "logs", "sessions", `${safeSession}.zip`),
      path.resolve(process.cwd(), "logs", "sessions", `logs_${safeSession}.zip`),
      path.resolve(process.cwd(), "logs", `${safeSession}.zip`),
      path.resolve(
        process.cwd(),
        "..",
        "..",
        "data_analyz_survey",
        `migrated_logs_${safeSession} (2).zip`,
      ),
      path.resolve(
        process.cwd(),
        "..",
        "..",
        "data_analyz_survey",
        `migrated_logs_${safeSession}.zip`,
      ),
      path.resolve(
        process.cwd(),
        "..",
        "..",
        "data_analyz_survey",
        `${safeSession}.zip`,
      ),
      path.resolve(
        process.cwd(),
        "..",
        "..",
        "dataTest",
        "lopthayDat",
        `logs_${safeSession}.zip`,
      ),
      path.resolve(
        process.cwd(),
        "..",
        "..",
        "dataTest",
        "lopthayDat",
        `migrated_logs_new_${safeSession}.zip`,
      ),
      path.resolve(
        process.cwd(),
        "..",
        "..",
        "md",
        `logs_${safeSession}.zip`,
      ),
    ];

    for (const c of exactCandidates) {
      if (fs.existsSync(c)) {
        return c;
      }
    }

    // Directory scanning: search across historical survey and test folders
    const scanDirs = [
      path.resolve(process.cwd(), "logs", "sessions"),
      path.resolve(process.cwd(), "..", "..", "data_analyz_survey"),
      path.resolve(process.cwd(), "..", "..", "dataTest", "lopthayDat"),
      path.resolve(process.cwd(), "..", "..", "dataTest"),
      path.resolve(process.cwd(), "..", "..", "md"),
    ];

    for (const sDir of scanDirs) {
      if (fs.existsSync(sDir)) {
        try {
          const files = fs.readdirSync(sDir);
          for (const f of files) {
            if (f.endsWith(".zip") && f.toUpperCase().includes(safeSession)) {
              return path.join(sDir, f);
            }
          }
        } catch {}
      }
    }

    return null;
  }

  /**
   * Generates summary for a single student and saves to dual-mode storage.
   */
  public async generateStudentSummary(
    sessionCode: string,
    studentId: string,
    customZipPath?: string,
  ): Promise<any> {
    const zipPath = customZipPath || this.findSessionZip(sessionCode);

    // Query summary microservice daemon if available (only for live sessions without custom zip)
    if (!customZipPath) {
      try {
        const resp = await fetch(
          `${this.serviceUrl}/api/summary/${encodeURIComponent(studentId)}`,
          {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(180000), // 3 minutes to allow primary gemma-4-26b generation
          },
        );
        if (resp.ok) {
          const data = (await resp.json()) as any;
          if (data.markdown) {
            await this.saveStudentSummary(
              sessionCode,
              studentId,
              data.markdown,
              {
                check_report: data.check_report,
                metrics: data.metrics,
              },
            );
            return {
              ok: true,
              student_id: studentId,
              session_code: sessionCode,
              markdown: data.markdown,
              check_report: data.check_report,
              metrics: data.metrics,
              trigger: "daemon",
            };
          }
        }
      } catch {}
    }

    // Fallback to local CLI generator execution
    if (!zipPath) {
      throw new Error(
        `Cannot find telemetry zip archive for session ${sessionCode}`,
      );
    }

    const resolvedBin = this.getResolvedEngineBin();
    let stdoutContent: string;

    if (resolvedBin) {
      // Execute compiled standalone engine binary
      const args = ["--zip", zipPath, "--student", studentId, "--json"];
      const { stdout } = await execFileAsync(resolvedBin, args, {
        timeout: 300000,
        maxBuffer: 10 * 1024 * 1024,
      });
      stdoutContent = stdout;
    } else {
      // Execute Python engine CLI script
      const pythonBin = process.platform === "win32" ? "py" : "python3";
      const args = [
        this.cliScriptPath,
        "--zip",
        zipPath,
        "--student",
        studentId,
        "--json",
      ];
      const { stdout } = await execFileAsync(pythonBin, args, {
        timeout: 300000,
        maxBuffer: 10 * 1024 * 1024,
      });
      stdoutContent = stdout;
    }

    const parsed = JSON.parse(stdoutContent);
    if (parsed.ok && parsed.markdown) {
      await this.saveStudentSummary(
        sessionCode,
        studentId,
        parsed.markdown,
        {
          check_report: parsed.check_report,
          metrics: parsed.metrics,
        },
      );
    }
    return parsed;
  }

  /**
   * Generates summary for all students in a session and stores manifest.
   */
  public async generateSessionSummaries(
    sessionCode: string,
    customZipPath?: string,
  ): Promise<any> {
    const zipPath = customZipPath || this.findSessionZip(sessionCode);
    if (!zipPath) {
      throw new Error(
        `Cannot find telemetry zip archive for session ${sessionCode}`,
      );
    }

    const resolvedBin = this.getResolvedEngineBin();
    let stdoutContent: string;

    if (resolvedBin) {
      const args = ["--zip", zipPath, "--json"];
      const { stdout } = await execFileAsync(resolvedBin, args, {
        timeout: 1800000,
        maxBuffer: 50 * 1024 * 1024,
      });
      stdoutContent = stdout;
    } else {
      const pythonBin = process.platform === "win32" ? "py" : "python3";
      const args = [this.cliScriptPath, "--zip", zipPath, "--json"];
      const { stdout } = await execFileAsync(pythonBin, args, {
        timeout: 1800000,
        maxBuffer: 50 * 1024 * 1024,
      });
      stdoutContent = stdout;
    }

    const parsed = JSON.parse(stdoutContent);
    if (parsed.ok && parsed.manifest_content) {
      await this.saveSessionManifest(sessionCode, parsed.manifest_content);
    }
    return parsed;
  }
}

export const summaryStorageService = new SummaryStorageService();
