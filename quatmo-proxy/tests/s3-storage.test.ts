/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, test, describe } from "bun:test";
import { S3StorageService, s3Storage } from "../src/services/s3Storage";

describe("S3StorageService Key Formatting & Sanitization", () => {
  const service = new S3StorageService();

  test("formats student prompt log key properly", () => {
    const key = service.formatStudentPromptLogKey("prn211_fa24", "he150123");
    expect(key).toBe(
      "sessions/PRN211_FA24/students/HE150123/prompt_turns.json",
    );
  });

  test("sanitizes unsafe characters from sessionCode and studentId", () => {
    const key = service.formatStudentPromptLogKey(
      "SE101/../MALICIOUS",
      "HE-150..#23",
    );
    expect(key).toBe(
      "sessions/SE101MALICIOUS/students/HE-15023/prompt_turns.json",
    );
  });

  test("formats guest prompt log key properly", () => {
    const key = service.formatGuestPromptLogKey("machine_client_01");
    expect(key).toBe("guests/MACHINE_CLIENT_01/prompt_turns.json");
  });

  test("formats exam record prefixes correctly", () => {
    const rootPrefix = service.formatExamRecordPrefix("EXAM_01", "STUDENT_01");
    expect(rootPrefix).toBe(
      "sessions/EXAM_01/students/STUDENT_01/exam_records/",
    );

    const recordPrefix = service.formatExamRecordPrefix(
      "EXAM_01",
      "STUDENT_01",
      "REC_2026",
    );
    expect(recordPrefix).toBe(
      "sessions/EXAM_01/students/STUDENT_01/exam_records/REC_2026/",
    );
  });
});

describe("S3StorageService Fallback & Safe Operations", () => {
  test("gracefully handles unconfigured S3 without throwing", async () => {
    const unconfigured = new S3StorageService();

    // When keys are not set, isAvailable should return false or handle calls safely
    const isAvail = unconfigured.isAvailable();
    if (!isAvail) {
      const uploadSuccess = await unconfigured.uploadStudentPromptLog(
        "S1",
        "U1",
        [],
      );
      expect(uploadSuccess).toBe(false);

      const logs = await unconfigured.getStudentPromptLog("S1", "U1");
      expect(logs).toBeNull();

      const sessions = await unconfigured.listSessionsFromS3();
      expect(sessions).toEqual([]);

      const students = await unconfigured.listStudentsInSessionFromS3("S1");
      expect(students).toEqual([]);
    }
  });

  test("global s3Storage singleton is exported and operational", () => {
    expect(s3Storage).toBeDefined();
    expect(typeof s3Storage.getBucketName).toBe("function");
    expect(typeof s3Storage.uploadStudentFile).toBe("function");
    expect(s3Storage.getBucketName()).toBe("f-vscode-storage");
  });
});
