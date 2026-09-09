import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import https from "node:https";
import http from "node:http";
import { NodeHttpHandler } from "@smithy/node-http-handler";

function sanitizeSegment(name: string): string {
  return name.replace(/[^a-zA-Z0-9\-_]/g, "");
}

export class S3StorageService {
  private client: S3Client | null = null;
  private bucket: string = "f-vscode-storage";
  private initialized: boolean = false;

  constructor() {
    this.initClient();
  }

  public initClient(): void {
    const endpoint = process.env.S3_ENDPOINT || "https://s3-api.iahn.hanoi.vn";
    const region = process.env.S3_REGION || "us-east-1";
    this.bucket = process.env.S3_BUCKET || "f-vscode-storage";
    const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
    const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();
    const forcePathStyle = process.env.S3_FORCE_PATH_STYLE !== "false";

    if (accessKeyId && secretAccessKey) {
      try {
        const isHttps = endpoint.startsWith("https://");
        const requestHandler = new NodeHttpHandler({
          httpAgent: new http.Agent({
            keepAlive: true,
            maxSockets: 250,
            maxFreeSockets: 50,
            timeout: 30000,
          }),
          httpsAgent: new https.Agent({
            keepAlive: true,
            maxSockets: 250,
            maxFreeSockets: 50,
            timeout: 30000,
          }),
          connectionTimeout: 10000,
          requestTimeout: 30000,
        });

        this.client = new S3Client({
          endpoint,
          region,
          credentials: {
            accessKeyId,
            secretAccessKey,
          },
          forcePathStyle,
          requestHandler,
        });
        this.initialized = true;
        console.log(
          `[S3 Storage] Initialized S3 client -> Endpoint: ${endpoint} | Bucket: ${this.bucket}`,
        );
      } catch (err) {
        console.error("[S3 Storage] Failed to initialize S3 client:", err);
        this.client = null;
        this.initialized = false;
      }
    } else {
      this.client = null;
      this.initialized = false;
    }
  }

  public isAvailable(): boolean {
    if (!this.initialized || !this.client) {
      this.initClient();
    }
    return Boolean(this.client);
  }

  public getBucketName(): string {
    return this.bucket;
  }

  public formatStudentPromptLogKey(
    sessionCode: string,
    studentId: string,
  ): string {
    const safeSession = sanitizeSegment(sessionCode).toUpperCase();
    const safeStudent = sanitizeSegment(studentId).toUpperCase();
    return `sessions/${safeSession}/students/${safeStudent}/prompt_turns.json`;
  }

  public formatGuestPromptLogKey(guestId: string): string {
    const safeGuest = sanitizeSegment(guestId).toUpperCase();
    return `guests/${safeGuest}/prompt_turns.json`;
  }

  public formatExamRecordPrefix(
    sessionCode: string,
    studentId: string,
    recordId?: string,
  ): string {
    const safeSession = sanitizeSegment(sessionCode).toUpperCase();
    const safeStudent = sanitizeSegment(studentId).toUpperCase();
    if (recordId) {
      const safeRecord = sanitizeSegment(recordId);
      return `sessions/${safeSession}/students/${safeStudent}/exam_records/${safeRecord}/`;
    }
    return `sessions/${safeSession}/students/${safeStudent}/exam_records/`;
  }

  public async uploadStudentPromptLog(
    sessionCode: string,
    studentId: string,
    turns: any[],
  ): Promise<boolean> {
    if (!this.isAvailable() || !this.client) return false;

    const key = this.formatStudentPromptLogKey(sessionCode, studentId);
    const body = JSON.stringify(turns, null, 2);

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: "application/json",
        }),
      );
      return true;
    } catch (err) {
      console.error(`[S3 Storage] Failed to upload prompt log to ${key}:`, err);
      return false;
    }
  }

  public async getStudentPromptLog(
    sessionCode: string,
    studentId: string,
  ): Promise<any[] | null> {
    if (!this.isAvailable() || !this.client) return null;

    const key = this.formatStudentPromptLogKey(sessionCode, studentId);
    try {
      const resp = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      if (!resp.Body) return null;
      const str = await resp.Body.transformToString("utf-8");
      const parsed = JSON.parse(str);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err: any) {
      if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) {
        return null;
      }
      console.error(`[S3 Storage] Failed to get prompt log from ${key}:`, err);
      return null;
    }
  }

  public async uploadGuestPromptLog(
    guestId: string,
    turns: any[],
  ): Promise<boolean> {
    if (!this.isAvailable() || !this.client) return false;

    const key = this.formatGuestPromptLogKey(guestId);
    const body = JSON.stringify(turns, null, 2);

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: "application/json",
        }),
      );
      return true;
    } catch (err) {
      console.error(`[S3 Storage] Failed to upload guest log to ${key}:`, err);
      return false;
    }
  }

  public async getGuestPromptLog(guestId: string): Promise<any[] | null> {
    if (!this.isAvailable() || !this.client) return null;

    const key = this.formatGuestPromptLogKey(guestId);
    try {
      const resp = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      if (!resp.Body) return null;
      const str = await resp.Body.transformToString("utf-8");
      const parsed = JSON.parse(str);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err: any) {
      if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) {
        return null;
      }
      console.error(`[S3 Storage] Failed to get guest log from ${key}:`, err);
      return null;
    }
  }

  public async uploadStudentFile(
    sessionCode: string,
    studentId: string,
    relativePath: string,
    content: string | Buffer | Uint8Array,
    contentType?: string,
  ): Promise<boolean> {
    if (!this.isAvailable() || !this.client) return false;

    const safeSession = sanitizeSegment(sessionCode).toUpperCase();
    const safeStudent = sanitizeSegment(studentId).toUpperCase();
    const cleanRelPath = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
    const key = `sessions/${safeSession}/students/${safeStudent}/${cleanRelPath}`;

    let inferredContentType = contentType;
    if (!inferredContentType) {
      if (cleanRelPath.endsWith(".json")) inferredContentType = "application/json";
      else if (cleanRelPath.endsWith(".jsonl")) inferredContentType = "application/x-ndjson";
      else if (cleanRelPath.endsWith(".txt") || cleanRelPath.endsWith(".log")) inferredContentType = "text/plain";
      else if (cleanRelPath.endsWith(".zip")) inferredContentType = "application/zip";
      else inferredContentType = "application/octet-stream";
    }

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: content,
          ContentType: inferredContentType,
        }),
      );
      return true;
    } catch (err) {
      console.error(`[S3 Storage] Failed to upload student file ${key}:`, err);
      return false;
    }
  }

  public async uploadExamRecordFile(
    sessionCode: string,
    studentId: string,
    recordId: string,
    fileName: string,
    content: string | Buffer | Uint8Array,
    contentType: string = "application/octet-stream",
  ): Promise<boolean> {
    if (!this.isAvailable() || !this.client) return false;

    const prefix = this.formatExamRecordPrefix(
      sessionCode,
      studentId,
      recordId,
    );
    const key = `${prefix}${fileName}`;

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: content,
          ContentType: contentType,
        }),
      );
      return true;
    } catch (err) {
      console.error(`[S3 Storage] Failed to upload record file ${key}:`, err);
      return false;
    }
  }

  public async purgeStudentExamRecords(
    sessionCode: string,
    studentId: string,
  ): Promise<boolean> {
    if (!this.isAvailable() || !this.client) return false;

    const prefix = this.formatExamRecordPrefix(sessionCode, studentId);
    try {
      let continuationToken: string | undefined = undefined;
      do {
        const resp = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );

        if (resp.Contents && resp.Contents.length > 0) {
          const deleteParams = {
            Bucket: this.bucket,
            Delete: {
              Objects: resp.Contents.map((obj) => ({ Key: obj.Key! })),
            },
          };
          await this.client.send(new DeleteObjectsCommand(deleteParams));
        }

        continuationToken = resp.NextContinuationToken;
      } while (continuationToken);

      return true;
    } catch (err) {
      console.error(
        `[S3 Storage] Failed to purge existing exam records for ${sessionCode}/${studentId}:`,
        err,
      );
      return false;
    }
  }

  public async listStudentExamRecords(
    sessionCode: string,
    studentId: string,
  ): Promise<string[]> {
    if (!this.isAvailable() || !this.client) return [];

    const prefix = this.formatExamRecordPrefix(sessionCode, studentId);
    try {
      const resp = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          Delimiter: "/",
        }),
      );

      const records: string[] = [];
      if (resp.CommonPrefixes) {
        for (const cp of resp.CommonPrefixes) {
          if (cp.Prefix) {
            const parts = cp.Prefix.replace(/\/$/, "").split("/");
            const recordName = parts[parts.length - 1];
            if (recordName) {
              records.push(recordName);
            }
          }
        }
      }
      return records.sort().reverse();
    } catch (err) {
      console.error(
        `[S3 Storage] Failed to list exam records for ${sessionCode}/${studentId}:`,
        err,
      );
      return [];
    }
  }

  public async getExamRecordArtifact(
    sessionCode: string,
    studentId: string,
    recordId: string,
    fileName: string,
  ): Promise<string | Buffer | null> {
    if (!this.isAvailable() || !this.client) return null;

    const prefix = this.formatExamRecordPrefix(
      sessionCode,
      studentId,
      recordId,
    );
    const key = `${prefix}${fileName}`;

    try {
      const resp = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      if (!resp.Body) return null;
      if (
        fileName.endsWith(".json") ||
        fileName.endsWith(".jsonl") ||
        fileName.endsWith(".txt")
      ) {
        return await resp.Body.transformToString("utf-8");
      }
      const bytes = await resp.Body.transformToByteArray();
      return Buffer.from(bytes);
    } catch (err: any) {
      if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) {
        return null;
      }
      console.error(`[S3 Storage] Failed to get artifact ${key}:`, err);
      return null;
    }
  }

  public async listSessionsFromS3(): Promise<string[]> {
    if (!this.isAvailable() || !this.client) return [];

    try {
      const resp = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: "sessions/",
          Delimiter: "/",
        }),
      );

      const sessionsList: string[] = [];
      if (resp.CommonPrefixes) {
        for (const cp of resp.CommonPrefixes) {
          if (cp.Prefix) {
            const parts = cp.Prefix.replace(/\/$/, "").split("/");
            const code = parts[parts.length - 1];
            if (code) {
              sessionsList.push(code);
            }
          }
        }
      }
      return sessionsList;
    } catch (err) {
      console.error("[S3 Storage] Failed to list sessions from S3:", err);
      return [];
    }
  }

  public async listStudentsInSessionFromS3(sessionCode: string): Promise<
    Array<{
      studentId: string;
      hasPromptLog: boolean;
      hasEventLog: boolean;
      lastActivity?: number;
    }>
  > {
    if (!this.isAvailable() || !this.client) return [];

    const safeSession = sanitizeSegment(sessionCode).toUpperCase();
    const studentsPrefix = `sessions/${safeSession}/students/`;

    try {
      const resp = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: studentsPrefix,
          Delimiter: "/",
        }),
      );

      const result: Array<{
        studentId: string;
        hasPromptLog: boolean;
        hasEventLog: boolean;
        lastActivity?: number;
      }> = [];

      if (resp.CommonPrefixes) {
        for (const cp of resp.CommonPrefixes) {
          if (!cp.Prefix) continue;
          const parts = cp.Prefix.replace(/\/$/, "").split("/");
          const studentId = parts[parts.length - 1];
          if (!studentId) continue;

          const promptLogKey = `${cp.Prefix}prompt_turns.json`;
          let hasPromptLog = false;
          let lastActivity: number | undefined;

          try {
            const head = await this.client.send(
              new HeadObjectCommand({
                Bucket: this.bucket,
                Key: promptLogKey,
              }),
            );
            hasPromptLog = true;
            if (head.LastModified) {
              lastActivity = head.LastModified.getTime();
            }
          } catch {}

          const examRecords = await this.listStudentExamRecords(
            safeSession,
            studentId,
          );
          const hasEventLog = examRecords.length > 0;

          result.push({
            studentId,
            hasPromptLog,
            hasEventLog,
            lastActivity: lastActivity || Date.now(),
          });
        }
      }
      return result;
    } catch (err) {
      console.error(
        `[S3 Storage] Failed to list students for session ${sessionCode}:`,
        err,
      );
      return [];
    }
  }

  public async listGuestsFromS3(): Promise<string[]> {
    if (!this.isAvailable() || !this.client) return [];

    try {
      const resp = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: "guests/",
          Delimiter: "/",
        }),
      );

      const guests: string[] = [];
      if (resp.CommonPrefixes) {
        for (const cp of resp.CommonPrefixes) {
          if (cp.Prefix) {
            const parts = cp.Prefix.replace(/\/$/, "").split("/");
            const gid = parts[parts.length - 1];
            if (gid) {
              guests.push(gid);
            }
          }
        }
      }
      return guests;
    } catch (err) {
      console.error("[S3 Storage] Failed to list guests from S3:", err);
      return [];
    }
  }
}

export const s3Storage = new S3StorageService();
