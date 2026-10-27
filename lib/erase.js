/**
 * Core erasure engine for one Session. Host-agnostic: every service and every
 * filesystem deletion is injected, so the engine runs unchanged under
 * `node:test` with fakes.
 *
 * Safety rules enforced here (each one is covered by a test):
 *  - A live Session is released through its own lifecycle (flush → detach →
 *    `session/disposed` → projection-cache checkpoint → store check) before a
 *    single byte is deleted; any release failure stops the erase.
 *  - No archive-state-changing API is called before the deletion is verified.
 *    Archiving/pinning cleanup runs only after the Session is proven gone.
 *  - Registry detach is unconditional and idempotent for every workspace.
 *  - A missing persistence/storage/registry service, an unreadable root or a
 *    failed verification is an error — never `alreadyGone`, never success.
 *  - `ok: true` requires every verification check to pass against real
 *    persisted state (`workspace.json`, session directories, projection cache).
 */
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  assertInside,
  encodeSegment,
  spillSessionDirName,
  splitParent,
  validateSessionId,
} from "./paths.js";

const MAX_SCAN_DIRS = 4096;

/** @param {unknown} error @returns {string} a diagnostic message, never a stack. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {string} path @returns {Promise<boolean>} whether the path exists. */
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Recursively sum file sizes without following links. */
async function directoryBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return total;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) total += await directoryBytes(join(dir, entry.name));
    else if (entry.isFile()) {
      try {
        total += (await stat(join(dir, entry.name))).size;
      } catch {
        /* raced away */
      }
    }
  }
  return total;
}

/** @returns {Promise<Array<Record<string, unknown>>>} persisted headers. Throws when listing fails. */
async function listPersistedHeaders(persistence) {
  if (persistence === undefined || typeof persistence.list !== "function") {
    throw new Error("session persistence service is unavailable");
  }
  const snapshots = await persistence.list();
  return snapshots
    .map((snapshot) => snapshot?.header)
    .filter((header) => header !== undefined && typeof header.id === "string");
}

/**
 * Every project directory containing the encoded Session id, containment
 * checked, from an already-read sessions-root listing.
 * @returns {Promise<string[]>} existing session directories.
 */
async function dirsFromEntries(rootEntries, sessionsRoot, sessionId) {
  const encoded = encodeSegment(sessionId);
  const found = [];
  for (const entry of rootEntries.slice(0, MAX_SCAN_DIRS)) {
    if (!entry.isDirectory()) continue;
    const candidate = join(sessionsRoot, entry.name, encoded);
    if (await exists(candidate)) found.push(assertInside(sessionsRoot, candidate));
  }
  return found;
}

/**
 * Schedule task record keys bound to the Session.
 * A deployment without the schedule feature has no domain — an empty result.
 * A registered domain whose table cannot be read is an error, never "no tasks".
 * @returns {{keys: string[], available: boolean, reason?: string}}
 */
function scheduleKeysOf(services, sessionId) {
  const domain = services.storageDomain?.get?.("schedule");
  if (domain === undefined) return { keys: [], available: true };
  let table;
  try {
    table = domain.table("tasks");
  } catch (error) {
    return { keys: [], available: false, reason: `schedule table read failed: ${messageOf(error)}` };
  }
  const keys = [];
  try {
    for (const [key, value] of table.entries()) {
      if (value?.sessionId === sessionId) keys.push(key);
    }
  } catch (error) {
    return { keys: [], available: false, reason: `schedule table read failed: ${messageOf(error)}` };
  }
  return { keys, available: true };
}

/**
 * Projection-cache state. The domain is owned by the base composition, so a
 * missing domain or an unreadable table is unavailable — never "no record".
 * @returns {{present: boolean, table?: object, unavailable?: boolean, reason?: string}}
 */
function projectionCacheOf(services, sessionId) {
  const domain = services.storageDomain?.get?.("session_projcache");
  if (domain === undefined) {
    return { present: false, unavailable: true, reason: "the session_projcache domain is not open" };
  }
  let table;
  try {
    table = domain.table("sessions");
  } catch (error) {
    return { present: false, unavailable: true, reason: `session_projcache table read failed: ${messageOf(error)}` };
  }
  try {
    return { present: table.get(sessionId) !== undefined, table };
  } catch (error) {
    return { present: false, unavailable: true, reason: `session_projcache record read failed: ${messageOf(error)}` };
  }
}

/**
 * Read the persisted workspace registry directly. A missing file means an
 * empty registry; any other read/parse failure is reported as `error` so
 * verification can fail closed.
 * @returns {Promise<{path: string, archived: boolean, pinned: boolean, workspaceIds: string[], any: boolean, error?: string}>}
 */
async function readWorkspaceState(workspacesJson, sessionId) {
  const empty = { path: workspacesJson, archived: false, pinned: false, workspaceIds: [], any: false };
  let raw;
  try {
    raw = await readFile(workspacesJson, "utf8");
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") return empty;
    return { ...empty, error: `cannot read ${workspacesJson}: ${messageOf(error)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ...empty, error: `${workspacesJson} is not valid JSON: ${messageOf(error)}` };
  }
  const global = parsed?.global ?? {};
  const archived = Array.isArray(global.archivedSessionIds) && global.archivedSessionIds.includes(sessionId);
  const pinned = Array.isArray(global.pinnedSessionIds) && global.pinnedSessionIds.includes(sessionId);
  const workspaceIds = [];
  for (const [id, record] of Object.entries(parsed?.tables?.workspaces ?? {})) {
    if (Array.isArray(record?.sessionIds) && record.sessionIds.includes(sessionId)) workspaceIds.push(id);
  }
  return { path: workspacesJson, archived, pinned, workspaceIds, any: archived || pinned || workspaceIds.length > 0 };
}

/** A typed failure the route maps to a status code. */
function codeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Await one promise with a bounded failure; the timer never outlives the wait. */
async function waitFor(promise, milliseconds, code, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(codeError(code, message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Release a live Session through the store's own lifecycle, and prove it is
 * gone before anything is deleted:
 *   subscribe `session/disposed` + the projection-cache `domain/changed` write
 *   → flush → detach → require the dispose event → require `ctx.sessions.get`
 *   to be empty → require the projection-cache detach checkpoint to land.
 * Every failure is a typed error; the caller deletes nothing.
 * @param {object} deps - engine dependencies (services, onEvent, cacheWriteTimeoutMs).
 * @param {string} sessionId - the Session id.
 * @param {object} live - the live Session object.
 * @returns {Promise<{disposed: boolean, cacheWritten: boolean}>} release evidence.
 */
async function releaseLiveSession(deps, sessionId, live) {
  const { services = {}, onEvent } = deps;
  const sessions = services.sessions;
  if (typeof onEvent !== "function") throw codeError("release-unavailable", "event subscription is unavailable");
  if (sessions === undefined || typeof sessions.flush !== "function") {
    throw codeError("release-unavailable", "session flush is unavailable");
  }
  if (typeof sessions.liveEntryFor !== "function") {
    throw codeError("release-unavailable", "session release is unavailable (liveEntryFor)");
  }

  let disposed = false;
  let cacheWritten = false;
  let resolveDisposed;
  let resolveCache;
  const disposedPromise = new Promise((resolve) => {
    resolveDisposed = resolve;
  });
  const cachePromise = new Promise((resolve) => {
    resolveCache = resolve;
  });
  // Subscribe BEFORE flushing/detaching so neither event can be missed.
  const offs = [
    onEvent("session/disposed", (session) => {
      if (session?.id !== sessionId) return;
      disposed = true;
      resolveDisposed();
    }),
    onEvent("domain/changed", (change) => {
      if (
        change?.domain === "session_projcache" &&
        change?.table === "sessions" &&
        change?.key === sessionId &&
        change?.operation === "put"
      ) {
        cacheWritten = true;
        resolveCache();
      }
    }),
  ];
  try {
    try {
      await sessions.flush(live);
    } catch (error) {
      throw codeError("flush-failed", `flushing the session failed: ${messageOf(error)}`);
    }
    let entry;
    try {
      entry = sessions.liveEntryFor(live);
    } catch (error) {
      throw codeError("release-unavailable", `session release is unavailable: ${messageOf(error)}`);
    }
    if (entry === undefined || typeof entry.detach !== "function") {
      throw codeError("release-unavailable", "session release is unavailable (detach)");
    }
    try {
      entry.detach();
    } catch (error) {
      throw codeError("release-failed", `detaching the session failed: ${messageOf(error)}`);
    }
    if (!disposed) {
      throw codeError("release-timeout", "the session was detached but no session/disposed event was observed");
    }
    if (sessions.get(sessionId) !== undefined) {
      throw codeError("session-live", "the session is still live after detach; no files were deleted");
    }
    await waitFor(
      cachePromise,
      deps.cacheWriteTimeoutMs ?? 5000,
      "cache-write-timeout",
      "the projection cache detach checkpoint did not land",
    );
    return { disposed, cacheWritten };
  } finally {
    for (const off of offs) {
      try {
        off();
      } catch {
        /* listener already removed */
      }
    }
  }
}

/**
 * Erase one Session from every location this deployment owns.
 *
 * @param {object} deps - injected environment.
 * @param {object} deps.services - host services: sessions, sessionPersistence, workspaceRegistry, storageDomain, stopSession.
 * @param {string} deps.sessionsRoot - JSONL persistence root.
 * @param {string} deps.workspacesJson - persisted workspace registry file (verified directly).
 * @param {string} deps.tmpdir - OS temp directory holding spill roots.
 * @param {{rm?: Function}} [deps.io] - fs overrides for fault injection tests.
 * @param {string} sessionId - the target Session id.
 * @returns {Promise<object>} structured result with per-location evidence.
 */
export async function eraseSession(deps, sessionId) {
  validateSessionId(sessionId);
  const { services = {}, sessionsRoot, workspacesJson, tmpdir } = deps;
  const io = deps.io ?? {};
  const rmDir = io.rm ?? ((path) => rm(path, { recursive: true, force: true }));

  const steps = [];
  const failures = [];
  const removed = {
    sessionDirs: [],
    bytesFreed: 0,
    detachedFromWorkspaces: [],
    archiveEntriesRemoved: 0,
    pinsRemoved: 0,
    projectionCacheRecords: 0,
    scheduleTasks: 0,
    spillDirs: [],
  };
  const record = (name, ok, extra = {}) => steps.push({ name, ok, ...extra });
  const fail = (code, message, extra = {}) => ({
    ok: false,
    code,
    error: message,
    sessionId,
    liveSession: false,
    removed,
    steps,
    failures,
    ...extra,
  });

  /* 0 — required services: refuse rather than guess -------------------- */
  if (services.sessionPersistence === undefined || typeof services.sessionPersistence.list !== "function") {
    return fail("persistence-unavailable", "the session persistence service is unavailable; refusing to erase");
  }
  if (services.workspaceRegistry === undefined) {
    return fail("workspace-registry-unavailable", "the workspace registry service is unavailable; refusing to erase");
  }
  if (services.storageDomain === undefined) {
    return fail("storage-domain-unavailable", "the storage domain service is unavailable; refusing to erase");
  }
  if (typeof services.stopSession !== "function") {
    return fail("stop-unavailable", "the workspace/session-stop seam is unavailable; refusing to erase");
  }
  if (services.sessions === undefined || typeof services.sessions.get !== "function") {
    return fail("sessions-unavailable", "the live session store is unavailable; refusing to erase");
  }

  /* 1 — the live Session, released later through its own lifecycle ------ */
  const live = services.sessions.get(sessionId);

  /* 2 — root readability ---------------------------------------------- */
  let rootEntries;
  try {
    rootEntries = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    return fail("sessions-root-unreadable", `cannot read the sessions root ${sessionsRoot}: ${messageOf(error)}`);
  }

  /* 3 — existence proof ------------------------------------------------ */
  let persistedHeaders;
  try {
    persistedHeaders = await listPersistedHeaders(services.sessionPersistence);
  } catch (error) {
    return fail("persistence-list-failed", `session persistence listing failed: ${messageOf(error)}`);
  }
  const persistedHeader = persistedHeaders.find((header) => header.id === sessionId);
  const dirs = await dirsFromEntries(rootEntries, sessionsRoot, sessionId);
  const projCache = projectionCacheOf(services, sessionId);
  if (projCache.unavailable === true) {
    return fail("projection-cache-unavailable", projCache.reason ?? "the projection cache is unavailable; refusing to erase");
  }
  const schedule = scheduleKeysOf(services, sessionId);
  if (!schedule.available) {
    return fail("schedule-unavailable", schedule.reason ?? "the schedule store is unavailable; refusing to erase");
  }
  const scheduleKeys = schedule.keys;
  const workspaceState = await readWorkspaceState(workspacesJson, sessionId);
  if (workspaceState.error !== undefined) {
    return fail("workspace-state-unreadable", workspaceState.error);
  }

  const existed = Boolean(
    persistedHeader || dirs.length > 0 || projCache.present || scheduleKeys.length > 0 || workspaceState.any,
  );
  if (!existed) {
    // All sources were available and readable; a definite miss may report
    // alreadyGone without writing anything.
    return {
      ok: true,
      alreadyGone: true,
      sessionId,
      liveSession: false,
      removed,
      steps,
      failures,
      verification: {
        allClear: true,
        sessionRecordPresent: false,
        dirsRemaining: [],
        projectionCachePresent: false,
        scheduleTasksRemaining: 0,
        workspaceState: { archived: false, pinned: false, workspaceIds: [] },
      },
    };
  }

  /* 4 — stop residual writers through the official seam ---------------- */
  try {
    await services.stopSession(sessionId);
    record("stop-session-activity", true);
  } catch (error) {
    failures.push({ step: "stop-session-activity", message: messageOf(error) });
    record("stop-session-activity", false, { error: messageOf(error) });
    return fail("stop-failed", `could not stop the session's activity: ${messageOf(error)}`);
  }

  /* 4b — release a live Session through its own lifecycle ---------------- */
  if (live !== undefined) {
    try {
      await releaseLiveSession(deps, sessionId, live);
      record("release-live-session", true);
    } catch (error) {
      failures.push({ step: "release-live-session", message: messageOf(error) });
      record("release-live-session", false, { error: messageOf(error) });
      return fail(error.code ?? "release-failed", messageOf(error), { liveSession: true });
    }
  }
  if (services.sessions.get(sessionId) !== undefined) {
    return fail("session-live", "the session is still live; no files were deleted", { liveSession: true });
  }

  /* 5 — delete Session directories ------------------------------------- */
  for (const dir of dirs) {
    const { parent, name } = splitParent(dir);
    assertInside(parent, dir);
    const bytes = await directoryBytes(dir);
    try {
      await rmDir(dir);
      if (await exists(dir)) throw new Error("directory still exists after rm");
      removed.sessionDirs.push(dir);
      removed.bytesFreed += bytes;
      record(`delete-dir:${name}`, true);
    } catch (error) {
      failures.push({ step: `delete-dir:${name}`, message: messageOf(error) });
      record(`delete-dir:${name}`, false, { error: messageOf(error) });
    }
  }
  if (failures.some((failure) => failure.step.startsWith("delete-dir"))) {
    // Partial deletion: report exactly what remains; never touch the registry.
    const verification = await verifyErased(deps, sessionId);
    return fail(
      "delete-failed",
      "some session directories could not be removed; the workspace registry was left untouched",
      { verification },
    );
  }

  /* 6 — derived per-session data --------------------------------------- */
  if (projCache.table !== undefined) {
    try {
      await projCache.table.delete(sessionId);
      removed.projectionCacheRecords = 1;
      record("delete-projection-cache", true);
    } catch (error) {
      failures.push({ step: "delete-projection-cache", message: messageOf(error) });
      record("delete-projection-cache", false, { error: messageOf(error) });
    }
  }
  if (scheduleKeys.length > 0) {
    const domain = services.storageDomain.get("schedule");
    const table = domain.table("tasks");
    for (const key of scheduleKeys) {
      try {
        await table.delete(key);
        removed.scheduleTasks += 1;
        record(`delete-schedule-task:${key}`, true);
      } catch (error) {
        failures.push({ step: `delete-schedule-task:${key}`, message: messageOf(error) });
        record(`delete-schedule-task:${key}`, false, { error: messageOf(error) });
      }
    }
  }

  /* 7 — spill directories (exact hash-derived leaf only) --------------- */
  const spillLeaf = spillSessionDirName(sessionId);
  let spillRoots = [];
  try {
    spillRoots = (await readdir(tmpdir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^dsh-spill-[A-Za-z0-9]{6}$/.test(entry.name))
      .map((entry) => join(tmpdir, entry.name));
  } catch {
    spillRoots = [];
  }
  for (const root of spillRoots) {
    const target = join(root, spillLeaf);
    if (!(await exists(target))) continue;
    try {
      await rmDir(assertInside(root, target));
      removed.spillDirs.push(target);
      record(`delete-spill:${spillLeaf}`, true);
    } catch (error) {
      failures.push({ step: `delete-spill:${spillLeaf}`, message: messageOf(error) });
      record(`delete-spill:${spillLeaf}`, false, { error: messageOf(error) });
    }
  }

  /* 8 — data-layer verification before any registry change ------------- */
  // The workspace registry is deliberately excluded here: it still lists the
  // Session by design until step 9 proves the data is gone.
  const dataVerification = await verifyErased(deps, sessionId, { includeWorkspace: false });
  if (!dataVerification.allClear) {
    return fail("verification-failed", "the session's data is not fully gone; the workspace registry was left untouched", {
      verification: dataVerification,
    });
  }

  /* 9 — registry cleanup, only after the Session is proven gone -------- */
  try {
    for (const workspace of services.workspaceRegistry.list()) {
      // Unconditional and idempotent: never trust the filtered sessionIds getter.
      await workspace.detachSession(sessionId);
      removed.detachedFromWorkspaces.push(String(workspace.id));
    }
    record("detach-workspace-accounts", true);
  } catch (error) {
    failures.push({ step: "detach-workspace-accounts", message: messageOf(error) });
    record("detach-workspace-accounts", false, { error: messageOf(error) });
  }
  try {
    if (Array.isArray(services.workspaceRegistry.archivedSessionIds) && services.workspaceRegistry.archivedSessionIds.includes(sessionId)) {
      await services.workspaceRegistry.unarchiveSession(sessionId);
      removed.archiveEntriesRemoved = 1;
      record("clear-archive-entry", true);
    }
  } catch (error) {
    failures.push({ step: "clear-archive-entry", message: messageOf(error) });
    record("clear-archive-entry", false, { error: messageOf(error) });
  }
  try {
    if (Array.isArray(services.workspaceRegistry.pinnedSessionIds) && services.workspaceRegistry.pinnedSessionIds.includes(sessionId)) {
      await services.workspaceRegistry.unpinSession(sessionId);
      removed.pinsRemoved = 1;
      record("clear-pin-entry", true);
    }
  } catch (error) {
    failures.push({ step: "clear-pin-entry", message: messageOf(error) });
    record("clear-pin-entry", false, { error: messageOf(error) });
  }

  /* 10 — final verification against persisted state -------------------- */
  const verification = await verifyErased(deps, sessionId);
  const ok = verification.allClear && failures.length === 0;
  return {
    ok,
    ...(ok ? {} : { code: "verification-failed", error: "the workspace registry still references the session" }),
    alreadyGone: false,
    sessionId,
    liveSession: false,
    removed,
    steps,
    failures,
    verification,
  };
}

/**
 * Verify every location the engine owns reports the Session absent.
 * Fails closed: an unreadable registry file or persistence listing is an error.
 * @param {object} deps - injected environment.
 * @param {string} sessionId - the Session id.
 * @param {{includeWorkspace?: boolean}} [options] - exclude the registry for the pre-cleanup data pass.
 * @returns {Promise<object>} per-location evidence and `allClear`.
 */
export async function verifyErased(deps, sessionId, options = {}) {
  const includeWorkspace = options.includeWorkspace !== false;
  const { services = {}, sessionsRoot, workspacesJson } = deps;
  const errors = [];

  let sessionRecordPresent = false;
  try {
    const persistedHeaders = await listPersistedHeaders(services.sessionPersistence);
    sessionRecordPresent = persistedHeaders.some((header) => header.id === sessionId);
  } catch (error) {
    errors.push(`persistence: ${messageOf(error)}`);
  }

  let dirsRemaining = [];
  try {
    const rootEntries = await readdir(sessionsRoot, { withFileTypes: true });
    dirsRemaining = await dirsFromEntries(rootEntries, sessionsRoot, sessionId);
  } catch (error) {
    errors.push(`sessions root: ${messageOf(error)}`);
  }

  let projectionCachePresent = false;
  const projCache = projectionCacheOf(services, sessionId);
  if (projCache.unavailable === true) errors.push(`projection cache: ${projCache.reason ?? "unavailable"}`);
  else projectionCachePresent = projCache.present;

  let scheduleTasksRemaining = 0;
  const schedule = scheduleKeysOf(services, sessionId);
  if (!schedule.available) errors.push(`schedule: ${schedule.reason ?? "unavailable"}`);
  else scheduleTasksRemaining = schedule.keys.length;

  const workspaceState = includeWorkspace
    ? await readWorkspaceState(workspacesJson, sessionId)
    : { path: workspacesJson, archived: false, pinned: false, workspaceIds: [], any: false };
  if (workspaceState.error !== undefined) errors.push(workspaceState.error);

  const allClear =
    errors.length === 0 &&
    !sessionRecordPresent &&
    dirsRemaining.length === 0 &&
    !projectionCachePresent &&
    scheduleTasksRemaining === 0 &&
    (includeWorkspace ? !workspaceState.any : true);
  return {
    allClear,
    sessionRecordPresent,
    dirsRemaining,
    projectionCachePresent,
    scheduleTasksRemaining,
    workspaceState: {
      archived: workspaceState.archived,
      pinned: workspaceState.pinned,
      workspaceIds: workspaceState.workspaceIds,
    },
    ...(errors.length === 0 ? {} : { errors }),
  };
}
