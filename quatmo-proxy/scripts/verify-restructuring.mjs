import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import ts from "typescript";

const baseline = "42917845fe89656af343e26c1b93898063b7ec6e";
const normalize = (text) => text.replace(/\r\n/g, "\n");
const parse = (text) => ts.createSourceFile("source.ts", normalize(text), ts.ScriptTarget.Latest, true);
const old = parse(execFileSync("git", ["show", `${baseline}:quatmo-proxy/src/routes/admin.ts`], { encoding: "utf8" }));
const current = parse(fs.readFileSync("src/routes/admin.ts", "utf8"));
const authMiddleware = parse(fs.readFileSync("src/middleware/adminAuth.ts", "utf8"));
function loginPaths(file) {
  for (const node of file.statements) {
    if (!ts.isVariableStatement(node)) continue;
    const declaration = node.declarationList.declarations.find((item) => item.name.getText(file) === "ADMIN_LOGIN_PATHS");
    if (declaration) return declaration.initializer.getText(file);
  }
  assert.fail("Missing exact public login paths");
}
assert.equal(loginPaths(authMiddleware), loginPaths(old), "Public admin login paths changed");
const moved = new Map();
for (const path of [
  "src/modules/security/adminHandlers.ts",
  "src/modules/auth/adminHandlers.ts",
  "src/modules/auth/userHandlers.ts",
  "src/middleware/adminAuth.ts",
  "src/modules/lecturers/adminHandlers.ts",
  "src/modules/groups/adminHandlers.ts",
  "src/modules/users/adminHandlers.ts",
  "src/modules/sessions/adminHandlers.ts",
  "src/modules/sessions/streamHandler.ts",
  "src/modules/sessions/statusHandler.ts",
  "src/modules/sessions/loginHandler.ts",
  "src/modules/sessions/uploadHandler.ts",
  "src/modules/telemetry/jsonl.ts",
  "src/modules/telemetry/adminHandlers.ts",
  "src/modules/telemetry/logFiles.ts",
  "src/modules/telemetry/downloadHandlers.ts",
  "src/modules/visualization/sessionListHandler.ts",
  "src/modules/visualization/guestHandlers.ts",
  "src/modules/visualization/guestLogSource.ts",
  "src/modules/visualization/time.ts",
  "src/modules/visualization/sessionAccountsHandler.ts",
  "src/modules/visualization/promptHandlers.ts",
  "src/modules/visualization/recordHandlers.ts",
  "src/modules/visualization/eventHandlers.ts",
  "src/modules/visualization/s3EventLog.ts",
  "src/modules/storage/adminHandlers.ts",
  "src/modules/chat/toolCalls.ts",
  "src/modules/chat/upstream.ts",
  "src/modules/chat/prompts.ts",
  "src/modules/chat/interactionLog.ts",
  "src/modules/chat/terminalContext.ts",
  "src/modules/chat/inlineGuard.ts",
  "src/modules/chat/classificationState.ts",
  "src/modules/chat/contextHandlers.ts",
  "src/modules/chat/completionsHandler.ts",
  "src/modules/releases/store.ts",
  "src/modules/releases/httpHelpers.ts",
  "src/modules/releases/publicHandlers.ts",
  "src/modules/releases/artifactHandler.ts",
  "src/modules/releases/adminHandlers.ts",
  "src/shared/http/adminCaller.ts",
  "src/shared/http/clientIP.ts",
]) {
  const file = parse(fs.readFileSync(path, "utf8"));
  for (const node of file.statements) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) moved.set(node.name.text, node.body.getText(file));
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (declaration.initializer && ts.isArrowFunction(declaration.initializer)) moved.set(declaration.name.getText(file), declaration.initializer.body.getText(file));
      }
    }
  }
}

function registrations(file, resolveMoved, routerName = "adminRouter") {
  const rows = [];
  const localArrows = new Map();
  for (const node of file.statements) {
    if (!ts.isVariableStatement(node)) continue;
    for (const declaration of node.declarationList.declarations) {
      if (declaration.initializer && ts.isArrowFunction(declaration.initializer)) localArrows.set(declaration.name.getText(file), declaration.initializer.body.getText(file));
    }
  }
  for (const node of file.statements) {
    if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) continue;
    const call = node.expression;
    if (!ts.isPropertyAccessExpression(call.expression) || call.expression.expression.getText(file) !== routerName) continue;
    rows.push([
      call.expression.name.text,
      ...call.arguments.map((arg) => {
        if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) return arg.body.getText(file);
        if (resolveMoved && ts.isIdentifier(arg) && moved.has(arg.text)) return moved.get(arg.text);
        if (ts.isIdentifier(arg) && localArrows.has(arg.text)) return localArrows.get(arg.text);
        return arg.getText(file);
      }),
    ]);
  }
  return rows;
}
const expectedRegistrations = registrations(old, false);
// Approved behavior fix: constrain hard-delete cleanup to the selected account's creator.
// Keep exact comparison for every other byte of the handler bodies.
for (const [method, route, account] of [
  ["delete", '"/students/:studentId"', "targetAccount"],
  ["post", '"/students/bulk-delete"', "acc"],
]) {
  const row = expectedRegistrations.find((item) => item[0] === method && item[1] === route);
  assert.ok(row, `Missing baseline route ${route}`);
  const matches = row[2].match(/^[ \t]*group\.userIds &&/gm);
  assert.equal(matches?.length, 1, `Unexpected cleanup structure for ${route}`);
  row[2] = row[2].replace(/(^[ \t]*)group\.userIds &&/m, (_, indent) =>
    `${indent}(group.createdBy || "admin").toLowerCase() === (${account}.createdBy || "admin").toLowerCase() &&\n${indent}group.userIds &&`);
  if (account === "targetAccount") {
    row[2] = row[2].replace("// Also remove from any studentGroups if present", "// Membership belongs to the deleted account's creator, even for super-admin callers.");
  }
}
function replaceRequired(text, before, after) {
  assert.ok(text.includes(before), `Missing approved baseline fragment: ${before}`);
  return text.replace(before, after);
}
for (const [method, route] of [["patch", '"/sessions/:sessionCode"'], ["delete", '"/sessions/:sessionCode"']]) {
  const row = expectedRegistrations.find((item) => item[0] === method && item[1] === route);
  row[2] = replaceRequired(row[2], "state.sessionCode === sessionCode && state.hasLoggedIn", "state.sessionCode === sessionCode && hasSessionParticipation(state)");
  if (method === "patch") row[2] = replaceRequired(row[2], "!state?.hasLoggedIn", "!hasSessionParticipation(state)");
}
const removal = expectedRegistrations.find((item) => item[0] === "delete" && item[1] === '"/sessions/:sessionCode/students/:studentId"');
removal[2] = replaceRequired(removal[2], "if (state?.hasLoggedIn)", "if (hasSessionParticipation(state))");
const reassignment = expectedRegistrations.find((item) => item[0] === "post" && item[1] === '"/sessions/:sessionCode/students/:studentId/reassign"');
reassignment[2] = replaceRequired(reassignment[2], "    state.hasLoggedIn = false;", "    state.hasLoggedIn = false;\n    sessionStates.set(stateKey, state);");
// The extracted handler is one directory deeper; only this import path changes.
const tokenSync = expectedRegistrations.find((item) => item[0] === "post" && item[1] === '"/sessions/:sessionCode/sync-tokens"');
tokenSync[2] = replaceRequired(tokenSync[2], 'import("../services/promptLogService")', 'import("../../services/promptLogService")');
// Technical fix: preserve the explicitly declared JSON Content-Type on downloads.
for (const route of ['"/sessions/:sessionCode/accounts/:studentId/download"', '"/guests/:guestId/download"']) {
  const row = expectedRegistrations.find((item) => item[0] === "get" && item[1] === route);
  row[2] = replaceRequired(row[2], "return c.text(content);", "return c.body(content);");
}
// User-approved newest-guest-source fix: pin the reviewed, regression-tested bodies.
for (const [route, name, hash] of [
  ['"/visualize/guests"', "listVisualizeGuests", "dddfb137619bb05657db6487abc96301a285a8fb6e51e13fb7124519bd8a64ed"],
  ['"/visualize/guests/:guestId/prompt-log"', "getVisualizeGuestPromptLog", "22b75aa4005df4925ccb299d1d0ff037e25e375cc5ced4de28249cb3114c80e0"],
]) {
  const body = moved.get(name);
  assert.equal(createHash("sha256").update(body).digest("hex"), hash, `${name} differs from the approved guest-source fix`);
  expectedRegistrations.find((row) => row[0] === "get" && row[1] === route)[2] = body;
}
assert.deepEqual(registrations(current, true), expectedRegistrations, "Admin registrations/handlers differ beyond the recorded technical and user-approved policy changes");
for (const name of ["appendJsonLines", "hasNonEmptyLine", "countNonEmptyLines", "requireCaller", "syncGroupWithActiveSessions", "sanitizeFilename", "isSensitiveLogFile", "sendDirectoryZip", "getClientIP", "toMs", "sliceRecordsByTimeRange", "loadEventLogFromS3"]) {
  const original = old.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  let expectedBody = original.body.getText(old);
  if (name === "syncGroupWithActiveSessions") {
    expectedBody = replaceRequired(expectedBody, "    for (const uid of upperRemovedIds) {", "    for (const uid of upperRemovedIds) {\n      // Group membership can change, but participation evidence must survive.\n      if (hasSessionParticipation(sessionStates.get(`${session.sessionCode}:${uid}`))) continue;");
  }
  assert.equal(moved.get(name), expectedBody, `${name} body changed beyond approved fixes`);
}
const originalUserAuth = parse(execFileSync("git", ["show", `${baseline}:quatmo-proxy/src/routes/auth.ts`], { encoding: "utf8" }));
const currentUserAuth = parse(fs.readFileSync("src/routes/auth.ts", "utf8"));
assert.deepEqual(registrations(currentUserAuth, true, "authRouter"), registrations(originalUserAuth, false, "authRouter"), "User-auth registrations or handler bodies changed");
const originalSessionAuth = parse(execFileSync("git", ["show", `${baseline}:quatmo-proxy/src/routes/sessionAuth.ts`], { encoding: "utf8" }));
const currentSessionAuth = parse(fs.readFileSync("src/routes/sessionAuth.ts", "utf8"));
const expectedSessionAuth = registrations(originalSessionAuth, false, "sessionAuthRouter");
const sessionLogin = expectedSessionAuth.find((row) => row[0] === "post" && row[1] === '"/login"');
sessionLogin[sessionLogin.length - 1] = replaceRequired(sessionLogin[sessionLogin.length - 1], "  state.reassigned = false;", "  state.reassigned = false;\n  sessionStates.set(stateKey, state);");
assert.deepEqual(registrations(currentSessionAuth, true, "sessionAuthRouter"), expectedSessionAuth, "Session-auth registrations or bodies changed beyond the retained login-persistence fix");
for (const [path, names] of [
  ["src/modules/sessions/uploadArtifacts.ts", ["sanitizeFilename", "toMs", "sanitizeJsonlBuffer", "mergeJsonlBuffers", "mergeMetadataBuffers"]],
  ["src/modules/sessions/uploadToken.ts", ["verifyTokenSignatureOnly"]],
]) {
  const file = parse(fs.readFileSync(path, "utf8"));
  for (const name of names) {
    const before = originalSessionAuth.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
    const after = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.equal(after.body.getText(file), before.body.getText(originalSessionAuth), `${name} upload helper changed`);
  }
}
const uploadLimits = parse(fs.readFileSync("src/config/uploadLimits.ts", "utf8"));
for (const name of ["MAX_UPLOAD_FILES", "MAX_UPLOAD_BYTES"]) {
  const initializer = (file) => file.statements.filter(ts.isVariableStatement).flatMap((node) => node.declarationList.declarations).find((node) => node.name.getText(file) === name).initializer.getText(file);
  assert.equal(initializer(uploadLimits), initializer(originalSessionAuth), `${name} configuration changed`);
}
const originalChat = parse(execFileSync("git", ["show", `${baseline}:quatmo-proxy/src/routes/chat.ts`], { encoding: "utf8" }));
const currentChat = parse(fs.readFileSync("src/routes/chat.ts", "utf8"));
const expectedChat = registrations(originalChat, false, "chatRouter");
const completion = expectedChat.find((row) => row[0] === "post" && row[1] === '"/completions"');
assert.equal(completion[completion.length - 1].split('import("../services/sessionStore")').length - 1, 2, "Unexpected chat store imports");
completion[completion.length - 1] = completion[completion.length - 1].replaceAll('import("../services/sessionStore")', 'import("../../services/sessionStore")');
assert.deepEqual(registrations(currentChat, true, "chatRouter"), expectedChat, "Chat middleware/order/handlers changed beyond relocated imports");
for (const name of ["parseXmlToolCall", "extractToolCalls", "getUpstreamConfig", "normalizeUpstreamBody", "getSystemPromptForIem", "logStudentInteraction", "logStudentError", "resolveTerminalActivity", "isInlineCompletionRequest"]) {
  const before = originalChat.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  let expected = before.body.getText(originalChat);
  if (name === "logStudentInteraction") expected = replaceRequired(expected, 'import("../services/secureLogger")', 'import("../../services/secureLogger")');
  assert.equal(moved.get(name), expected, `${name} chat helper changed`);
}
const declaration = (file, name) => file.statements.filter(ts.isVariableStatement).flatMap((node) => node.declarationList.declarations).find((node) => node.name.getText(file) === name);
for (const [name, path] of [["cachedPrompts", "src/modules/chat/prompts.ts"], ["CLIENT_COMMAND_PRECEDENCE_DIRECTIVE", "src/modules/chat/prompts.ts"], ["latestClassifications", "src/modules/chat/classificationState.ts"]]) {
  const file = parse(fs.readFileSync(path, "utf8"));
  assert.equal(declaration(file, name).initializer.getText(file), declaration(originalChat, name).initializer.getText(originalChat), `${name} changed`);
}
const tools = parse(fs.readFileSync("src/modules/chat/toolCalls.ts", "utf8"));
for (const name of ["ParsedToolCall", "XmlToolCallConverter"]) {
  const original = originalChat.statements.find((node) => node.name?.text === name);
  const extracted = tools.statements.find((node) => node.name?.text === name);
  assert.equal(extracted.getText(tools), original.getText(originalChat), `${name} changed`);
}
const originalUpdate = parse(execFileSync("git", ["show", `${baseline}:quatmo-proxy/src/routes/update.ts`], { encoding: "utf8" }));
const currentUpdate = parse(fs.readFileSync("src/routes/update.ts", "utf8"));
assert.deepEqual(registrations(currentUpdate, true, "updateRouter"), registrations(originalUpdate, false, "updateRouter"), "Update routes or handlers changed");
for (const name of ["isSuperAdminRequest", "publicBase", "sanitizeManifestUrls", "getCurrentRelease", "saveReleaseManifest", "getLatestRelease"]) {
  const before = originalUpdate.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(moved.get(name), before.body.getText(originalUpdate), `${name} release helper changed`);
}
const releaseStore = parse(fs.readFileSync("src/modules/releases/store.ts", "utf8"));
const releaseTypes = parse(fs.readFileSync("src/modules/releases/types.ts", "utf8"));
for (const name of ["UpdateType", "ReleaseManifest"]) assert.equal(releaseTypes.statements.find((n) => n.name?.text === name).getText(releaseTypes), originalUpdate.statements.find((n) => n.name?.text === name).getText(originalUpdate), `${name} schema changed`);
for (const [name, path] of [["MANIFEST_PATH", "src/config/releasePaths.ts"], ["RELEASES_DIR", "src/config/releasePaths.ts"], ["currentRelease", "src/modules/releases/store.ts"], ["lastS3CheckTime", "src/modules/releases/store.ts"], ["S3_CHECK_INTERVAL_MS", "src/modules/releases/store.ts"], ["lastForcedSync", "src/modules/releases/adminHandlers.ts"]]) {
  const file = parse(fs.readFileSync(path, "utf8"));
  assert.equal(declaration(file, name).initializer.getText(file), declaration(originalUpdate, name).initializer.getText(originalUpdate), `${name} release initialization changed`);
}
const releaseSideEffects = (file) => file.statements.filter((n) => ts.isIfStatement(n) || ts.isTryStatement(n) || (ts.isExpressionStatement(n) && ts.isCallExpression(n.expression) && n.expression.expression.getText(file) === "observeRelease")).map((n) => n.getText(file));
assert.deepEqual(releaseSideEffects(releaseStore), releaseSideEffects(originalUpdate), "Release startup effects changed");
function publicExports(file) {
  const names = [];
  for (const node of file.statements) {
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) names.push(...node.exportClause.elements.map((item) => item.name.text));
    if (!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isVariableStatement(node)) names.push(...node.declarationList.declarations.map((item) => item.name.getText(file)));
    else if (node.name) names.push(node.name.text);
  }
  return names.sort();
}
for (const [name, before, after] of [["admin", old, current], ["user auth", originalUserAuth, currentUserAuth], ["session auth", originalSessionAuth, currentSessionAuth], ["chat", originalChat, currentChat], ["update", originalUpdate, currentUpdate]]) {
  assert.deepEqual(publicExports(after), publicExports(before), `${name} public exports changed`);
}
console.log(`PASS: all admin/user/session/chat/update registrations and moved bodies match baseline plus recorded fixes/import paths; state, schemas, startup effects and configuration initializers preserved.`);
