#!/usr/bin/env bun
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { s3Storage } from "../src/services/s3Storage";
import {
  ListObjectsV2Command,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import dotenv from "dotenv";

dotenv.config();

const args = process.argv.slice(2);
const command = args[0] || "list";

async function getDirectClient(): Promise<{ client: S3Client; bucket: string }> {
  const endpoint = process.env.S3_ENDPOINT || "https://s3-api.iahn.hanoi.vn";
  const region = process.env.S3_REGION || "us-east-1";
  const bucket = process.env.S3_BUCKET || "f-vscode-storage";
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();
  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE !== "false";

  if (!accessKeyId || !secretAccessKey) {
    console.error("\n❌ ERROR: S3 credentials are not set in .env!");
    console.error("Please open proxy/quatmo-proxy/.env and fill in:");
    console.error("  S3_ACCESS_KEY_ID=...");
    console.error("  S3_SECRET_ACCESS_KEY=...\n");
    process.exit(1);
  }

  const client = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle,
  });

  return { client, bucket };
}

async function testConnection() {
  console.log("\n📡 Testing S3 Connection...");
  const { client, bucket } = await getDirectClient();
  const testKey = `_diagnostic_test/${Date.now()}_probe.json`;
  const payload = JSON.stringify({ test: "OK", timestamp: Date.now() });

  try {
    const t0 = performance.now();
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: testKey,
        Body: payload,
        ContentType: "application/json",
      }),
    );
    const writeMs = (performance.now() - t0).toFixed(1);

    const t1 = performance.now();
    const getRes = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: testKey,
      }),
    );
    const readStr = await getRes.Body?.transformToString("utf-8");
    const readMs = (performance.now() - t1).toFixed(1);

    await client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: testKey,
      }),
    );

    if (readStr === payload) {
      console.log(`✅ S3 CONNECTION SUCCESSFUL!`);
      console.log(`   Bucket       : ${bucket}`);
      console.log(`   Endpoint     : ${process.env.S3_ENDPOINT}`);
      console.log(`   Write Latency: ${writeMs} ms`);
      console.log(`   Read Latency : ${readMs} ms\n`);
    } else {
      console.log(`⚠️ S3 Read verification mismatch.\n`);
    }
  } catch (err: any) {
    console.error(`\n❌ S3 Connection Failed: ${err?.message || err}\n`);
  }
}

async function listObjects(prefix: string = "") {
  console.log(`\n📂 Listing S3 Objects (Bucket: ${process.env.S3_BUCKET || "f-vscode-storage"}, Prefix: "${prefix}")...\n`);
  const { client, bucket } = await getDirectClient();

  try {
    let continuationToken: string | undefined = undefined;
    let totalCount = 0;
    let totalBytes = 0;

    do {
      const resp = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );

      const items = resp.Contents || [];
      for (const item of items) {
        totalCount++;
        totalBytes += item.Size || 0;
        const sizeKb = ((item.Size || 0) / 1024).toFixed(2);
        const lastMod = item.LastModified
          ? item.LastModified.toISOString().replace("T", " ").substring(0, 19)
          : "N/A";
        console.log(`  [${lastMod}]  ${sizeKb.padStart(8)} KB  📄 ${item.Key}`);
      }

      continuationToken = resp.NextContinuationToken;
    } while (continuationToken);

    if (totalCount === 0) {
      console.log("  (No objects found. The bucket or prefix is currently empty)\n");
    } else {
      const totalMb = (totalBytes / (1024 * 1024)).toFixed(2);
      console.log(`\n📊 Total: ${totalCount} objects (${totalMb} MB)\n`);
    }
  } catch (err: any) {
    console.error(`\n❌ Failed to list objects: ${err?.message || err}\n`);
  }
}

async function viewObject(key: string) {
  if (!key) {
    console.error("\n❌ Please specify an S3 object key to view (e.g. sessions/SE101/students/HE150123/prompt_turns.json)\n");
    process.exit(1);
  }

  const { client, bucket } = await getDirectClient();
  try {
    console.log(`\n🔍 Fetching s3://${bucket}/${key}...\n`);
    const resp = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );
    const content = await resp.Body?.transformToString("utf-8");
    try {
      const json = JSON.parse(content || "");
      console.log(JSON.stringify(json, null, 2));
    } catch {
      console.log(content);
    }
    console.log("\n");
  } catch (err: any) {
    console.error(`\n❌ Failed to fetch object ${key}: ${err?.message || err}\n`);
  }
}

import * as fs from "fs";
import * as path from "path";

async function syncLocalToS3(sessionCodeArg?: string, studentIdArg?: string) {
  const sessionsBase = path.resolve(process.cwd(), "logs", "sessions");
  if (!fs.existsSync(sessionsBase)) {
    console.log("No local logs/sessions folder found.");
    return;
  }

  const targetSessions = sessionCodeArg
    ? [sessionCodeArg.toUpperCase()]
    : fs.readdirSync(sessionsBase).filter((f) => fs.statSync(path.join(sessionsBase, f)).isDirectory());

  console.log(`\n🔄 Syncing local session logs to S3... (${targetSessions.length} sessions)\n`);

  let totalUploaded = 0;

  for (const sessionCode of targetSessions) {
    const sessionDir = path.join(sessionsBase, sessionCode);
    if (!fs.existsSync(sessionDir)) continue;

    const entries = fs.readdirSync(sessionDir);
    for (const entry of entries) {
      const studentDir = path.join(sessionDir, entry);
      if (fs.statSync(studentDir).isDirectory()) {
        const studentId = entry.toUpperCase();
        if (studentIdArg && studentId !== studentIdArg.toUpperCase()) continue;

        console.log(`  📦 Syncing student [${studentId}] in session [${sessionCode}]...`);

        // 1. Sync prompt log if exists
        const promptJson = path.join(sessionDir, `${entry}.json`);
        if (fs.existsSync(promptJson)) {
          try {
            const raw = fs.readFileSync(promptJson, "utf-8");
            const turns = JSON.parse(raw);
            const ok = await s3Storage.uploadStudentPromptLog(sessionCode, studentId, Array.isArray(turns) ? turns : []);
            if (ok) {
              console.log(`     ✓ prompt_turns.json`);
              totalUploaded++;
            }
          } catch (e: any) {
            console.error(`     ❌ prompt_turns.json error: ${e.message}`);
          }
        }

        // 2. Recursively upload student directory files (exam_records, upload_info.json, etc.)
        function walkDir(dir: string, baseDir: string): string[] {
          let results: string[] = [];
          const list = fs.readdirSync(dir);
          for (const file of list) {
            const filePath = path.join(dir, file);
            const stat = fs.statSync(filePath);
            if (stat.isDirectory()) {
              results = results.concat(walkDir(filePath, baseDir));
            } else {
              results.push(path.relative(baseDir, filePath).replace(/\\/g, "/"));
            }
          }
          return results;
        }

        const relativeFiles = walkDir(studentDir, studentDir);
        for (const relFile of relativeFiles) {
          const fullPath = path.join(studentDir, relFile);
          try {
            const content = fs.readFileSync(fullPath);
            const ok = await s3Storage.uploadStudentFile(sessionCode, studentId, relFile, content);
            if (ok) {
              console.log(`     ✓ ${relFile}`);
              totalUploaded++;
            }
          } catch (e: any) {
            console.error(`     ❌ ${relFile} error: ${e.message}`);
          }
        }
      }
    }
  }

  console.log(`\n✅ Sync complete! Uploaded/verified ${totalUploaded} files to S3.\n`);
}

async function main() {
  if (command === "test" || command === "check") {
    await testConnection();
  } else if (command === "view" || command === "cat") {
    await viewObject(args[1]);
  } else if (command === "list" || command === "ls") {
    await listObjects(args[1] || "");
  } else if (command === "sync") {
    await syncLocalToS3(args[1], args[2]);
  } else {
    console.log(`
QuatMo S3 CLI Diagnostic Tool
Usage:
  bun bin/s3-tool.ts test                          # Test S3 connection & credentials
  bun bin/s3-tool.ts list [prefix]                 # List objects (e.g. list sessions/)
  bun bin/s3-tool.ts view <key>                    # View contents of an S3 file
  bun bin/s3-tool.ts sync [sessionCode] [studentId]# Sync local logs to S3
`);
  }
}

main();
