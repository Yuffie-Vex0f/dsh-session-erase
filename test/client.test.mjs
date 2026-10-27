/**
 * Wiring tests for the browser half. The bundle is loaded through a fake
 * `window.__ModuleLoader__` and exercised against a minimal DOM stub, so the
 * click 鈫?dialog 鈫?confirm 鈫?request chain is verified without a browser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

/* 鈹€鈹€ minimal DOM 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */

class FakeElement {}

function createNode(tag) {
  const node = new FakeElement();
  node.tagName = tag;
  node.children = [];
  node.parent = null;
  node.style = { cssText: "" };
  node.dataset = {};
  node.attributes = {};
  node.listeners = {};
  node.disabled = false;
  node.textContent = "";
  node.setAttribute = (key, value) => {
    node.attributes[key] = value;
  };
  node.append = (...kids) => {
    for (const kid of kids) {
      kid.parent = node;
      node.children.push(kid);
    }
  };
  node.appendChild = node.append;
  node.remove = () => {
    if (node.parent === null) return;
    node.parent.children = node.parent.children.filter((child) => child !== node);
    node.parent = null;
  };
  node.contains = (other) => {
    let current = other;
    while (current !== null) {
      if (current === node) return true;
      current = current.parent;
    }
    return false;
  };
  node.addEventListener = (type, listener) => {
    (node.listeners[type] ??= []).push(listener);
  };
  node.removeEventListener = (type, listener) => {
    node.listeners[type] = (node.listeners[type] ?? []).filter((entry) => entry !== listener);
  };
  node.dispatch = (type, event) => {
    for (const listener of node.listeners[type] ?? []) listener(event);
  };
  return node;
}

function createDocument() {
  const doc = {
    baseURI: "http://127.0.0.1:53320/",
    documentListeners: {},
    createElement: (tag) => createNode(tag),
    createElementNS: (_namespace, tag) => createNode(tag),
    querySelector(selector) {
      const key = selector.includes("data-session-erase-dialog")
        ? "sessionEraseDialog"
        : selector.includes("data-session-erase-menu")
          ? "sessionEraseMenu"
          : null;
      if (key === null) return null;
      const stack = [doc.body];
      while (stack.length > 0) {
        const node = stack.pop();
        if (node.dataset !== undefined && node.dataset[key] !== undefined) return node;
        for (const child of node.children ?? []) stack.push(child);
      }
      return null;
    },
    addEventListener(type, listener) {
      (doc.documentListeners[type] ??= []).push(listener);
    },
    removeEventListener(type, listener) {
      doc.documentListeners[type] = (doc.documentListeners[type] ?? []).filter((entry) => entry !== listener);
    },
  };
  doc.body = createNode("body");
  return doc;
}

/* 鈹€鈹€ module loading 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */

const documentStub = createDocument();
globalThis.document = documentStub;
globalThis.window = {
  document: documentStub,
  innerWidth: 1280,
  innerHeight: 800,
};
globalThis.Element = FakeElement;

let capturedEntry;
globalThis.window.__ModuleLoader__ = {
  load(entry) {
    capturedEntry = entry;
  },
};

const reactStub = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
};
const requireStub = (name) => {
  if (name === "react") return reactStub;
  if (name === "@deepseek-ai/dsh-client-ui-primitives") return {};
  throw new Error(`unexpected require: ${name}`);
};

await import("../lib/client.js");
const clientModule = capturedEntry.factory(requireStub);
const { openEraseConfirm, eraseViaHost, clearSessionDrafts, findSessionIdFromTarget, PermanentDeleteMenuItem } =
  clientModule.__test;

const t = (key, vars = {}) => key + (vars.title !== undefined ? `:${vars.title}` : "") + (vars.id !== undefined ? `:${vars.id}` : "");

/* 鈹€鈹€ tests 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */

test("dialog renders title, description and session id", () => {
  const doc = createDocument();
  const overlay = openEraseConfirm({
    ctx: { get: () => undefined },
    doc,
    sessionId: "session-11111111-2222-3333-4444-555555555555",
    displayTitle: "My session",
    t,
  });
  assert.equal(doc.body.children.length, 1);
  const text = JSON.stringify(overlay.children[0].children.map((child) => child.textContent));
  assert.match(text, /confirm\.title/);
  assert.match(text, /My session/);
  assert.match(text, /session-11111111-2222-3333-4444-555555555555/);
  overlay.remove();
});

test("cancel closes the dialog", () => {
  const doc = createDocument();
  const overlay = openEraseConfirm({ ctx: { get: () => undefined }, doc, sessionId: "session-11111111-2222-3333-4444-555555555555", t });
  const footer = overlay.children[0].children.at(-1);
  const cancel = footer.children[0];
  cancel.dispatch("click", {});
  assert.equal(doc.body.children.length, 0);
  assert.equal(doc.querySelector("[data-session-erase-dialog]"), null);
});

test("opening twice replaces the previous dialog", () => {
  const doc = createDocument();
  const first = openEraseConfirm({ ctx: { get: () => undefined }, doc, sessionId: "session-11111111-2222-3333-4444-555555555555", t });
  openEraseConfirm({ ctx: { get: () => undefined }, doc, sessionId: "session-11111111-2222-3333-4444-555555555555", t });
  assert.equal(doc.body.children.length, 1);
  assert.equal(first.parent, null);
});

test("confirm click posts to /api/session-erase and reports success", async () => {
  const doc = createDocument();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ ok: true, alreadyGone: false }) };
  };
  const refreshed = [];
  const ctx = { get: (name) => (name === "sessions" ? { refresh: async () => refreshed.push(true) } : undefined) };
  const overlay = openEraseConfirm({ ctx, doc, sessionId: "session-11111111-2222-3333-4444-555555555555", t });
  const footer = overlay.children[0].children.at(-1);
  const confirm = footer.children[1];
  confirm.dispatch("click", {});
  assert.equal(confirm.disabled, true, "confirm is disabled while busy");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:53320/api/session-erase");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { sessionId: "session-11111111-2222-3333-4444-555555555555" });
  const status = overlay.children[0].children.at(-2);
  assert.match(status.textContent, /confirm\.done/);
  assert.equal(refreshed.length, 1, "the session list is refreshed after success");
  overlay.remove();
});

test("failed request shows the error and re-enables retry", async () => {
  const doc = createDocument();
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ ok: false, error: { message: "EPERM: directory is locked" } }),
  });
  const overlay = openEraseConfirm({
    ctx: { get: () => undefined },
    doc,
    sessionId: "session-11111111-2222-3333-4444-555555555555",
    t,
  });
  const footer = overlay.children[0].children.at(-1);
  const confirm = footer.children[1];
  confirm.dispatch("click", {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  const status = overlay.children[0].children.at(-2);
  assert.match(status.textContent, /EPERM: directory is locked/);
  assert.equal(confirm.disabled, false);
  assert.match(confirm.textContent, /confirm\.retry/);
  overlay.remove();
});

test("empty session id throws instead of rendering a dead dialog", () => {
  assert.throws(() => openEraseConfirm({ ctx: { get: () => undefined }, doc: createDocument(), sessionId: "", t }));
});

test("menu item click forwards the session id without needing the slot hooks to do more", () => {
  const seen = [];
  const closed = [];
  const element = PermanentDeleteMenuItem({
    sessionId: "session-11111111-2222-3333-4444-555555555555",
    displayTitle: "Row title",
    useMenuOpenState: () => [true, (value) => closed.push(value)],
    requestErase: (sessionId, title) => seen.push({ sessionId, title }),
    t,
  });
  assert.deepEqual(closed, [], "render does not close the menu");
  element.props.onClick();
  assert.deepEqual(closed, [false]);
  assert.deepEqual(seen, [{ sessionId: "session-11111111-2222-3333-4444-555555555555", title: "Row title" }]);
});

test("drafts for the target session are cleared and nothing else is touched", () => {
  const store = new Map([
    ["dsh.conversation.session-11111111-2222-3333-4444-555555555555", "{}"],
    ["dsh.conversation.session-99999999-8888-7777-6666-555555555555", "{}"],
    ["dsh.sessions.current", "{}"],
  ]);
  globalThis.localStorage = {
    get length() {
      return store.size;
    },
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => store.delete(key),
    setItem: (key, value) => store.set(key, value),
  };
  const removed = clearSessionDrafts("session-11111111-2222-3333-4444-555555555555");
  assert.equal(removed, 1);
  assert.equal(store.has("dsh.conversation.session-11111111-2222-3333-4444-555555555555"), false);
  assert.equal(store.has("dsh.conversation.session-99999999-8888-7777-6666-555555555555"), true);
  assert.equal(store.has("dsh.sessions.current"), true);
});

test("fiber walk resolves the session id from a row node", () => {
  const element = new FakeElement();
  element.parentElement = null;
  const sessionId = "session-11111111-2222-3333-4444-555555555555";
  const fiberKey = "__reactFiber$test";
  element[fiberKey] = {
    memoizedProps: { node: { id: sessionId } },
    return: null,
  };
  assert.equal(findSessionIdFromTarget(element), sessionId);
  const plain = new FakeElement();
  plain.parentElement = null;
  assert.equal(findSessionIdFromTarget(plain), undefined);
});

test("eraseViaHost rejects with the host message", async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: { message: "boom" } }) });
  await assert.rejects(eraseViaHost({ get: () => undefined }, "session-11111111-2222-3333-4444-555555555555"), /boom/);
});

test("native dialog is selected only when every official primitive exists", () => {
  const { canUseNativeDialog } = clientModule.__test;
  assert.equal(canUseNativeDialog(undefined, () => {}), false);
  assert.equal(canUseNativeDialog({}, () => {}), false);
  assert.equal(canUseNativeDialog({ Modal: () => null }, () => {}), false);
  assert.equal(canUseNativeDialog({ Modal: () => null, Button: () => null }, undefined), false);
  assert.equal(canUseNativeDialog({ Modal: () => null, Button: () => null }, () => {}), true);
});

test("native dialog mounts through the official primitives", () => {
  const { openNativeConfirm } = clientModule.__test;
  const doc = createDocument();
  const rendered = [];
  const roots = [];
  const createRoot = (host) => {
    roots.push(host);
    return { render: (element) => rendered.push(element), unmount: () => {} };
  };
  const ui = { Modal: () => null, Button: () => null };
  const host = openNativeConfirm({
    ctx: { get: () => undefined },
    doc,
    sessionId: "session-11111111-2222-3333-4444-555555555555",
    displayTitle: "Row title",
    t,
    ui,
    createRoot,
  });
  assert.equal(doc.body.children.length, 2, "danger style + dialog host");
  assert.ok(host.dataset.sessionEraseRoot !== undefined);
  const style = doc.body.children[0];
  assert.match(style.textContent, /--dsw-alias-state-error-primary/);
  assert.equal(roots.length, 1);
  assert.equal(roots[0], host);
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].props.sessionId, "session-11111111-2222-3333-4444-555555555555");
  assert.equal(rendered[0].props.displayTitle, "Row title");
});

test("native dialog rejects an empty session id", () => {
  const { openNativeConfirm } = clientModule.__test;
  assert.throws(() =>
    openNativeConfirm({ ctx: { get: () => undefined }, doc: createDocument(), sessionId: "", t, ui: {}, createRoot: () => ({}) }),
  );
});

test("fallback dialog uses only theme tokens, never hardcoded surface colors", () => {
  const doc = createDocument();
  const overlay = openEraseConfirm({
    ctx: { get: () => undefined },
    doc,
    sessionId: "session-11111111-2222-3333-4444-555555555555",
    t,
  });
  const card = overlay.children[0];
  assert.match(card.style.cssText, /--dsw-alias-bg-layer-1/);
  assert.match(card.style.cssText, /--dsw-alias-label-primary/);
  assert.match(card.style.cssText, /--dsw-alias-border-l2/);
  assert.doesNotMatch(card.style.cssText, /#20242c|#e8eaed/);
  const footer = card.children.at(-1);
  const [cancel, confirm] = footer.children;
  assert.match(cancel.style.cssText, /--dsw-alias-label-primary/);
  assert.match(confirm.style.cssText, /--dsw-alias-state-error-primary/);
  assert.match(confirm.style.cssText, /background:transparent/);
  overlay.remove();
});

test("dialog typography keeps text readable and spacing even", () => {
  const doc = createDocument();
  const overlay = openEraseConfirm({
    ctx: { get: () => undefined },
    doc,
    sessionId: "session-11111111-2222-3333-4444-555555555555",
    t,
  });
  const card = overlay.children[0];
  const [title, desc, idLine, warning] = card.children;
  assert.match(card.style.cssText, /font-size:14px/);
  assert.match(card.style.cssText, /line-height:1\.5/);
  assert.match(title.style.cssText, /font-size:15px/);
  assert.match(title.style.cssText, /letter-spacing:0\.2px/);
  assert.match(title.style.cssText, /margin-bottom:12px/);
  assert.match(desc.style.cssText, /font-size:14px/);
  assert.match(desc.style.cssText, /letter-spacing:0\.2px/);
  assert.match(desc.style.cssText, /line-height:1\.5/);
  assert.match(idLine.style.cssText, /font-size:13px/);
  assert.match(idLine.style.cssText, /overflow-wrap:anywhere/);
  assert.match(warning.style.cssText, /font-size:13px/);
  assert.match(warning.style.cssText, /line-height:1\.55/);
  assert.match(warning.style.cssText, /letter-spacing:0\.3px/);
  assert.match(warning.style.cssText, /margin-top:12px/);
  overlay.remove();
});

test("right-click menu has a single permanent action, trash icon and themed surface", () => {
  const { showContextMenu } = clientModule.__test;
  const doc = createDocument();
  const seen = [];
  const ctx = {
    get: (name) => (name === "sessions" ? { list: { getSnapshot: () => ({ byId: {} }) } } : undefined),
  };
  const menu = showContextMenu(ctx, doc, "session-11111111-2222-3333-4444-555555555555", (sessionId) => seen.push(sessionId));

  assert.equal(menu.children.length, 1, "only the permanent action is offered");
  const item = menu.children[0];
  assert.equal(item.children[0].tagName, "svg", "the trash icon leads the row");
  assert.match(menu.style.cssText, /--dsw-specific-menu/);
  assert.match(menu.style.cssText, /--dsw-alias-border-l2/);
  assert.doesNotMatch(menu.style.cssText, /--dsw-alias-bg-elevated|#20242c|#e8eaed/);
  assert.match(item.style.cssText, /--dsw-alias-state-error-primary/);

  item.dispatch("mouseenter", {});
  assert.match(String(item.style.background), /--dsw-alias-interactive-bg-hover/);
  item.dispatch("mouseleave", {});
  assert.equal(item.style.background, "transparent");

  item.dispatch("click", { stopPropagation() {} });
  assert.deepEqual(seen, ["session-11111111-2222-3333-4444-555555555555"]);
  assert.equal(doc.body.children.length, 0, "the menu closes after the action");
});
