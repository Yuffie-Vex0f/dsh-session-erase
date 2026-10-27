/**
 * Path encoding shared by the erase engine, the verify tool and the tests.
 *
 * The two builders are reimplementations of the exact, documented encodings
 * used by `@deepseek-ai/dsh-session-persistence-jsonl` (projectKey /
 * encodeSegment) — they are the only way to derive a Session directory from a
 * Session id without trusting the id as a path segment.
 */
import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";

/**
 * Encode one untrusted path segment: safe code units stay literal, `~` and
 * everything else becomes `~XXXX`; the tokens `.` and `..` are escaped so the
 * result can never traverse. Mirrors the persistence package verbatim.
 * @param {string} raw - untrusted text.
 * @returns {string} one filesystem-safe segment.
 */
export function encodeSegment(raw) {
  if (typeof raw !== "string") throw new TypeError("encodeSegment: expected a string");
  if (raw.length === 0) throw new Error("encodeSegment: cannot encode an empty path segment");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

/**
 * Build the readable project directory key for a Session cwd. Filesystem and
 * drive separators collapse to one `-`; unsafe code units use the same
 * `~XXXX` escape; the result is wrapped in `--…--` and bounded. Mirrors the
 * persistence package verbatim.
 * @param {string} cwd - the Session's project directory.
 * @returns {string} one filesystem-safe project directory name.
 */
export function projectKey(cwd) {
  if (typeof cwd !== "string") throw new TypeError("projectKey: expected a string");
  if (cwd.length === 0) throw new Error("projectKey: cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/**
 * The Session directory beneath its project directory.
 * @param {string} sessionsRoot - persistence root.
 * @param {string|undefined} cwd - the Session's project directory.
 * @param {string} id - the Session id.
 * @returns {string} session directory path.
 */
export function sessionDirOf(sessionsRoot, cwd, id) {
  const project = cwd === undefined ? "_no-cwd" : projectKey(cwd);
  return resolve(sessionsRoot, project, encodeSegment(id));
}

/**
 * The spill directory name for one Session: `session-` plus the first 12 hex
 * characters of sha256(sessionId). Mirrors @deepseek-ai/dsh-spill-local.
 * @param {string} id - the Session id.
 * @returns {string} the child directory name under a spill root.
 */
export function spillSessionDirName(id) {
  return "session-" + createHash("sha256").update(id).digest("hex").slice(0, 12);
}

/**
 * Assert `target` resolves strictly inside `root` (or equals it) and return
 * the resolved path. This is the single guard every filesystem deletion goes
 * through.
 * @param {string} root - authoritative base directory.
 * @param {string} target - candidate path derived from encoded input.
 * @returns {string} the resolved target.
 */
export function assertInside(root, target) {
  const base = resolve(root);
  const resolvedTarget = resolve(target);
  if (resolvedTarget !== base && !resolvedTarget.startsWith(base + sep)) {
    throw new Error(`session-erase: refusing path outside ${JSON.stringify(base)}: ${JSON.stringify(resolvedTarget)}`);
  }
  return resolvedTarget;
}

/**
 * Split a path into safe parent + final component. Used to prove that the
 * delete target's immediate parent is the expected root before `rm -rf`.
 * @param {string} path - absolute path.
 * @returns {{parent: string, name: string}} parent and final component.
 */
export function splitParent(path) {
  const resolvedPath = resolve(path);
  const at = Math.max(resolvedPath.lastIndexOf(sep), resolvedPath.lastIndexOf("/"));
  if (at <= 0 || at === resolvedPath.length - 1) {
    throw new Error(`session-erase: refusing to split a root path ${JSON.stringify(resolvedPath)}`);
  }
  return { parent: resolvedPath.slice(0, at), name: resolvedPath.slice(at + 1) };
}

/**
 * The single accepted Session id shape: the literal `session-` prefix followed
 * by characters that can never be a separator, `~`, or a dot-dot token.
 * @param {unknown} value - untrusted id.
 * @returns {string} the validated id.
 */
export function validateSessionId(value) {
  if (typeof value !== "string") throw new TypeError("session id must be a string");
  if (!/^session-[A-Za-z0-9-]{8,120}$/.test(value)) {
    throw new Error(`invalid session id: ${JSON.stringify(value).slice(0, 80)}`);
  }
  return value;
}

/**
 * Default persistence root when the loader-provided config is absent.
 * @param {Record<string, string>} env - process environment (injectable for tests).
 * @param {string} home - user home directory.
 * @returns {string} the sessions root.
 */
export function defaultSessionsRoot(env, home) {
  const homeDir = typeof env?.DSH_HOME === "string" && env.DSH_HOME.length > 0 ? env.DSH_HOME : home;
  return resolve(homeDir, "sessions");
}
