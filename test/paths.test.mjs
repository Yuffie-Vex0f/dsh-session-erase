import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeSegment,
  projectKey,
  sessionDirOf,
  spillSessionDirName,
  validateSessionId,
  assertInside,
  splitParent,
} from "../lib/paths.js";

test("encodeSegment matches the persistence package encodings", () => {
  assert.equal(encodeSegment("session-01234567-89ab-cdef-0123-456789abcdef"), "session-01234567-89ab-cdef-0123-456789abcdef");
  assert.equal(encodeSegment("."), "~002E");
  assert.equal(encodeSegment(".."), "~002E~002E");
  assert.equal(encodeSegment("a/b"), "a~002Fb");
  assert.equal(encodeSegment("a\\b"), "a~005Cb");
  assert.equal(encodeSegment("a~b"), "a~007Eb");
  assert.equal(encodeSegment("a b"), "a~0020b");
});

test("projectKey reproduces the on-disk project directory naming", () => {
  // Drive letters and separator runs collapse to one dash; unsafe units escape.
  assert.equal(projectKey("D:\\work\\demo-app"), "--D-work-demo-app--");
  assert.equal(projectKey("C:\\Users\\example\\Documents\\my-workspace"),
    "--C-Users-example-Documents-my-workspace--");
  // Separator runs collapse; leading dashes are trimmed.
  assert.equal(projectKey("//server/share"), "--server-share--");
  assert.equal(projectKey("C:/a//b"), "--C-a-b--");
});

test("sessionDirOf joins projectKey and encodeSegment", () => {
  const dir = sessionDirOf("C:\\home\\.dsh\\sessions", "D:\\work\\demo-app", "session-abc-123");
  assert.equal(dir, "C:\\home\\.dsh\\sessions\\--D-work-demo-app--\\session-abc-123");
});

test("spillSessionDirName mirrors dsh-spill-local", () => {
  const name = spillSessionDirName("session-01234567-89ab-cdef-0123-456789abcdef");
  assert.match(name, /^session-[0-9a-f]{12}$/);
  assert.equal(name, spillSessionDirName("session-01234567-89ab-cdef-0123-456789abcdef"));
  assert.notEqual(name, spillSessionDirName("session-other"));
});

test("validateSessionId rejects traversal and malformed ids", () => {
  assert.equal(validateSessionId("session-01234567-89ab-cdef-0123-456789abcdef"),
    "session-01234567-89ab-cdef-0123-456789abcdef");
  assert.throws(() => validateSessionId("session-../../evil"));
  assert.throws(() => validateSessionId("session-a~002Fb"));
  assert.throws(() => validateSessionId("session-"));
  assert.throws(() => validateSessionId("other-12345678"));
  assert.throws(() => validateSessionId(""));
  assert.throws(() => validateSessionId(42));
  assert.throws(() => validateSessionId("session-a/b"));
});

test("assertInside refuses escapes and accepts descendants", () => {
  assert.throws(() => assertInside("C:\\root", "C:\\root\\..\\etc"));
  assert.throws(() => assertInside("C:\\root", "C:\\other\\x"));
  assert.equal(assertInside("C:\\root", "C:\\root\\a\\b"), "C:\\root\\a\\b");
  assert.equal(assertInside("C:\\root", "C:\\root"), "C:\\root");
});

test("splitParent separates the final component", () => {
  const { parent, name } = splitParent("C:\\root\\project\\session-x");
  assert.equal(parent, "C:\\root\\project");
  assert.equal(name, "session-x");
  assert.throws(() => splitParent("C:\\"));
});
