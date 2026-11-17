import path from "path";
import fs from "fs";
import { s3Storage } from "../../services/s3Storage";
import { sanitizeFilename } from "../telemetry/logFiles";
import { prefersGuestLogSource, type GuestLogSource } from "./guestLogSource";

export async function listVisualizeGuests(c: any) {
  const guestDirs = [
    path.resolve(process.cwd(), "logs", "guests"),
    path.resolve(process.cwd(), "logs", "machines"),
  ];

  const guestMap = new Map<
    string,
    {
      guestId: string;
      turnsCount: number;
      lastActivity: number;
      hasErrors: boolean;
      filePath: string;
    }
  >();

  for (const gDir of guestDirs) {
    if (!fs.existsSync(gDir)) continue;
    try {
      const entries = await fs.promises.readdir(gDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const entryPath = path.join(gDir, entry.name);
        const stat = await fs.promises.stat(entryPath);
        const isJson = entry.name.endsWith(".json");
        const isLog = entry.name.endsWith(".log");
        if (!isJson && !isLog) continue;

        const guestId = entry.name.replace(/\.(json|log)$/, "");
        let turnsCount = 0;
        let hasErrors = false;

        try {
          const raw = await fs.promises.readFile(entryPath, "utf-8");
          if (isJson) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              turnsCount = parsed.length;
              hasErrors = parsed.some((t: any) => !!t.error);
            }
          } else {
            const lines = raw.split("\n").filter((l) => l.trim().length > 0);
            turnsCount = lines.length;
          }
        } catch {}

        const existing = guestMap.get(guestId);
        if (prefersGuestLogSource({ filePath: entryPath, lastActivity: stat.mtimeMs }, existing)) {
          guestMap.set(guestId, {
            guestId,
            turnsCount,
            lastActivity: stat.mtimeMs,
            hasErrors,
            filePath: entryPath,
          });
        }
      }
    } catch {}
  }

  if (s3Storage.isAvailable()) {
    try {
      const s3Guests = await s3Storage.listGuestsFromS3();
      for (const gid of s3Guests) {
        if (!guestMap.has(gid)) {
          guestMap.set(gid, {
            guestId: gid,
            turnsCount: 1,
            lastActivity: Date.now(),
            hasErrors: false,
            filePath: "",
          });
        }
      }
    } catch {}
  }

  const guests = Array.from(guestMap.values()).map((g) => ({
    studentId: g.guestId,
    guestId: g.guestId,
    hasPromptLog: true,
    hasEventLog: false,
    promptTurnsCount: g.turnsCount,
    eventCount: 0,
    lastActivity: g.lastActivity,
    hasErrors: g.hasErrors,
  }));

  guests.sort((a, b) => b.lastActivity - a.lastActivity);

  return c.json({ guests });
}

export async function getVisualizeGuestPromptLog(c: any) {
  const guestId = sanitizeFilename(c.req.param("guestId"));
  const guestDirs = [
    path.resolve(process.cwd(), "logs", "guests"),
    path.resolve(process.cwd(), "logs", "machines"),
  ];

  let source: GuestLogSource | undefined;
  for (const gDir of guestDirs) {
    for (const extension of ["json", "log"]) {
      const filePath = path.join(gDir, `${guestId}.${extension}`);
      if (!fs.existsSync(filePath)) continue;
      try {
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) continue;
        const candidate = { filePath, lastActivity: stat.mtimeMs };
        if (prefersGuestLogSource(candidate, source)) source = candidate;
      } catch {
        return c.json({ error: extension === "json" ? "Failed to parse log" : "Failed to read log" }, 500);
      }
    }
  }

  if (source) {
    const isJson = source.filePath.endsWith(".json");
    try {
      const raw = await fs.promises.readFile(source.filePath, "utf-8");
      if (isJson) {
        const turns = JSON.parse(raw);
        return c.json({
          guestId,
          turns: Array.isArray(turns) ? turns : [],
        });
      }
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      const turns: any[] = [];
      for (const line of lines) {
        try {
          turns.push(JSON.parse(line));
        } catch {}
      }
      return c.json({ guestId, turns });
    } catch {
      return c.json({ error: isJson ? "Failed to parse log" : "Failed to read log" }, 500);
    }
  }

  // Check S3 if not found locally
  if (s3Storage.isAvailable()) {
    try {
      const s3Turns = await s3Storage.getGuestPromptLog(guestId);
      if (s3Turns && s3Turns.length > 0) {
        return c.json({ guestId, turns: s3Turns });
      }
    } catch {}
  }

  return c.json({ guestId, turns: [] });
}
