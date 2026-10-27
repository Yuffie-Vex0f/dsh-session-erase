#!/usr/bin/env node
/**
 * Independent verifier: confirm one Session id no longer exists anywhere the
 * Harness deployment keeps per-Session data.
 *
 *   node tools/verify-session-gone.mjs <sessionId> [--home <dshHome>] [--json]
 *
 * Exit code 0 = absent everywhere; 1 = still present somewhere (details on
 * stdout); 2 = usage error. Reads only — it never deletes anything.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { encodeSegment, spillSessionDirName, validateSessionId } from "../lib/paths.js";

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const homeIndex = args.indexOf("--home");
const explicitHome = homeIndex === -1 ? undefined : args[homeIndex + 1];
const positionals = args.filter((arg, index) => {
  if (arg.startsWith("--")) return false;
  return homeIndex === -1 || index !== homeIndex + 1;
});
const sessionId = positionals[0];

if (sessionId === undefined) {
  console.error("usage: node tools/verify-session-gone.mjs <sessionId> [--home <dshHome>] [--json]");
  process.exit(2);
}
try {
  validateSessionId(sessionId);
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(2);
}

const home = explicitHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
const sessionsRoot = join(home, "sessions");
const storagesRoot = join(home, "storages");
const encoded = encodeSegment(sessionId);

/** @param {string} path @returns {Promise<boolean>} */
const exists = (path) => stat(path).then(() => true, () => false);

async function findSessionDirs() {
  const found = [];
  let entries;
  try {
    entries = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(sessionsRoot, entry.name, encoded);
    if (await exists(candidate)) found.push(candidate);
  }
  return found;
}

async function findProjectionCache() {
  const path = join(storagesRoot, "session_projcache", "sessions", encoded + ".json");
  return (await exists(path)) ? path : undefined;
}

async function findWorkspaceReferences() {
  const path = join(storagesRoot, "workspace.json");
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { path, archived: false, pinned: false, workspaceIds: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { path, error: "workspace.json is not valid JSON", archived: false, pinned: false, workspaceIds: [] };
  }
  const global = parsed?.global ?? {};
  const archived = Array.isArray(global.archivedSessionIds) && global.archivedSessionIds.includes(sessionId);
  const pinned = Array.isArray(global.pinnedSessionIds) && global.pinnedSessionIds.includes(sessionId);
  const workspaceIds = [];
  for (const [id, record] of Object.entries(parsed?.tables?.workspaces ?? {})) {
    if (Array.isArray(record?.sessionIds) && record.sessionIds.includes(sessionId)) workspaceIds.push(id);
  }
  return { path, archived, pinned, workspaceIds };
}

async function findScheduleTasks() {
  const tasks = [];
  const dir = join(storagesRoot, "schedule", "tasks");
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return tasks;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await readFile(join(dir, entry.name), "utf8"));
      if (parsed?.sessionId === sessionId) tasks.push(join(dir, entry.name));
    } catch {
      /* a malformed record cannot be attributed to this Session */
    }
  }
  return tasks;
}

async function findSpillDirs() {
  const found = [];
  const leaf = spillSessionDirName(sessionId);
  let roots;
  try {
    roots = await readdir(tmpdir(), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const root of roots) {
    if (!root.isDirectory() || !/^dsh-spill-[A-Za-z0-9]{6}$/.test(root.name)) continue;
    const candidate = join(tmpdir(), root.name, leaf);
    if (await exists(candidate)) found.push(candidate);
  }
  return found;
}

const report = {
  sessionId,
  dshHome: home,
  present: false,
  locations: {
    sessionDirs: await findSessionDirs(),
    projectionCache: await findProjectionCache(),
    workspace: await findWorkspaceReferences(),
    scheduleTasks: await findScheduleTasks(),
    spillDirs: await findSpillDirs(),
  },
};

report.present =
  report.locations.sessionDirs.length > 0 ||
  report.locations.projectionCache !== undefined ||
  report.locations.workspace.archived ||
  report.locations.workspace.pinned ||
  report.locations.workspace.workspaceIds.length > 0 ||
  report.locations.scheduleTasks.length > 0 ||
  report.locations.spillDirs.length > 0;

if (jsonMode) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} else {
  const lines = [
    `session: ${report.sessionId}`,
    `home:    ${report.dshHome}`,
    `present: ${report.present}`,
    `  session dirs:      ${report.locations.sessionDirs.length === 0 ? "absent" : report.locations.sessionDirs.join(", ")}`,
    `  projection cache:  ${report.locations.projectionCache === undefined ? "absent" : report.locations.projectionCache}`,
    `  workspace.json:    archived=${Boolean(report.locations.workspace.archived)} pinned=${Boolean(report.locations.workspace.pinned)} workspaces=[${report.locations.workspace.workspaceIds.join(", ")}]`,
    `  schedule tasks:    ${report.locations.scheduleTasks.length === 0 ? "absent" : report.locations.scheduleTasks.join(", ")}`,
    `  spill dirs:        ${report.locations.spillDirs.length === 0 ? "absent" : report.locations.spillDirs.join(", ")}`,
  ];
  process.stdout.write(lines.join("\n") + "\n");
}
process.exit(report.present ? 1 : 0);
