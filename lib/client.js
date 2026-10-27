/**
 * Browser half of `@dsh-local/session-erase`.
 *
 * Adds two Session menu entries — 删除会话 (the Host's ordinary archive) and
 * 彻底删除会话 (irreversible erasure) — to both the row's ⋯ menu (official
 * slot) and a right-click menu on Session rows.
 *
 * The confirmation dialog is deliberately self-contained plain DOM: it does not
 * depend on the slot/hook machinery or on primitives, so a click always either
 * shows the dialog or shows a visible error banner. Every step logs a
 * `console.info`/`console.warn` line prefixed with `[session-erase]` for
 * diagnosis; nothing fails silently.
 */
window.__ModuleLoader__.load({
  id: "@dsh-local/session-erase",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const react = require("react");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    let reactDom;
    try {
      reactDom = require("react-dom/client");
    } catch {
      reactDom = undefined;
    }
    // `react-dom/client` may arrive as a namespace, a default export or the
    // createRoot function itself depending on the bundler shape.
    const createRoot =
      typeof reactDom === "function"
        ? reactDom
        : typeof reactDom?.createRoot === "function"
          ? reactDom.createRoot
          : reactDom?.default?.createRoot;

    const NS = "session-erase";
    const ERASE_ROUTE = "api/session-erase";
    const DRAFT_PREFIX = "dsh.conversation";

    const DICTIONARIES = {
      zh: {
        "menu.softDelete": "删除会话",
        "menu.permanentDelete": "彻底删除会话",
        "confirm.title": "彻底删除会话",
        "confirm.desc": "确定要彻底删除「{title}」吗？",
        "confirm.sessionId": "会话 ID：{id}",
        "confirm.warning": "该操作不可轻易恢复：将删除此会话的本地消息、历史记录、投影缓存与相关计划任务。",
        "confirm.action": "彻底删除",
        "confirm.cancel": "取消",
        "confirm.busy": "正在删除…",
        "confirm.done": "已彻底删除",
        "confirm.alreadyGone": "会话不存在（未删除任何数据）",
        "confirm.live": "会话仍处于活动状态，请先关闭该会话（离开对话）后重试。未删除任何数据。",
        "confirm.failed": "删除失败",
        "confirm.retry": "重试",
        "error.dialog": "无法打开确认框",
        "error.delete": "彻底删除失败",
      },
      en: {
        "menu.softDelete": "Delete session",
        "menu.permanentDelete": "Permanently delete session",
        "confirm.title": "Permanently delete session",
        "confirm.desc": "Permanently delete “{title}”?",
        "confirm.sessionId": "Session ID: {id}",
        "confirm.warning":
          "This cannot be undone easily: the local messages, history, projection cache and scheduled tasks of this session are removed.",
        "confirm.action": "Delete permanently",
        "confirm.cancel": "Cancel",
        "confirm.busy": "Deleting…",
        "confirm.done": "Permanently deleted",
        "confirm.alreadyGone": "The session does not exist (nothing was deleted)",
        "confirm.live": "The session is still active. Close it (leave the conversation) and retry. Nothing was deleted.",
        "confirm.failed": "Deletion failed",
        "confirm.retry": "Retry",
        "error.dialog": "Cannot open the confirmation dialog",
        "error.delete": "Permanent deletion failed",
      },
    };

    /* ── diagnostics ───────────────────────────────────────────────────── */

    function logInfo(message, detail) {
      try {
        console.info(`[session-erase] ${message}`, detail ?? "");
      } catch {
        /* console unavailable */
      }
    }

    function logWarn(message, detail) {
      try {
        console.warn(`[session-erase] ${message}`, detail ?? "");
      } catch {
        /* console unavailable */
      }
    }

    /** A visible, auto-dismissing banner so failures never look like "nothing happened". */
    function showBanner(doc, kind, message) {
      try {
        const banner = doc.createElement("div");
        banner.dataset.sessionEraseBanner = "";
        banner.setAttribute("role", "alert");
        banner.textContent = message;
        banner.style.cssText = BANNER_STYLE + (kind === "error" ? ERROR_COLOR_STYLE : OK_COLOR_STYLE);
        doc.body.appendChild(banner);
        setTimeout(() => banner.remove(), 8000);
      } catch (error) {
        logWarn("cannot render banner", error);
      }
    }

    /* ── DOM helpers ───────────────────────────────────────────────────── */

    function el(doc, tag, style, text) {
      const node = doc.createElement(tag);
      if (style !== undefined) node.style.cssText = style;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function button(doc, label, style) {
      const node = el(doc, "button", style, label);
      node.type = "button";
      return node;
    }

    /* ── host request ──────────────────────────────────────────────────── */

    /**
     * Ask the Host to erase one Session and resolve its structured result.
     * @param {object} ctx - client context.
     * @param {string} sessionId - the Session id.
     * @returns {Promise<object>} the Host result.
     */
    async function eraseViaHost(ctx, sessionId) {
      const url = new URL(ERASE_ROUTE, document.baseURI).toString();
      logInfo("POST", { url, sessionId });
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      if (!response.ok || payload?.ok !== true) {
        const message =
          payload?.error?.message ??
          payload?.error?.code ??
          payload?.verification?.listFailure ??
          `HTTP ${String(response.status)}`;
        const error = new Error(String(message));
        error.code = payload?.code;
        error.status = response.status;
        error.payload = payload;
        throw error;
      }
      void ctx.get("sessions")?.refresh?.();
      return payload;
    }

    /**
     * Bounded client-side wait for the host to release a just-left Session.
     * This is UX only: the host re-checks its live registry at delete time and
     * refuses with 409 when the Session is still live.
     * @returns {Promise<boolean>} whether the list reports no live agent.
     */
    async function waitForRelease(ctx, sessionId, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const summary = ctx.get("sessions")?.list?.getSnapshot?.()?.byId?.[sessionId];
        if (summary === undefined || summary.agentAvailable !== true) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    }

    /* ── leaving the open Session / drafts ─────────────────────────────── */

    function leaveIfOpen(ctx, sessionId) {
      const ui = ctx.get("uiWorkspace");
      if (ui?.mainReference?.sessionId !== sessionId) return;
      try {
        const snapshot = ctx.get("workspaces")?.list?.getSnapshot?.();
        const archived = new Set(snapshot?.archivedSessionIds ?? []);
        for (const item of snapshot?.items ?? []) {
          if (!Array.isArray(item.sessionIds) || !item.sessionIds.includes(sessionId)) continue;
          const other = item.sessionIds.find((id) => id !== sessionId && !archived.has(id));
          if (other !== undefined) {
            ui.openSession(other);
            return;
          }
        }
        ui.startSession();
      } catch (error) {
        logWarn("could not leave the open session first", error);
      }
    }

    function clearSessionDrafts(sessionId) {
      try {
        const keys = [];
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          if (key !== null && key.startsWith(DRAFT_PREFIX) && key.endsWith("." + sessionId)) keys.push(key);
        }
        for (const key of keys) localStorage.removeItem(key);
        return keys.length;
      } catch (error) {
        logWarn("could not clear drafts", error);
        return 0;
      }
    }

    function titleOf(ctx, sessionId) {
      try {
        const summary = ctx.get("sessions")?.list?.getSnapshot?.()?.byId?.[sessionId];
        const title = summary?.displayTitle;
        return typeof title === "string" && title.length > 0 ? title : sessionId;
      } catch {
        return sessionId;
      }
    }

    /* ── confirmation dialog (plain DOM, no slot/hook dependency) ───────── */

    /**
     * Open the irreversible-delete confirmation. Returns the overlay element.
     * @param {object} options - ctx, doc, sessionId, displayTitle, t.
     * @returns {HTMLElement} the overlay (already attached to the document body).
     */
    function openEraseConfirm({ ctx, doc, sessionId, displayTitle, t }) {
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new Error("session id is empty");
      }
      const existing = doc.querySelector("[data-session-erase-dialog]");
      if (existing !== null) existing.remove();

      const overlay = doc.createElement("div");
      overlay.dataset.sessionEraseDialog = "";
      overlay.style.cssText = BACKDROP_STYLE;
      const card = doc.createElement("div");
      card.setAttribute("role", "dialog");
      card.setAttribute("aria-modal", "true");
      card.setAttribute("aria-label", t("confirm.title"));
      card.style.cssText = CARD_STYLE;

      const title = el(doc, "div", CARD_TITLE_STYLE, t("confirm.title"));
      const desc = el(doc, "div", BODY_TEXT_STYLE, t("confirm.desc", { title: displayTitle || sessionId }));
      const idLine = el(doc, "div", MUTED_STYLE, t("confirm.sessionId", { id: sessionId }));
      const warning = el(doc, "div", WARNING_STYLE, t("confirm.warning"));
      const status = el(doc, "div", MUTED_STYLE, "");
      status.setAttribute("role", "status");
      const footer = el(doc, "div", FOOTER_STYLE, undefined);
      const cancel = button(doc, t("confirm.cancel"), OUTLINE_BUTTON_STYLE);
      const confirm = button(doc, t("confirm.action"), DANGER_BUTTON_STYLE);
      footer.append(cancel, confirm);
      card.append(title, desc, idLine, warning, status, footer);
      overlay.append(card);
      doc.body.appendChild(overlay);

      let busy = false;
      let settled = false;
      const onKey = (event) => {
        if (event.key === "Escape") close();
      };
      const close = () => {
        if (busy) return;
        doc.removeEventListener("keydown", onKey, true);
        overlay.remove();
      };
      doc.addEventListener("keydown", onKey, true);
      overlay.addEventListener("mousedown", (event) => {
        if (event.target === overlay) close();
      });
      cancel.addEventListener("click", close);
      confirm.addEventListener("click", () => {
        if (busy || settled) return;
        busy = true;
        confirm.disabled = true;
        cancel.disabled = true;
        status.textContent = t("confirm.busy");
        status.style.cssText = MUTED_STYLE;
        logInfo("confirm accepted", sessionId);
        (async () => {
          leaveIfOpen(ctx, sessionId);
          clearSessionDrafts(sessionId);
          // Bounded client wait so leaving can release the host Session; the
          // host still re-checks its live registry and refuses while it lives.
          await waitForRelease(ctx, sessionId);
          return eraseViaHost(ctx, sessionId);
        })()
          .then((payload) => {
            settled = true;
            busy = false;
            status.textContent = payload?.alreadyGone === true ? t("confirm.alreadyGone") : t("confirm.done");
            status.style.cssText = MUTED_STYLE + ";" + OK_COLOR_STYLE;
            logInfo("erase succeeded", { sessionId, alreadyGone: payload?.alreadyGone === true });
            setTimeout(() => {
              if (!doc.body.contains(overlay)) return;
              doc.removeEventListener("keydown", onKey, true);
              overlay.remove();
            }, 1400);
          })
          .catch((error) => {
            busy = false;
            confirm.disabled = false;
            cancel.disabled = false;
            confirm.textContent = t("confirm.retry");
            const message = error?.code === "session-live"
              ? t("confirm.live")
              : `${t("confirm.failed")}: ${error instanceof Error ? error.message : String(error)}`;
            status.textContent = message;
            status.style.cssText = MUTED_STYLE + ";" + ERROR_COLOR_STYLE;
            logWarn("erase request failed", error);
          });
      });
      return overlay;
    }

    /* ── native confirmation dialog (official Modal/Button) ─────────────── */

    // The exact rule the official archive/workspace confirm dialogs use for
    // their destructive action (`ui-workspace` module CSS, this version).
    const DANGER_STYLE = ".session-erase-danger:not(:disabled){color:var(--dsw-alias-state-error-primary)}";

    /** Inject the official danger-button rule once per document. */
    function ensureDangerStyle(doc) {
      if (typeof doc.querySelector === "function" && doc.querySelector("style[data-session-erase-style]") !== null) return;
      const style = doc.createElement("style");
      style.dataset.sessionEraseStyle = "";
      style.textContent = DANGER_STYLE;
      (doc.head ?? doc.body).appendChild(style);
    }

    /** Whether every official primitive this dialog needs is present at runtime. */
    function canUseNativeDialog(ui, createRoot) {
      return ui !== undefined && typeof ui.Modal === "function" && typeof ui.Button === "function" && typeof createRoot === "function";
    }

    /** Native dialog body: official Modal + Button with our state machine. */
    function NativeEraseForm({ ctx, sessionId, displayTitle, t, ui, onClose }) {
      const [phase, setPhase] = react.useState("idle");
      const [error, setError] = react.useState(null);
      const [outcome, setOutcome] = react.useState(null);
      const busy = phase === "busy";
      const confirm = () => {
        if (busy) return;
        setPhase("busy");
        setError(null);
        (async () => {
          leaveIfOpen(ctx, sessionId);
          clearSessionDrafts(sessionId);
          await waitForRelease(ctx, sessionId);
          return eraseViaHost(ctx, sessionId);
        })()
          .then((payload) => {
            setOutcome(payload);
            setPhase("done");
            setTimeout(onClose, 1400);
          })
          .catch((reason) => {
            setPhase("error");
            setError(reason?.code === "session-live" ? t("confirm.live") : (reason?.message ?? String(reason)));
          });
      };
      const footer = [
        react.createElement(ui.Button, {
          key: "cancel",
          variant: "outline",
          disabled: busy,
          onClick: () => {
            if (!busy) onClose();
          },
          children: t("confirm.cancel"),
        }),
        react.createElement(ui.Button, {
          key: "confirm",
          variant: "outline",
          className: "session-erase-danger",
          disabled: busy || phase === "done",
          onClick: confirm,
          children: phase === "error" ? t("confirm.retry") : t("confirm.action"),
        }),
      ];
      return react.createElement(
        ui.Modal,
        {
          open: true,
          onClose: () => {
            if (!busy) onClose();
          },
          closeLabel: t("confirm.close"),
          title: t("confirm.title"),
          description: t("confirm.desc", { title: displayTitle || sessionId }),
          footer,
        },
        [
          react.createElement("div", { key: "id", style: MUTED_STYLE }, t("confirm.sessionId", { id: sessionId })),
          react.createElement("div", { key: "warning", style: WARNING_STYLE }, t("confirm.warning")),
          busy && react.createElement("div", { key: "busy", role: "status", style: MUTED_STYLE }, t("confirm.busy")),
          phase === "done" &&
            react.createElement(
              "div",
              { key: "done", role: "status", style: OK_STYLE },
              outcome?.alreadyGone === true ? t("confirm.alreadyGone") : t("confirm.done"),
            ),
          phase === "error" &&
            react.createElement(
              "div",
              { key: "error", role: "alert", style: ERROR_STYLE },
              `${t("confirm.failed")}: ${error ?? ""}`,
            ),
        ],
      );
    }

    /** Mount the native dialog; returns the host element for bookkeeping. */
    function openNativeConfirm({ ctx, doc, sessionId, displayTitle, t, ui, createRoot }) {
      if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("session id is empty");
      ensureDangerStyle(doc);
      const host = doc.createElement("div");
      host.dataset.sessionEraseRoot = "";
      doc.body.appendChild(host);
      const root = createRoot(host);
      const close = () => {
        try {
          root.unmount();
        } catch {
          /* already unmounted */
        }
        host.remove();
      };
      root.render(react.createElement(NativeEraseForm, { ctx, sessionId, displayTitle, t, ui, onClose: close }));
      return host;
    }

    /* ── menu item components (official slot) ──────────────────────────── */

    function MenuButton({ label, onSelect, icon }) {
      const MenuItemButton = primitives?.MenuItemButton;
      if (typeof MenuItemButton === "function") {
        const props = { onSelect, children: label };
        if (icon !== undefined) props.icon = icon;
        return react.createElement(MenuItemButton, props);
      }
      return react.createElement("button", { type: "button", onClick: onSelect, style: MENU_ITEM_STYLE }, icon, label);
    }

    function PermanentDeleteMenuItem({ sessionId, displayTitle, useMenuOpenState, requestErase: open, t }) {
      const [, setMenuOpen] = useMenuOpenState();
      // Same icon the official menu entries use; only when this runtime exports it.
      const icon = typeof primitives?.IconTrashOutlineRegular === "function"
        ? react.createElement(primitives.IconTrashOutlineRegular, { size: 14 })
        : undefined;
      const onSelect = () => {
        logInfo("permanent delete selected", { sessionId, displayTitle });
        setMenuOpen(false);
        try {
          open(sessionId, displayTitle);
        } catch (error) {
          logWarn("dialog open failed", error);
          showBanner(window.document, "error", `${t("error.dialog")}: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      return MenuButton({ label: t("menu.permanentDelete"), onSelect, icon });
    }

    /* ── right-click menu ──────────────────────────────────────────────── */

    function findSessionIdFromTarget(target) {
      if (typeof Element === "undefined" || !(target instanceof Element)) return undefined;
      let element = target;
      let depth = 0;
      while (element !== null && depth < 40) {
        const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactFiber$"));
        if (key !== undefined) {
          let fiber = element[key];
          let hops = 0;
          while (fiber != null && hops < 40) {
            const node = fiber.memoizedProps?.node;
            if (node !== null && typeof node === "object" && typeof node.id === "string" && node.id.startsWith("session-")) {
              return node.id;
            }
            fiber = fiber.return;
            hops += 1;
          }
        }
        element = element.parentElement;
        depth += 1;
      }
      return undefined;
    }

    function translator(ctx) {
      const locale = ctx.get("locale");
      try {
        return locale.bind(NS);
      } catch (error) {
        logWarn("locale bind failed", error);
        return (key) => key;
      }
    }

    function showContextMenu(ctx, doc, sessionId, openConfirm) {
      closeContextMenu(doc);
      const t = translator(ctx);
      const menu = doc.createElement("div");
      menu.dataset.sessionEraseMenu = "";
      menu.style.cssText = CONTEXT_MENU_STYLE;
      const run = (action) => {
        closeContextMenu(doc);
        try {
          action();
        } catch (error) {
          logWarn("context menu action failed", error);
          showBanner(doc, "error", `${t("error.dialog")}: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      const hard = doc.createElement("button");
      hard.type = "button";
      hard.style.cssText = `${CONTEXT_ITEM_STYLE};${CONTEXT_DANGER_STYLE}`;
      const label = doc.createElement("span");
      label.textContent = t("menu.permanentDelete");
      hard.append(trashIcon(doc), label);
      hard.addEventListener("mouseenter", () => {
        hard.style.background = "var(--dsw-alias-interactive-bg-hover, transparent)";
      });
      hard.addEventListener("mouseleave", () => {
        hard.style.background = "transparent";
      });
      hard.addEventListener("click", (event) => {
        event.stopPropagation();
        run(() => openConfirm(sessionId, titleOf(ctx, sessionId)));
      });
      menu.append(hard);
      doc.body.appendChild(menu);
      const close = () => closeContextMenu(doc);
      const onPointer = (event) => {
        if (!menu.contains(event.target)) close();
      };
      const onKey = (event) => {
        if (event.key === "Escape") close();
      };
      setTimeout(() => {
        doc.addEventListener("pointerdown", onPointer, true);
        doc.addEventListener("keydown", onKey, true);
      }, 0);
      menu.__cleanup = () => {
        doc.removeEventListener("pointerdown", onPointer, true);
        doc.removeEventListener("keydown", onKey, true);
      };
      return menu;
    }

    function closeContextMenu(doc) {
      const existing = doc.querySelector("[data-session-erase-menu]");
      if (existing === null) return;
      try {
        existing.__cleanup?.();
      } catch {
        /* already detached */
      }
      existing.remove();
    }

    /* ── styles ────────────────────────────────────────────────────────── */

    const CONTEXT_MENU_STYLE = [
      "position:fixed", "z-index:2147483000", "min-width:200px", "padding:4px", "border-radius:10px",
      "background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1,Canvas))",
      "border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,CanvasText 15%,transparent))",
      "box-shadow:0 10px 30px rgba(0,0,0,.25)", "font-size:13px",
      "color:var(--dsw-alias-label-primary,CanvasText)",
    ].join(";");

    const CONTEXT_ITEM_STYLE = [
      "display:flex", "align-items:center", "gap:6px", "width:100%", "box-sizing:border-box",
      "text-align:left", "padding:7px 10px", "border:none", "border-radius:6px",
      "background:transparent", "color:inherit", "cursor:pointer", "font:inherit",
    ].join(";");

    const CONTEXT_DANGER_STYLE = "color:var(--dsw-alias-state-error-primary,CanvasText)";

    // The exact trash icon the official menu entries use
    // (`IconTrashOutlineRegular`, primitives export, 16×16, stroke currentColor).
    const SVG_NS = "http://www.w3.org/2000/svg";
    const TRASH_PATHS = [
      "M1.28149 3.88831H14.7187",
      "M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833",
      "M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831",
      "M6.44946 6.98926V11.1238",
      "M9.55054 6.98926V11.1238",
    ];

    function trashIcon(doc) {
      const svg = doc.createElementNS(SVG_NS, "svg");
      svg.setAttribute("width", "14");
      svg.setAttribute("height", "14");
      svg.setAttribute("viewBox", "0 0 16 16");
      svg.setAttribute("fill", "none");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("stroke-width", "1");
      svg.style.flex = "none";
      for (const d of TRASH_PATHS) {
        const path = doc.createElementNS(SVG_NS, "path");
        path.setAttribute("d", d);
        path.setAttribute("stroke", "currentColor");
        svg.appendChild(path);
      }
      return svg;
    }

    const MENU_ITEM_STYLE = [
      "display:block", "width:100%", "text-align:left", "padding:6px 10px",
      "border:none", "border-radius:6px", "background:transparent", "color:inherit",
      "cursor:pointer", "font:inherit",
    ].join(";");

    const BACKDROP_STYLE = [
      "position:fixed", "inset:0", "z-index:2147483000", "display:flex",
      "align-items:center", "justify-content:center", "background:rgba(0,0,0,.45)",
    ].join(";");

    const CARD_STYLE = [
      "width:min(440px,calc(100vw - 32px))",
      "border-radius:var(--dsw-radius-lg,12px)",
      "background:var(--dsw-alias-bg-layer-1,Canvas)",
      "border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,CanvasText 18%,transparent))",
      "box-shadow:0 24px 60px rgba(0,0,0,.35)",
      "color:var(--dsw-alias-label-primary,CanvasText)",
      "padding:18px 18px 14px", "font-size:14px", "line-height:1.5",
    ].join(";");

    const CARD_TITLE_STYLE = "font-size:15px;font-weight:600;line-height:1.4;letter-spacing:0.2px;margin-bottom:12px";
    const BODY_TEXT_STYLE = "font-size:14px;line-height:1.5;letter-spacing:0.2px;margin-bottom:10px";
    const MUTED_STYLE = [
      "color:var(--dsw-alias-label-secondary,CanvasText)", "font-size:13px", "line-height:1.6",
      "letter-spacing:0.2px", "overflow-wrap:anywhere", "word-break:break-all",
      "max-width:100%", "margin-bottom:10px",
    ].join(";");
    const WARNING_STYLE = [
      "color:var(--dsw-alias-state-error-primary,CanvasText)", "font-size:13px", "line-height:1.55",
      "letter-spacing:0.3px", "overflow-wrap:anywhere",
      "margin-top:12px", "margin-bottom:8px",
    ].join(";");
    const ERROR_COLOR_STYLE = "color:var(--dsw-alias-state-error-primary,CanvasText)";
    const OK_COLOR_STYLE = "color:var(--dsw-alias-state-success-primary,CanvasText)";
    const FOOTER_STYLE = "display:flex;justify-content:flex-end;gap:8px;margin-top:18px";

    const OUTLINE_BUTTON_STYLE = [
      "padding:6px 14px", "border-radius:8px",
      "border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,CanvasText 18%,transparent))",
      "background:transparent", "color:var(--dsw-alias-label-primary,CanvasText)",
      "cursor:pointer", "font:inherit",
    ].join(";");

    const DANGER_BUTTON_STYLE = [
      "padding:6px 14px", "border-radius:8px",
      "border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,CanvasText 18%,transparent))",
      "background:transparent", "color:var(--dsw-alias-state-error-primary,CanvasText)",
      "cursor:pointer", "font:inherit", "font-weight:600",
    ].join(";");

    const BANNER_STYLE = [
      "position:fixed", "z-index:2147483001", "left:50%", "bottom:28px",
      "transform:translateX(-50%)", "max-width:min(560px,calc(100vw - 32px))",
      "padding:10px 14px", "border-radius:var(--dsw-radius-lg,12px)", "font-size:13px",
      "background:var(--dsw-alias-bg-layer-1,Canvas)",
      "border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,CanvasText 18%,transparent))",
      "color:var(--dsw-alias-label-primary,CanvasText)",
      "box-shadow:0 12px 30px rgba(0,0,0,.3)",
    ].join(";");

    /* ── plugin ────────────────────────────────────────────────────────── */

    const inject = ["slots", "sessions", "workspaces", "locale"];

    function apply(ctx) {
      ctx.effect(() => ctx.get("locale").register(NS, DICTIONARIES), "session-erase: dictionaries");

      const openConfirm = (sessionId, displayTitle) => {
        const doc = window.document;
        const t = translator(ctx);
        const title = displayTitle ?? titleOf(ctx, sessionId);
        // Prefer the official Modal/Button when this runtime really has them;
        // otherwise keep the self-contained DOM dialog (theme-token based).
        if (canUseNativeDialog(primitives, createRoot)) {
          logInfo("dialog path: native");
          openNativeConfirm({ ctx, doc, sessionId, displayTitle: title, t, ui: primitives, createRoot });
          return;
        }
        logInfo("dialog path: fallback", {
          modal: typeof primitives?.Modal,
          button: typeof primitives?.Button,
          createRoot: typeof createRoot,
        });
        openEraseConfirm({ ctx, doc, sessionId, displayTitle: title, t });
      };

      ctx.slots.inject("sidebar.workspaces.session.menu.item", function* () {
        yield ctx.slots.register(
          {
            name: "sidebar.workspaces.session.menu.item",
            id: "erase-permanent",
            order: 470,
            locale: NS,
            inject: () => ({ requestErase: openConfirm }),
          },
          PermanentDeleteMenuItem,
        );
      });

      ctx.effect(() => {
        const doc = window.document;
        const onContextMenu = (event) => {
          const sessionId = findSessionIdFromTarget(event.target);
          if (sessionId === undefined) return;
          event.preventDefault();
          event.stopPropagation();
          logInfo("right-click on session", sessionId);
          const menu = showContextMenu(ctx, doc, sessionId, openConfirm);
          const { clientX, clientY } = event;
          const width = menu.offsetWidth;
          const height = menu.offsetHeight;
          menu.style.left = Math.max(4, Math.min(clientX, window.innerWidth - width - 4)) + "px";
          menu.style.top = Math.max(4, Math.min(clientY, window.innerHeight - height - 4)) + "px";
        };
        doc.addEventListener("contextmenu", onContextMenu, true);
        return () => {
          doc.removeEventListener("contextmenu", onContextMenu, true);
          closeContextMenu(doc);
        };
      }, "session-erase: right-click menu");
    }

    exports.apply = apply;
    exports.inject = inject;
    // Exposed for the node-based wiring tests; the loader ignores extra exports.
    exports.__test = {
      openEraseConfirm,
      openNativeConfirm,
      canUseNativeDialog,
      eraseViaHost,
      findSessionIdFromTarget,
      clearSessionDrafts,
      translator,
      PermanentDeleteMenuItem,
      MenuButton,
      showContextMenu,
      trashIcon,
    };
    return module.exports;
  },
});
