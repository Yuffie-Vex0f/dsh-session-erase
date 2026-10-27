/**
 * Host half of `@dsh-local/session-erase`.
 *
 * Registers one authenticated Web route, `POST /api/session-erase`, that runs
 * the erasure engine against the live host services. The route is reached by
 * the browser through the Connection carrier's fetch adapter, so the same
 * cookie authentication as every other API call applies.
 *
 * The engine refuses a Session that is still live; the browser must leave the
 * conversation first. The host re-checks the live registry at delete time, so
 * "is it released?" is a state check, never a timeout guess.
 */
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { eraseSession } from "./erase.js";
import { defaultSessionsRoot, validateSessionId } from "./paths.js";

/** Cordis plugin name. */
export const name = "session-erase";

/** The route needs the Connection service; everything else resolves lazily. */
export const inject = ["connection"];

/** Absolute route the Host registers (the browser addresses it document-relative). */
export const ERASE_ROUTE = "/api/session-erase";

/** Codes that map to a non-500 status. */
const STATUS_BY_CODE = {
  "session-live": 409,
  "persistence-unavailable": 503,
  "workspace-registry-unavailable": 503,
  "storage-domain-unavailable": 503,
  "stop-unavailable": 503,
  "sessions-unavailable": 503,
  "release-unavailable": 503,
  "sessions-root-unreadable": 503,
  "persistence-list-failed": 503,
  "workspace-state-unreadable": 503,
  "projection-cache-unavailable": 503,
  "schedule-unavailable": 503,
  "flush-failed": 500,
  "release-failed": 500,
  "release-timeout": 500,
  "cache-write-timeout": 500,
};

/**
 * Register the erasure route on the Connection carrier.
 * @param {object} ctx - host context.
 * @param {{sessionsRoot?: string, workspacesJson?: string}} [config] - loader-provided configuration.
 */
export function apply(ctx, config = {}) {
  const sessionsRoot = resolveSessionsRoot(ctx, config);
  const workspacesJson = resolveWorkspacesJson(sessionsRoot, config);
  ctx.logger?.info?.(`session-erase: erasure route ${ERASE_ROUTE} ready (sessions root: ${sessionsRoot})`);

  const handler = async (request) => {
    let payload;
    try {
      payload = await request.json();
    } catch {
      return json(400, { ok: false, code: "bad-request", error: { code: "bad-request", message: "request body must be JSON" } });
    }
    let sessionId;
    try {
      sessionId = validateSessionId(payload?.sessionId);
    } catch (error) {
      return json(400, {
        ok: false,
        code: "invalid-session-id",
        error: { code: "invalid-session-id", message: error instanceof Error ? error.message : String(error) },
      });
    }
    try {
      const result = await eraseSession(
        {
          services: {
            sessions: ctx.get("sessions"),
            sessionPersistence: ctx.get("sessionPersistence"),
            workspaceRegistry: ctx.get("workspaceRegistry"),
            storageDomain: ctx.get("storageDomain"),
            stopSession: (id) => ctx.parallel("workspace/session-stop", { sessionId: id }),
          },
          // Subscribe through the host event bus so the release step cannot
          // miss `session/disposed` or the projection-cache detach checkpoint.
          onEvent: (event, listener) => ctx.on(event, listener),
          sessionsRoot,
          workspacesJson,
          tmpdir: tmpdir(),
        },
        sessionId,
      );
      if (!result.ok) {
        ctx.logger?.warn?.(
          `session-erase: "${sessionId}" refused/failed (${result.code ?? "error"}): ${String(result.error ?? "")}${
            result.failures?.length > 0
              ? `; failures: ${result.failures.map((failure) => `${failure.step}=${failure.message}`).join("; ")}`
              : ""
          }`,
        );
      }
      const status = result.ok ? 200 : STATUS_BY_CODE[result.code] ?? 500;
      return json(status, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger?.warn?.(`session-erase: "${sessionId}" threw: ${message}`);
      return json(500, { ok: false, code: "erase-failed", sessionId, error: { code: "erase-failed", message } });
    }
  };

  ctx.effect(() => {
    const dispose = ctx.connection.fetch.register({
      path: ERASE_ROUTE,
      methods: ["POST"],
      requestBody: "buffered",
      fetch: handler,
    });
    return typeof dispose === "function" ? dispose : undefined;
  }, "session-erase: erasure route");
}

/**
 * The sessions root the engine scans. Prefers loader config, then the
 * persistence service's own root, then `$DSH_HOME/sessions`.
 * @param {object} ctx - host context.
 * @param {{sessionsRoot?: string}} config - loader configuration.
 * @returns {string} absolute sessions root.
 */
function resolveSessionsRoot(ctx, config) {
  if (typeof config?.sessionsRoot === "string" && config.sessionsRoot.length > 0) {
    return resolve(config.sessionsRoot);
  }
  const fromService = ctx.get("sessionPersistence")?.root;
  if (typeof fromService === "string" && fromService.length > 0) return resolve(fromService);
  return resolve(defaultSessionsRoot(process.env, homedir()));
}

/**
 * The persisted workspace registry the engine verifies against.
 * @param {string} sessionsRoot - configured sessions root.
 * @param {{workspacesJson?: string}} config - loader configuration.
 * @returns {string} absolute workspace.json path.
 */
function resolveWorkspacesJson(sessionsRoot, config) {
  if (typeof config?.workspacesJson === "string" && config.workspacesJson.length > 0) {
    return resolve(config.workspacesJson);
  }
  return join(dirname(sessionsRoot), "storages", "workspace.json");
}

/**
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON-serializable payload.
 * @returns {Response} the JSON response.
 */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
