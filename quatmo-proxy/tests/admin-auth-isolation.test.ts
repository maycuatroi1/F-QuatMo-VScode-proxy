import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { adminRouter } from "../src/routes/admin";
import { lecturerAccounts, sessions, type Session } from "../src/services/sessionStore";

/** Lecturer JWTs are only honoured for existing, active lecturer accounts. */
function registerLecturer(username: string): void {
  const now = Date.now();
  lecturerAccounts.set(username, {
    username,
    name: username,
    passwordHash: "",
    status: "active",
    createdAt: now,
    createdBy: "admin",
    updatedAt: now,
    updatedBy: "admin",
  });
}
import { getProxyApiKey } from "../src/services/proxyKey";
import { getJwtSecret } from "../src/services/jwtKey";

const app = new Hono();
app.route("/admin", adminRouter);

describe("Admin Auth Middleware & Strict Lecturer Isolation", () => {
  const masterKey = getProxyApiKey();
  const jwtSecret = getJwtSecret();

  it("should REJECT with 401 when Bearer token is invalid or expired, even if correct x-api-key is sent", async () => {
    // Malformed token + correct x-api-key
    const resBadToken = await app.request("/admin/sessions", {
      method: "GET",
      headers: {
        Authorization: "Bearer invalid.expired.token",
        "x-api-key": masterKey,
      },
    });
    expect(resBadToken.status).toBe(401);
    const bodyBad = await resBadToken.json();
    expect(bodyBad.error).toContain("Session expired or invalid token");

    // Expired token + correct x-api-key
    const expiredToken = await sign(
      { username: "gv_teacher", role: "lecturer", exp: Math.floor(Date.now() / 1000) - 3600 },
      jwtSecret,
      "HS256" as any,
    );
    const resExpired = await app.request("/admin/sessions", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${expiredToken}`,
        "x-api-key": masterKey,
      },
    });
    expect(resExpired.status).toBe(401);
    const bodyExpired = await resExpired.json();
    expect(bodyExpired.error).toContain("Session expired or invalid token");
  });

  it("should allow pure x-api-key access only when NO Bearer header is present", async () => {
    const resPureKey = await app.request("/admin/sessions", {
      method: "GET",
      headers: {
        "x-api-key": masterKey,
      },
    });
    expect(resPureKey.status).toBe(200);
  });

  it("should strictly isolate sessions between lecturers while allowing Super Admin to see all", async () => {
    registerLecturer("gv_isolation_a");
    registerLecturer("gv_isolation_b");
    const tokenLecA = await sign(
      { username: "gv_isolation_a", role: "lecturer", exp: Math.floor(Date.now() / 1000) + 3600 },
      jwtSecret,
      "HS256" as any,
    );
    const tokenLecB = await sign(
      { username: "gv_isolation_b", role: "lecturer", exp: Math.floor(Date.now() / 1000) + 3600 },
      jwtSecret,
      "HS256" as any,
    );
    const tokenAdmin = await sign(
      { username: "admin", role: "admin", exp: Math.floor(Date.now() / 1000) + 3600 },
      jwtSecret,
      "HS256" as any,
    );

    // 1. Lecturer A creates a session
    const resCreateA = await app.request("/admin/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenLecA}`,
        "x-api-key": masterKey,
      },
      body: JSON.stringify({
        durationMinutes: 90,
        aiOption: "chatbot",
        aiValidityMinutes: 90,
        defaultTokenBudget: 50000,
        sessionPrompt: "Lecturer A session",
      }),
    });
    expect(resCreateA.status).toBe(200);
    const codeA = (await resCreateA.json()).sessionCode;

    // 2. Lecturer B creates a session
    const resCreateB = await app.request("/admin/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenLecB}`,
        "x-api-key": masterKey,
      },
      body: JSON.stringify({
        durationMinutes: 90,
        aiOption: "chatbot",
        aiValidityMinutes: 90,
        defaultTokenBudget: 50000,
        sessionPrompt: "Lecturer B session",
      }),
    });
    expect(resCreateB.status).toBe(200);
    const codeB = (await resCreateB.json()).sessionCode;

    // 3. Lecturer A queries /admin/sessions -> must only see Session A
    const resListA = await app.request("/admin/sessions", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${tokenLecA}`,
        "x-api-key": masterKey,
      },
    });
    expect(resListA.status).toBe(200);
    const sessionsA = (await resListA.json()).sessions;
    const codesA = sessionsA.map((s: any) => s.sessionCode);
    expect(codesA).toContain(codeA);
    expect(codesA).not.toContain(codeB);

    // 4. Lecturer B queries /admin/sessions -> must only see Session B
    const resListB = await app.request("/admin/sessions", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${tokenLecB}`,
        "x-api-key": masterKey,
      },
    });
    expect(resListB.status).toBe(200);
    const sessionsB = (await resListB.json()).sessions;
    const codesB = sessionsB.map((s: any) => s.sessionCode);
    expect(codesB).toContain(codeB);
    expect(codesB).not.toContain(codeA);

    // 5. Super Admin queries /admin/sessions -> sees BOTH Session A and Session B
    const resListAdmin = await app.request("/admin/sessions", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${tokenAdmin}`,
        "x-api-key": masterKey,
      },
    });
    expect(resListAdmin.status).toBe(200);
    const sessionsAdmin = (await resListAdmin.json()).sessions;
    const codesAdmin = sessionsAdmin.map((s: any) => s.sessionCode);
    expect(codesAdmin).toContain(codeA);
    expect(codesAdmin).toContain(codeB);

    // 6. Super Admin reassigns Session A to Lecturer B
    const resReassign = await app.request(`/admin/sessions/${codeA}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenAdmin}`,
        "x-api-key": masterKey,
      },
      body: JSON.stringify({
        createdBy: "gv_isolation_b",
      }),
    });
    expect(resReassign.status).toBe(200);

    // 7. Lecturer B now sees BOTH Session A and Session B
    const resListBAfter = await app.request("/admin/sessions", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${tokenLecB}`,
        "x-api-key": masterKey,
      },
    });
    const sessionsBAfter = (await resListBAfter.json()).sessions;
    const codesBAfter = sessionsBAfter.map((s: any) => s.sessionCode);
    expect(codesBAfter).toContain(codeA);
    expect(codesBAfter).toContain(codeB);
    lecturerAccounts.delete("gv_isolation_a");
    lecturerAccounts.delete("gv_isolation_b");
  });

  it("should REJECT a lecturer JWT whose account is inactive or unknown", async () => {
    const tokenFor = (username: string) =>
      sign({ username, role: "lecturer", exp: Math.floor(Date.now() / 1000) + 3600 }, jwtSecret, "HS256" as any);

    const unknown = await app.request("/admin/sessions", {
      headers: { Authorization: `Bearer ${await tokenFor("gv_does_not_exist")}` },
    });
    expect(unknown.status).toBe(401);

    registerLecturer("gv_inactive");
    lecturerAccounts.set("gv_inactive", { ...lecturerAccounts.get("gv_inactive")!, status: "inactive" });
    const inactive = await app.request("/admin/sessions", {
      headers: { Authorization: `Bearer ${await tokenFor("gv_inactive")}` },
    });
    expect(inactive.status).toBe(401);
    lecturerAccounts.delete("gv_inactive");
  });

  it("should never treat '/login' in the query string or path as public", async () => {
    for (const url of ["/admin/lecturers?x=/login", "/admin/lecturers/login", "/admin/sessions?/login"]) {
      const res = await app.request(url);
      expect(res.status).toBe(401);
    }
  });

  it("should REJECT student/session JWTs signed with the same secret", async () => {
    const sessionToken = await sign(
      { studentId: "HE000001", sessionCode: "ABC123", role: "admin", username: "admin", exp: Math.floor(Date.now() / 1000) + 3600 },
      jwtSecret,
      "HS256" as any,
    );
    const res = await app.request("/admin/lecturers", {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    expect(res.status).toBe(401);
  });
});
