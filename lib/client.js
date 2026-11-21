// dsh-rewind-plugin — client 半边（Web 平台）
//
// 功能：长按 / 右键一条「已发送的 user 消息」 → 弹一个就地编辑器改文本 →
//       填回 composer（inputActions.insertText）→ 重发（sendSession）。
//       旧后续轮次保留在原分支（内核 append-only，不物理删除）。
//
// 用到的公开扩展点（均照内核现有插件同款姿势）：
//   - ctx.uiConversation.interactions.register  注册选区/上下文菜单手势（同 dsh-message-quotes）
//   - @deepseek-ai/dsh-client-ui-primitives     设计系统原语 Modal / Button / Input
//   - ctx.uiSession.provide() → inputActions     composer 的 insertText / sendSession
//   - GET /api/dsh-rewind/user-message           host 半边回传原文（只读）
//
// 说明：本插件刻意「只读 + 复用内核发送通道」，不自己写会话日志，
//       避免与内核 append-only / fork 语义冲突。
window.__ModuleLoader__.load({
  id: "dsh-rewind-message",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const { jsx, jsxs, Fragment } = require("react/jsx-runtime");

    // 内核设计系统原语（与 dsh-prompt-custom 同款引入姿势：顶部一次性引入）。
    let primitives = {};
    try {
      primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    } catch (e) {
      // 原语缺失时降级：仍注册交互，但用原生 input + 无样式按钮，保证可用。
      primitives = {};
    }
    const {
      Button,
      Modal,
      IconCloseOutlineRegular,
    } = primitives;

    const API = "/api/dsh-rewind/user-message";

    const L = {
      title: "编辑并重新发送这条问题",
      hint: "改完后点「重新发送」：文本会填入输入框并作为新分支重发；旧后续轮次保留在原分支。",
      editPlaceholder: "编辑这条 user 问题…",
      cancel: "取消",
      resend: "重新发送",
      sending: "重新发送中…",
      loaded: "已填入输入框，可直接发送或继续改。",
      loadFail: (m) => "读取原文失败：" + m,
      noComposer: "当前会话的输入框不可用（可能在运行中）。",
      contextLabel: "编辑并重新发送",
    };

    // ── 取某条 user 消息原文 ─────────────────────────────────────────
    async function fetchUserText(sessionId, messageId) {
      const url = API + "?sessionId=" + encodeURIComponent(sessionId) +
                  "&messageId=" + encodeURIComponent(messageId);
      const r = await fetch(url, { credentials: "same-origin" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || ("HTTP " + r.status));
      return j.text || "";
    }

    // ── 就地编辑器 + 重发 Modal ─────────────────────────────────────
    function RewindModal({ state, onClose }) {
      const [text, setText] = react.useState(state.initialText || "");
      const [busy, setBusy] = react.useState(false);
      const [note, setNote] = react.useState("");
      const textareaRef = react.useRef(null);

      react.useEffect(() => {
        // 打开后聚焦并全选，方便直接覆盖编辑。
        const el = textareaRef.current;
        if (el) { el.focus(); el.select(); }
      }, []);

      function doResend() {
        if (busy) return;
        setBusy(true);
        setNote("");
        // 通过内核 composer 通道：把新文本填回输入框并发送。
        const input = state.inputActions;
        if (!input || typeof input.sendSession !== "function") {
          setBusy(false);
          setNote(L.noComposer);
          return;
        }
        // insertText 填回（保留 undo），随后 sendSession 触发重发。
        try {
          if (typeof input.insertText === "function") {
            input.insertText(text, { replaceAll: true });
          }
          input.sendSession({
            sessionId: state.sessionId,
            content: text,
            // 作为新分支重发：内核会把后续旧轮次留在原分支。
            source: "rewind-plugin",
          });
          setNote(L.loaded);
        } catch (err) {
          setBusy(false);
          setNote(L.noComposer + "（" + (err && err.message ? err.message : err) + "）");
          return;
        }
        // 关闭编辑器；保留 composer 里的新文本，由用户确认发送或自动已发。
        onClose();
      }

      const TextCtrl = Button ? "textarea" : "textarea";
      return jsx(Modal || "div", {
        open: true,
        onClose: onClose,
        title: L.title,
        children: [
          jsx("p", { style: { margin: "0 0 8px", fontSize: 12, opacity: 0.75 }, children: L.hint }),
          jsx("textarea", {
            ref: textareaRef,
            value: text,
            onChange: (e) => setText(e.target.value),
            rows: 4,
            style: {
              width: "100%", boxSizing: "border-box",
              fontFamily: "inherit", fontSize: 14, padding: 8,
              borderRadius: 8, border: "1px solid var(--dsw-border, #444)",
              background: "var(--dsw-surface-2, #111)", color: "inherit",
            },
            placeholder: L.editPlaceholder,
          }),
          note ? jsx("p", { style: { margin: "8px 0 0", fontSize: 12, opacity: 0.8 }, children: note }) : null,
          jsx("div", {
            style: { display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 },
            children: [
              Button
                ? jsx(Button, { variant: "ghost", onClick: onClose, children: L.cancel })
                : jsx("button", { onClick: onClose, children: L.cancel }),
              Button
                ? jsx(Button, { variant: "primary", onClick: doResend, disabled: busy, children: busy ? L.sending : L.resend })
                : jsx("button", { onClick: doResend, disabled: busy, children: busy ? L.sending : L.resend }),
            ],
          }),
        ],
      });
    }

    // ── 打开编辑器（读原文 → 预填 → 弹 Modal）────────────────────────
    function openRewindEditor(ctx, binding, gesture) {
      const sessionId = binding?.sessionId ?? ctx.currentSessionId;
      const messageId = gesture?.messageId ?? gesture?.targetMessageId;
      if (!sessionId || !messageId) return;
      fetchUserText(sessionId, messageId)
        .then((initialText) => {
          // 把 Modal 通过内核 UI 挂载点渲染。uiConversation 提供 overlay 渲染；
          // 没有就用 body 级 portal 兜底。
          const mount = ctx.uiConversation?.renderOverlay ?? null;
          const inputActions = ctx.uiSession?.provide?.()?.inputActions ?? ctx.inputActions;
          state = {
            sessionId,
            messageId,
            initialText,
            inputActions,
          };
          if (mount && typeof mount === "function") {
            mount(jsx(RewindModal, {
              key: "rewind-" + messageId,
              state,
              onClose: () => mount?.unmount?.() ?? undefined,
            }));
          } else {
            // 兜底：挂到 body，简单渲染（原语缺失时的降级路径）。
            const host = document.createElement("div");
            host.innerHTML = "";
            const el = jsx("div", {
              children: jsx(RewindModal, {
                state,
                onClose: () => document.body.removeChild(host),
              }),
            });
            host.appendChild(el);
            document.body.appendChild(host);
          }
        })
        .catch((err) => {
          ctx.uiConversation?.toast?.(L.loadFail(err.message || String(err)), "error");
        });
    }

    let state = null;

    // ── 插件主体：注册交互 + 上下文菜单手势 ────────────────────────
    return {
      name: "dsh-rewind-plugin",
      mount(ctx) {
        // ctx.uiConversation.interactions：注册 user 消息的长按/右键手势。
        // 参照 dsh-message-quotes：注册一个 keyed Slot + 同步 handler。
        const interactions = ctx.uiConversation?.interactions;
        if (!interactions || typeof interactions.register !== "function") {
          ctx.logger?.warn?.("dsh-rewind: interactions 扩展点不可用，降级为仅全局快捷键");
        }

        const disposers = [];

        if (interactions) {
          // 注册 user 消息上下文菜单项：「编辑并重新发送」。
          const d = interactions.register({
            id: "rewind-user-message",
            // 只作用于 user 角色的消息；assistant/工具消息不显示。
            targetRoles: ["user"],
            gestures: ["context-menu", "long-press"],
            slot: "message-actions",
            label: L.contextLabel,
            handler(payload) {
              // payload: { sessionId, messageId, preventDefault, open }
              payload.preventDefault?.();
              openRewindEditor(ctx, { sessionId: payload.sessionId }, payload);
            },
          });
          if (d && typeof d.dispose === "function") disposers.push(d.dispose);
        }

        // 全局快捷键兜底：Cmd/Ctrl+Backspace = 回退并编辑「上一条 user 消息」。
        function onKey(e) {
          if ((e.metaKey || e.ctrlKey) && e.key === "Backspace") {
            e.preventDefault();
            e.stopPropagation();
            const lastUser = ctx.uiConversation?.lastUserMessage?.();
            if (lastUser) {
              openRewindEditor(ctx, { sessionId: ctx.currentSessionId }, lastUser);
            }
          }
        }
        document.addEventListener("keydown", onKey, true);
        disposers.push(() => document.removeEventListener("keydown", onKey, true));

        ctx.logger?.info?.("dsh-rewind-plugin: client 已挂载（长按/右键 user 消息 + Cmd/Ctrl+Backspace）");

        return () => {
          disposers.forEach((f) => { try { f(); } catch (_) {} });
        };
      },
    };
  },
});
