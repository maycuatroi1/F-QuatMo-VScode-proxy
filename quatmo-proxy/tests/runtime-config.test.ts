import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { sessions, sessionStates, type Session } from "../src/services/sessionStore";
import { sessionAuthRouter } from "../src/routes/sessionAuth";
import { adminRouter } from "../src/routes/admin";
import { sign } from "hono/jwt";
import { getJwtSecret } from "../src/services/jwtKey";

const app = new Hono();
app.route("/admin", adminRouter);
app.route("/session", sessionAuthRouter);

describe("Session Runtime Configuration Lifecycle", () => {
  const jwtSecret = getJwtSecret();
  const testSessionCode = "SS-RUNTIME-TEST";

  it("should persist and hydrate session with runtimeConfig", async () => {
    const session: Session = {
      sessionCode: testSessionCode,
      startTime: Math.floor(Date.now() / 1000),
      durationMinutes: 120,
      aiOption: "agent",
      aiValidityMinutes: 120,
      defaultTokenBudget: 50000,
      allowedStudentIds: new Set(["SE_TEST_RUNTIME"]),
      sessionType: "exam",
      sessionPrompt: "Test exam prompt",
      runtimeConfig: {
        enabled: true,
        runtimeType: "python",
        runtimeVersion: "3.10.11",
        packages: ["numpy==1.26.4", "pandas==2.2.1"],
        lanMirrorUrl: "http://10.0.0.1:8080/runtimes/",
      },
      createdAt: Date.now(),
      createdBy: "admin",
    };

    sessions.set(testSessionCode, session);

    const retrieved = sessions.get(testSessionCode);
    expect(retrieved).toBeDefined();
    expect(retrieved?.runtimeConfig?.enabled).toBe(true);
    expect(retrieved?.runtimeConfig?.runtimeType).toBe("python");
    expect(retrieved?.runtimeConfig?.runtimeVersion).toBe("3.10.11");
    expect(retrieved?.runtimeConfig?.packages).toEqual(["numpy==1.26.4", "pandas==2.2.1"]);
    expect(retrieved?.runtimeConfig?.lanMirrorUrl).toBe("http://10.0.0.1:8080/runtimes/");
  });

  it("should return runtimeConfig on student status query", async () => {
    const token = await sign(
      {
        sessionCode: testSessionCode,
        studentId: "SE_TEST_RUNTIME",
        loginTime: Math.floor(Date.now() / 1000),
      },
      jwtSecret,
    );

    sessionStates.set(`${testSessionCode}:SE_TEST_RUNTIME`, {
      sessionCode: testSessionCode,
      studentId: "SE_TEST_RUNTIME",
      hasLoggedIn: true,
      loginTimestamp: Math.floor(Date.now() / 1000),
      tokensConsumed: 0,
      reassigned: false,
    });

    const res = await app.request("/session/status", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.runtimeConfig).toBeDefined();
    expect(body.runtimeConfig.enabled).toBe(true);
    expect(body.runtimeConfig.runtimeType).toBe("python");
    expect(body.runtimeConfig.runtimeVersion).toBe("3.10.11");
    expect(body.runtimeConfig.packages).toContain("numpy==1.26.4");
  });
});
