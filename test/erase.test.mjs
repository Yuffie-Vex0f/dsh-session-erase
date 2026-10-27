import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eraseSession, verifyErased } from "../lib/erase.js";
import { encodeSegment, projectKey, spillSessionDirName } from "../lib/paths.js";

const SID = "session-11111111-2222-3333-4444-555555555555";
const OTHER = "session-99999999-8888-7777-6666-555555555555";

/** Throwaway root with sessions/, storages/workspace.json, attachments and a spill root. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "session-erase-test-"));
  const sessionsRoot = join(root, "sessions");
  const cwd = join(root, "workspace");
  const otherCwd = join(root, "other");
  const attachments = join(root, "attachments");
  const scratch = join(root, "tmp");
  const workspacesJson = join(root, "storages", "workspace.json");
  await mkdir(scratch, { recursive: true });
  await mkdir(attachments, { recursive: true });
  await mkdir(join(root, "storages"), { recursive: true });
  await mkdir(join(sessionsRoot, projectKey(cwd)), { recursive: true });
  await writeFile(join(attachments, "shared-object.bin"), "shared");
  return { root, sessionsRoot, cwd, otherCwd, attachments, scratch, workspacesJson };
}

/** Write one session directory with an opaque payload (the engine never parses logs). */
async function makeSessionDir(sessionsRoot, cwd, id) {
  const dir = join(sessionsRoot, projectKey(cwd), encodeSegment(id));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "session.v4.jsonl"), JSON.stringify({ type: "session", version: 4, id }) + "\n");
  return dir;
}

const exists = (path) => stat(path).then(() => true, () => false);

/**
 * Fake host services. The workspace registry persists to the real
 * workspace.json so verification reads actual persisted state.
 */
function makeServices(options = {}) {
  const calls = [];
  const projcache = new Map(options.projcache ?? []);
  const schedule = new Map(options.schedule ?? []);
  const live = new Set(options.live ?? []);
  const state = {
    archived: [...(options.archived ?? [])],
    pinned: [...(options.pinned ?? [])],
    workspaces: (options.workspaces ?? []).map((workspace) => ({ id: workspace.id, sessionIds: [...workspace.sessionIds] })),
  };
  const workspacesJson = options.workspacesJson;

  const persist = async () => {
    if (workspacesJson === undefined) return;
    const tables = Object.fromEntries(state.workspaces.map((workspace) => [workspace.id, {
      path: "V:\\fake",
      title: workspace.id,
      sessionIds: [...workspace.sessionIds],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }]));
    await writeFile(workspacesJson, JSON.stringify({
      unit: { name: "workspace", version: 2 },
      global: { initialized: true, workspaceIds: state.workspaces.map((workspace) => workspace.id), archivedSessionIds: state.archived, pinnedSessionIds: state.pinned },
      tables: { workspaces: tables },
    }, null, 2));
  };

  const registry = {
    get archivedSessionIds() {
      return state.archived;
    },
    get pinnedSessionIds() {
      return state.pinned;
    },
    list: () => state.workspaces.map((workspace) => ({
      id: workspace.id,
      // A filtered getter: hides ids the host cannot resolve. detachSession must not rely on it.
      get sessionIds() {
        return options.hideFiltered ? [] : workspace.sessionIds;
      },
      async detachSession(sessionId) {
        calls.push(["detachSession", workspace.id, sessionId]);
        if (workspace.sessionIds.includes(sessionId)) {
          workspace.sessionIds = workspace.sessionIds.filter((id) => id !== sessionId);
          await persist();
        }
      },
    })),
    async archiveSession() {
      calls.push(["archiveSession"]);
      throw new Error("archiveSession must never be called by the eraser");
    },
    async unarchiveSession(sessionId) {
      calls.push(["unarchiveSession", sessionId]);
      if (state.archived.includes(sessionId)) {
        state.archived = state.archived.filter((id) => id !== sessionId);
        await persist();
      }
    },
    async unpinSession(sessionId) {
      calls.push(["unpinSession", sessionId]);
      if (state.pinned.includes(sessionId)) {
        state.pinned = state.pinned.filter((id) => id !== sessionId);
        await persist();
      }
    },
  };

  const persistence = {
    async list() {
      if (options.persistence === "throw") throw new Error("persistence read failed");
      const out = [];
      for (const header of options.persisted ?? []) {
        if (options.persistence === "stuck") {
          out.push({ header });
          continue;
        }
        const dir = join(options.sessionsRoot, projectKey(header.cwd), encodeSegment(header.id));
        if (await exists(dir)) out.push({ header });
      }
      return out;
    },
  };

  const tableFor = (domain, tableName) => ({
    get: (key) => (domain === "session_projcache" ? projcache.get(key) : undefined),
    entries: () => (domain === "schedule" ? [...schedule.entries()] : []),
    async delete(key) {
      calls.push(["table.delete", domain, tableName, key]);
      if (domain === "session_projcache") return projcache.delete(key);
      return schedule.delete(key);
    },
  });

  const storageDomain = {
    get: (domain) => {
      if (domain === "session_projcache" && options.projcacheDomain === "missing") return undefined;
      if (domain === "schedule" && options.scheduleDomain === "missing") return undefined;
      return {
        table: (tableName) => {
          if (domain === "session_projcache" && options.projcacheThrow === true) throw new Error("projection cache table unavailable");
          if (domain === "schedule" && options.scheduleThrow === true) throw new Error("schedule table unavailable");
          return tableFor(domain, tableName);
        },
      };
    },
  };

  const liveSessions = new Map((options.live ?? []).map((id) => [id, { id, header: { id } }]));
  const listeners = new Map();
  const onEvent = (event, listener) => {
    const set = listeners.get(event) ?? new Set();
    set.add(listener);
    listeners.set(event, set);
    return () => set.delete(listener);
  };
  const emit = (event, payload) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(payload);
  };
  const emitCacheWrite = (sessionId) => {
    calls.push(["cacheWrite", sessionId]);
    emit("domain/changed", { domain: "session_projcache", table: "sessions", key: sessionId, operation: "put" });
  };
  const sessions = {
    get: (id) => liveSessions.get(id),
    async flush(session) {
      calls.push(["flush", session.id]);
      if (options.flush === "throw") throw new Error("flush failed");
    },
    liveEntryFor(session) {
      if (options.release === "missing") return undefined;
      if (options.release === "throw") throw new Error("liveEntryFor failed");
      return {
        detach: () => {
          calls.push(["detach", session.id]);
          if (options.detach === "throw") throw new Error("detach failed");
          if (options.detach === "keep-live") {
            emit("session/disposed", { id: session.id });
            emitCacheWrite(session.id);
            return;
          }
          liveSessions.delete(session.id);
          if (options.detach === "no-disposed") return;
          emit("session/disposed", { id: session.id });
          if (options.cacheWrite === "never") return;
          const delay = options.cacheWriteDelay ?? 0;
          if (delay > 0) setTimeout(() => emitCacheWrite(session.id), delay);
          else emitCacheWrite(session.id);
        },
      };
    },
  };

  const services = {
    sessions,
    sessionPersistence: options.persistence === "unavailable" ? undefined : persistence,
    workspaceRegistry: options.registry === "unavailable" ? undefined : registry,
    storageDomain: options.storage === "unavailable" ? undefined : storageDomain,
    stopSession: async (sessionId) => {
      calls.push(["stopSession", sessionId]);
      if (options.stop === "throw") throw new Error("workspace/session-stop failed");
    },
  };
  return { services, calls, state, projcache, schedule, persist, live: liveSessions, onEvent, emit };
}

async function seedWorkspaceJson(f, services) {
  await services.persist();
}

/* ── tests ───────────────────────────────────────────────────────────── */

test("erases a persisted session, leaves other sessions and shared data alone", async () => {
  const f = await fixture();
  const targetDir = await makeSessionDir(f.sessionsRoot, f.cwd, SID);
  const otherDir = await makeSessionDir(f.sessionsRoot, f.cwd, OTHER);
  const spillLeaf = join(f.scratch, "dsh-spill-AbC123", spillSessionDirName(SID));
  await mkdir(spillLeaf, { recursive: true });
  await writeFile(join(spillLeaf, "note.txt"), "spill");

  const { services, calls, state } = makeServices({
    sessionsRoot: f.sessionsRoot,
    workspacesJson: f.workspacesJson,
    persisted: [{ id: SID, cwd: f.cwd }, { id: OTHER, cwd: f.cwd }],
    workspaces: [{ id: "ws-1", sessionIds: [SID, OTHER] }],
    archived: [SID],
    pinned: [SID],
    projcache: [[SID, { title: "target" }], [OTHER, { title: "other" }]],
    schedule: [["task-1", { sessionId: SID, status: "active" }], ["task-2", { sessionId: OTHER, status: "active" }]],
  });
  await seedWorkspaceJson(f, { persist: async () => {
    const tables = Object.fromEntries(state.workspaces.map((workspace) => [workspace.id, { path: "V:\\fake", title: workspace.id, sessionIds: [...workspace.sessionIds] }]));
    await writeFile(f.workspacesJson, JSON.stringify({
      global: { archivedSessionIds: state.archived, pinnedSessionIds: state.pinned, workspaceIds: state.workspaces.map((w) => w.id) },
      tables: { workspaces: tables },
    }));
  } });

  const result = await eraseSession({ services, sessionsRoot: f.sessionsRoot, workspacesJson: f.workspacesJson, tmpdir: f.scratch }, SID);

  assert.equal(result.ok, true, JSON.stringify({ failures: result.failures, verification: result.verification }));
  assert.equal(result.verification.allClear, true, JSON.stringify(result.verification));

  await assert.rejects(stat(targetDir));
  assert.equal(await exists(join(otherDir, "session.v4.jsonl")), true);
  assert.equal(await exists(join(f.attachments, "shared-object.bin")), true);
  assert.equal(await exists(spillLeaf), false);

  // archive API is never used; the stop seam is
  assert.equal(calls.some((call) => call[0] === "archiveSession"), false);
  assert.ok(calls.some((call) => call[0] === "stopSession" && call[1] === SID));

  // registry: target rid of every reference, other session untouched
  const raw = JSON.parse(await readFile(f.workspacesJson, "utf8"));
  assert.deepEqual(raw.global.archivedSessionIds, []);
  assert.deepEqual(raw.global.pinnedSessionIds, []);
  assert.deepEqual(raw.tables.workspaces["ws-1"].sessionIds, [OTHER]);

  // derived per-session data
  assert.equal(result.removed.projectionCacheRecords, 1);
  assert.equal(result.removed.scheduleTasks, 1);
});

test("releases a live session before deleting: flush → detach → disposed → cache write → rm", async () => {
  const f = await fixture();
  const targetDir = await makeSessionDir(f.sessionsRoot, f.cwd, SID);
  await writeFile(f.workspacesJson, JSON.stringify({
    global: { archivedSessionIds: [], pinnedSessionIds: [], workspaceIds: ["ws-1"] },
    tables: { workspaces: { "ws-1": { path: "V:\\fake", title: "ws-1", sessionIds: [SID] } } },
  }));
  const { services, calls, onEvent } = makeServices({
    sessionsRoot: f.sessionsRoot,
    workspacesJson: f.workspacesJson,
    persisted: [{ id: SID, cwd: f.cwd }],
    workspaces: [{ id: "ws-1", sessionIds: [SID] }],
    live: [SID],
  });
  const order = [];
  const io = {
    rm: async (path) => {
      order.push("rm");
      await rm(path, { recursive: true, force: true });
    },
  };
  const result = await eraseSession(
    { services, onEvent, sessionsRoot: f.sessionsRoot, workspacesJson: f.workspacesJson, tmpdir: f.scratch, io },
    SID,
  );

  assert.equal(result.ok, true, JSON.stringify({ failures: result.failures, verification: result.verification }));
  await assert.rejects(stat(targetDir));
  const flushAt = calls.findIndex((call) => call[0] === "flush");
  const detachAt = calls.findIndex((call) => call[0] === "detach");
  assert.ok(flushAt !== -1 && detachAt !== -1 && flushAt < detachAt, "flush precedes detach");
  assert.ok(order.includes("rm"));
  const releaseAt = result.steps.findIndex((step) => step.name === "release-live-session");
  const deleteAt = result.steps.findIndex((step) => step.name.startsWith("delete-dir"));
  assert.ok(releaseAt !== -1 && deleteAt !== -1 && releaseAt < deleteAt, "release precedes deletion");
  assert.ok(calls.some((call) => call[0] === "cacheWrite"), "the detach checkpoint was observed");
  assert.equal(result.verification.allClear, true);
});

test("a late projection-cache write is awaited before the cache row is deleted", async () => {
  const f = await fixture();
  await makeSessionDir(f.sessionsRoot, f.cwd, SID);
  await writeFile(f.workspacesJson, JSON.stringify({
    global: { archivedSessionIds: [], pinnedSessionIds: [], workspaceIds: ["ws-1"] },
    tables: { workspaces: { "ws-1": { path: "V:\\fake", title: "ws-1", sessionIds: [SID] } } },
  }));
  const { services, calls, onEvent } = makeServices({
    sessionsRoot: f.sessionsRoot,
    workspacesJson: f.workspacesJson,
    persisted: [{ id: SID, cwd: f.cwd }],
    workspaces: [{ id: "ws-1", sessionIds: [SID] }],
    live: [SID],
    cacheWriteDelay: 30,
  });
  const result = await eraseSession(
    { services, onEvent, sessionsRoot: f.sessionsRoot, workspacesJson: f.workspacesJson, tmpdir: f.scratch },
    SID,
  );
  assert.equal(result.ok, true, JSON.stringify({ failures: result.failures, verification: result.verification }));
  const cacheAt = calls.findIndex((call) => call[0] === "cacheWrite");
  const deleteAt = calls.findIndex((call) => call[0] === "table.delete" && call[1] === "session_projcache");
  assert.ok(cacheAt !== -1 && deleteAt !== -1 && cacheAt < deleteAt, "the cache row is deleted only after the write lands");
});

test("detach unavailable stops the erase with zero deletion", async () => {
  const f = await fixture();
  const targetDir = await makeSessionDir(f.sessionsRoot, f.cwd, SID);
  const { services, onEvent } = makeServices({
    sessionsRoot: f.sessionsRoot,
    workspacesJson: f.workspacesJson,
    persisted: [{ id: SID, cwd: f.cwd }],
    workspaces: [{ id: "ws-1", sessionIds: [SID] }],
    live: [SID],
    release: "missing",
  });
  const result = await eraseSession(
    { services, onEvent, sessionsRoot: f.sessionsRoot, workspacesJson: f.workspacesJson, tmpdir: f.scratch },
    SID,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "release-unavailable");
  assert.equal(await exists(join(targetDir, "session.v4.jsonl")), true);
});

test("a failing flush stops the erase with zero deletion", async () => {
  const f = await fixture();
  const targetDir = await makeSessionDir(f.sessionsRoot, f.cwd, SID);
  const { services, onEvent } = makeServices({
    sessionsRoot: f.sessionsRoot,
    workspacesJson: f.workspacesJson,
    persisted: [{ id: SID, cwd: f.cwd }],
    workspaces: [{ id: "ws-1", sessionIds: [SID] }],
    live: [SID],
    flush: "throw",
  });
  const result = await eraseSession(
    { services, onEvent, sessionsRoot: f.sessionsRoot, workspacesJson: f.workspacesJson, tmpdir: f.scratch },
    SID,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "flush-failed");
  assert.equal(await exists(join(targetDir, "session.v4.jsonl")), true);
});

test("a throwing detach stops the erase with zero deletion", async () => {
  const f = await fixture();
  const targetDir = await makeSessionDir(f.sessionsRoot, f.cwd, SID);
  const { services, onEvent } = makeServices({
    sessionsRoot: f.sessionsRoot,
    workspacesJson: f.workspacesJson,
    persisted: [{ id: SID, cwd: f.cwd }],
    workspaces: [{ id: "ws-1", sessionIds: [SID] }],
    live: [SID],
    detach: "throw",
  });
  const result = await eraseSession(
    { services, onEvent, sessionsRoot: f.sessionsRoot, workspacesJson: f.workspacesJson, tmpdir: f.scratch },
    SID,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "release-failed");
  assert.equal(await exists(join(targetDir, "session.v4.jsonl")), true);
});

test("a detach without session/disposed stops the erase", async () => {
  const f = await fixture();
  const targetDir = await makeSessionDir(f.sessionsRoot, f.cwd, SID);
  const { services, onEvent } = makeServices({
    sessionsRoot: f.sessionsRoot,
    workspacesJson: f.workspacesJson,
    persisted: [{ id: SID, cwd: f.cwd }],
    workspaces: [{ id: "ws-1", sessionIds: [SID] }],
    live: [SID],
    detach: "no-disposed",
  });
  const result = await eraseSession(
    { services, onEvent, sessionsRoot: f.sessionsRoot, workspacesJson: f.workspacesJson, tmpdir: f.scratch },
    SID,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "release-timeout");
  assert.equal(await exists(join(targetDir, "session.v4.jsonl")), true);
});

test("a projection-cache write that never lands stops the erase", async () => {
  const f = await fixture();
  const targetDir = await makeSessionDir(f.sessionsRoot, f.cwd, SID);
  const { services, onEvent } = makeServices({
    sessionsRoot: f.sessionsRoot,
    workspacesJson: f.workspacesJson,
    persisted: [{ id: SID, cwd: f.cwd }],
    workspaces: [{ id: "ws-1", sessionIds: [SID] }],
    live: [SID],
    cacheWrite: "never",
  });
  const result = await eraseSession(
    {
      services,
      onEvent,
      sessionsRoot: f.sessionsRoot,
      workspacesJson: f.workspacesJson,
      tmpdir: f.scratch,
      cacheWriteTimeoutMs: 40,
    },
    SID,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "cache-write-timeout");
  assert.equal(await exists(join(targetDir, "session.v4.jsonl")), true);
});

test("a session that stays live after detach stops the erase", async () => {
  const f = await fixture();
  const targetDir = await makeSessionDir(f.sessionsRoot, f.cwd, SID);
  const { services, onEvent } = makeServices({
    sessionsRoot: f.sessionsRoot,
    workspacesJson: f.workspacesJson,
    persisted: [{ id: SID, cwd: f.cwd }],
    workspaces: [{ id: "ws-1", sessionIds: [SID] }],
    live: [SID],
    detach: "keep-live",
  });
  const result = await eraseSession(
    { services, onEvent, sessionsRoot: f.sessionsRoot, workspacesJson: f.workspacesJson, tmpdir: f.scratch },
    SID,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "session-live");
  assert.equal(await exists(join(targetDir, "session.v4.jsonl")), true);
});

test("repeated erase of a released session is idempotent", async () => {
  const f = await fixture();
  await makeSessionDir(f.sessionsRoot, f.cwd, SID);
  await writeFile(f.workspacesJson, JSON.stringify({
    global: { archivedSessionIds: [], pinnedSessionIds: [], workspaceIds: ["ws-1"] },
    tables: { workspaces: { "ws-1": { path: "V:\\fake", title: "ws-1", sessionIds: [SID] } } },
  }));
  const { services, onEvent, calls } = makeServices({
    sessionsRoot: f.sessionsRoot,
    workspacesJson: f.workspacesJson,
    persisted: [{ id: SID, cwd: f.cwd }],
    workspaces: [{ id: "ws-1", sessionIds: [SID] }],
    live: [SID],
  });
  const first = await eraseSession(
    { services, onEvent, sessionsRoot: f.sessionsRoot, workspacesJson: f.workspacesJson, tmpdir: f.scratch },
    SID,
  );
  assert.equal(first.ok, true, JSON.stringify({ failures: first.failures, verification: first.verification }));
  const countAfterFirst = calls.length;
  const second = await eraseSession(
    { services, onEvent, sessionsRoot: f.sessionsRoot, workspacesJson: f.workspacesJson, tmpdir: f.scratch },
    SID,
  );
  assert.equal(second.ok, true);
  assert.equal(second.alreadyGone, true);
  assert.equal(calls.length, countAfterFirst, "second erase performed no writes");
});

test("an archived session is erased, never unarchived first", async () => {
  const f = await fixture();
  await makeSessionDir(f.sessionsRoot, f.cwd, SID);
  const { services, calls } = makeServices({
    sessionsRoot: f.sessionsRoot,
    workspacesJson: f.workspacesJson,
    persisted: [{ id: SID, cwd: f.cwd }],
    workspaces: [{ id: "ws-1", sessionIds: [] }],
    archived: [SID],
  });
  await writeFile(f.workspacesJson, JSON.stringify({
    global: { archivedSessionIds: [SID], pinnedSessionIds: [], workspaceIds: ["ws-1"] },
    tables: { workspaces: { "ws-1": { path: "V:\\fake", title: "ws-1", sessionIds: [] } } },
  }));

  const result = await eraseSession({ services, sessionsRoot: f.sessionsRoot, workspacesJson: f.workspacesJson, tmpdir: f.scratch }, SID);
  assert.equal(result.ok, true, JSON.stringify({ failures: result.failures, verification: result.verification }));
  assert.equal(result.removed.archiveEntriesRemoved, 1);
  assert.equal(calls.some((call) => call[0] === "archiveSession"), false);
  // unarchive happened only after the data was gone: workspace.json no longer lists it
  const raw = JSON.parse(await readFile(f.workspacesJson, "utf8"));
  assert.deepEqual(raw.global.archivedSessionIds, []);
});

test("persistence service unavailable is an error, never alreadyGone", async () => {
  const f = await fixture();
  const targetDir = await makeSessionDir(f.sessionsRoot, f.cwd, SID);
  const { services } = makeServices({ sessionsRoot: f.sessionsRoot, workspacesJson: f.workspacesJson, persistence: "unavailable" });
  const result = await eraseSession({ services, sessionsRoot: f.sessionsRoot, workspacesJson: f.workspacesJson, tmpdir: f.scratch }, SID);
  assert.equal(result.ok, false);
  assert.equal(result.code, "persistence-unavailable");
  assert.equal(result.alreadyGone, undefined);
  assert.equal(await exists(join(targetDir, "session.v4.jsonl")), true);
});

test("a failing directory removal aborts before touching the registry", async () => {
  const f = await fixture();
  await makeSessionDir(f.sessionsRoot, f.cwd, SID);
  await writeFile(f.workspacesJson, JSON.stringify({
    global: { archivedSessionIds: [], pinnedSessionIds: [], workspaceIds: ["ws-1"] },
    tables: { workspaces: { "ws-1": { path: "V:\\fake", title: "ws-1", sessionIds: [SID] } } },
  }));
  const { services, calls } = makeServices({
    sessionsRoot: f.sessionsRoot,
    workspacesJson: f.workspacesJson,
    persisted: [{ id: SID, cwd: f.cwd }],
    workspaces: [{ id: "ws-1", sessionIds: [SID] }],
  });
  const io = {
    rm: async () => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    },
  };

  const result = await eraseSession({ services, sessionsRoot: f.sessionsRoot, workspacesJson: f.workspacesJson, tmpdir: f.scratch, io }, SID);

  assert.equal(result.ok, false);
  assert.equal(result.code, "delete-failed");
  assert.ok(result.failures.some((failure) => failure.step.startsWith("delete-dir")));
  assert.equal(calls.some((call) => call[0] === "detachSession"), false, "registry was left untouched");
  assert.equal(calls.some((call) => call[0] === "unarchiveSession"), false);
  const raw = JSON.parse(await readFile(f.workspacesJson, "utf8"));
  assert.deepEqual(raw.tables.workspaces["ws-1"].sessionIds, [SID]);
});

test("verification failure keeps the registry untouched and never claims success", async () => {
  const f = await fixture();
  await makeSessionDir(f.sessionsRoot, f.cwd, SID);
  await writeFile(f.workspacesJson, JSON.stringify({
    global: { archivedSessionIds: [], pinnedSessionIds: [], workspaceIds: ["ws-1"] },
    tables: { workspaces: { "ws-1": { path: "V:\\fake", title: "ws-1", sessionIds: [SID] } } },
  }));
  const { services, calls } = makeServices({
    sessionsRoot: f.sessionsRoot,
    workspacesJson: f.workspacesJson,
    persisted: [{ id: SID, cwd: f.cwd }],
    persistence: "stuck", // a stale index keeps reporting the session
    workspaces: [{ id: "ws-1", sessionIds: [SID] }],
  });

  const result = await eraseSession({ services, sessionsRoot: f.sessionsRoot, workspacesJson: f.workspacesJson, tmpdir: f.scratch }, SID);
  assert.equal(result.ok, false);
  assert.equal(result.code, "verification-failed");
  assert.equal(result.verification.sessionRecordPresent, true);
  assert.equal(calls.some((call) => call[0] === "detachSession"), false, "registry untouched");
  const raw = JSON.parse(await readFile(f.workspacesJson, "utf8"));
  assert.deepEqual(raw.tables.workspaces["ws-1"].sessionIds, [SID]);
});

test("repeated delete is idempotent and reports alreadyGone", async () => {
  const f = await fixture();
  await makeSessionDir(f.sessionsRoot, f.cwd, SID);
  await writeFile(f.workspacesJson, JSON.stringify({
    global: { archivedSessionIds: [], pinnedSessionIds: [], workspaceIds: ["ws-1"] },
    tables: { workspaces: { "ws-1": { path: "V:\\fake", title: "ws-1", sessionIds: [SID] } } },
  }));
  const { services, calls } = makeServices({
    sessionsRoot: f.sessionsRoot,
    workspacesJson: f.workspacesJson,
    persisted: [{ id: SID, cwd: f.cwd }],
    workspaces: [{ id: "ws-1", sessionIds: [SID] }],
  });

  const first = await eraseSession({ services, sessionsRoot: f.sessionsRoot, workspacesJson: f.workspacesJson, tmpdir: f.scratch }, SID);
  assert.equal(first.ok, true, JSON.stringify({ failures: first.failures, verification: first.verification }));
  const countAfterFirst = calls.length;
  const second = await eraseSession({ services, sessionsRoot: f.sessionsRoot, workspacesJson: f.workspacesJson, tmpdir: f.scratch }, SID);
  assert.equal(second.ok, true);
  assert.equal(second.alreadyGone, true);
  assert.equal(calls.length, countAfterFirst, "second delete performed no writes");
});

test("detach is unconditional and idempotent even when the getter filters the id", async () => {
  const f = await fixture();
  await makeSessionDir(f.sessionsRoot, f.cwd, SID);
  await writeFile(f.workspacesJson, JSON.stringify({
    global: { archivedSessionIds: [], pinnedSessionIds: [], workspaceIds: ["ws-1"] },
    tables: { workspaces: { "ws-1": { path: "V:\\fake", title: "ws-1", sessionIds: [SID] } } },
  }));
  const { services, calls } = makeServices({
    sessionsRoot: f.sessionsRoot,
    workspacesJson: f.workspacesJson,
    persisted: [{ id: SID, cwd: f.cwd }],
    workspaces: [{ id: "ws-1", sessionIds: [SID] }],
    hideFiltered: true, // the entity's filtered getter reports nothing
  });

  const result = await eraseSession({ services, sessionsRoot: f.sessionsRoot, workspacesJson: f.workspacesJson, tmpdir: f.scratch }, SID);
  assert.equal(result.ok, true, JSON.stringify({ failures: result.failures, verification: result.verification }));
  assert.ok(calls.some((call) => call[0] === "detachSession" && call[1] === "ws-1"), "detach ran regardless of the getter");
});

test("a failing stop seam aborts before any deletion", async () => {
  const f = await fixture();
  const targetDir = await makeSessionDir(f.sessionsRoot, f.cwd, SID);
  const { services } = makeServices({
    sessionsRoot: f.sessionsRoot,
    workspacesJson: f.workspacesJson,
    persisted: [{ id: SID, cwd: f.cwd }],
    stop: "throw",
  });
  const result = await eraseSession({ services, sessionsRoot: f.sessionsRoot, workspacesJson: f.workspacesJson, tmpdir: f.scratch }, SID);
  assert.equal(result.ok, false);
  assert.equal(result.code, "stop-failed");
  assert.equal(await exists(join(targetDir, "session.v4.jsonl")), true);
});

test("a missing projection-cache domain fails closed before any deletion", async () => {
  const f = await fixture();
  const targetDir = await makeSessionDir(f.sessionsRoot, f.cwd, SID);
  const { services, calls } = makeServices({
    sessionsRoot: f.sessionsRoot,
    workspacesJson: f.workspacesJson,
    persisted: [{ id: SID, cwd: f.cwd }],
    workspaces: [{ id: "ws-1", sessionIds: [SID] }],
    projcacheDomain: "missing",
  });

  const result = await eraseSession({ services, sessionsRoot: f.sessionsRoot, workspacesJson: f.workspacesJson, tmpdir: f.scratch }, SID);

  assert.equal(result.ok, false);
  assert.equal(result.code, "projection-cache-unavailable");
  assert.equal(result.alreadyGone, undefined);
  assert.equal(await exists(join(targetDir, "session.v4.jsonl")), true, "no file was deleted");
  assert.equal(calls.some((call) => call[0] === "stopSession"), false, "no stop side effects");
  assert.equal(calls.some((call) => call[0] === "detachSession"), false, "registry untouched");
});

test("an unreadable projection-cache table fails closed", async () => {
  const f = await fixture();
  const targetDir = await makeSessionDir(f.sessionsRoot, f.cwd, SID);
  const { services } = makeServices({
    sessionsRoot: f.sessionsRoot,
    workspacesJson: f.workspacesJson,
    persisted: [{ id: SID, cwd: f.cwd }],
    workspaces: [{ id: "ws-1", sessionIds: [SID] }],
    projcacheThrow: true,
  });

  const result = await eraseSession({ services, sessionsRoot: f.sessionsRoot, workspacesJson: f.workspacesJson, tmpdir: f.scratch }, SID);

  assert.equal(result.ok, false);
  assert.equal(result.code, "projection-cache-unavailable");
  assert.match(result.error, /projection cache table unavailable/);
  assert.equal(await exists(join(targetDir, "session.v4.jsonl")), true);
});

test("an unreadable schedule table fails closed", async () => {
  const f = await fixture();
  const targetDir = await makeSessionDir(f.sessionsRoot, f.cwd, SID);
  const { services } = makeServices({
    sessionsRoot: f.sessionsRoot,
    workspacesJson: f.workspacesJson,
    persisted: [{ id: SID, cwd: f.cwd }],
    workspaces: [{ id: "ws-1", sessionIds: [SID] }],
    scheduleThrow: true,
  });

  const result = await eraseSession({ services, sessionsRoot: f.sessionsRoot, workspacesJson: f.workspacesJson, tmpdir: f.scratch }, SID);

  assert.equal(result.ok, false);
  assert.equal(result.code, "schedule-unavailable");
  assert.match(result.error, /schedule table unavailable/);
  assert.equal(await exists(join(targetDir, "session.v4.jsonl")), true);
});

test("a deployment without the schedule domain is not an error", async () => {
  const f = await fixture();
  await makeSessionDir(f.sessionsRoot, f.cwd, SID);
  await writeFile(f.workspacesJson, JSON.stringify({
    global: { archivedSessionIds: [], pinnedSessionIds: [], workspaceIds: ["ws-1"] },
    tables: { workspaces: { "ws-1": { path: "V:\\fake", title: "ws-1", sessionIds: [SID] } } },
  }));
  const { services } = makeServices({
    sessionsRoot: f.sessionsRoot,
    workspacesJson: f.workspacesJson,
    persisted: [{ id: SID, cwd: f.cwd }],
    workspaces: [{ id: "ws-1", sessionIds: [SID] }],
    scheduleDomain: "missing",
  });

  const result = await eraseSession({ services, sessionsRoot: f.sessionsRoot, workspacesJson: f.workspacesJson, tmpdir: f.scratch }, SID);
  assert.equal(result.ok, true, JSON.stringify({ failures: result.failures, verification: result.verification }));
  assert.equal(result.removed.scheduleTasks, 0);
});

test("an unknown id with no leftovers reports alreadyGone", async () => {
  const f = await fixture();
  const { services, calls } = makeServices({ sessionsRoot: f.sessionsRoot, workspacesJson: f.workspacesJson, persisted: [] });
  const result = await eraseSession({ services, sessionsRoot: f.sessionsRoot, workspacesJson: f.workspacesJson, tmpdir: f.scratch }, SID);
  assert.equal(result.ok, true);
  assert.equal(result.alreadyGone, true);
  assert.equal(calls.length, 0);
});

test("verification reports each remaining location", async () => {
  const f = await fixture();
  await makeSessionDir(f.sessionsRoot, f.cwd, SID);
  await writeFile(f.workspacesJson, JSON.stringify({
    global: { archivedSessionIds: [SID], pinnedSessionIds: [], workspaceIds: ["ws-1"] },
    tables: { workspaces: { "ws-1": { path: "V:\\fake", title: "ws-1", sessionIds: [SID] } } },
  }));
  const { services } = makeServices({
    sessionsRoot: f.sessionsRoot,
    workspacesJson: f.workspacesJson,
    persisted: [{ id: SID, cwd: f.cwd }],
    projcache: [[SID, { title: "x" }]],
    schedule: [["t", { sessionId: SID }]],
    workspaces: [{ id: "ws-1", sessionIds: [SID] }],
    archived: [SID],
  });

  const verification = await verifyErased({ services, sessionsRoot: f.sessionsRoot, workspacesJson: f.workspacesJson }, SID);
  assert.equal(verification.allClear, false);
  assert.equal(verification.sessionRecordPresent, true);
  assert.equal(verification.projectionCachePresent, true);
  assert.equal(verification.scheduleTasksRemaining, 1);
  assert.deepEqual(verification.workspaceState.workspaceIds, ["ws-1"]);
  assert.equal(verification.workspaceState.archived, true);
});
