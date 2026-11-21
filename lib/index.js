// dsh-rewind-plugin — host 半边
//
// 职责极小：
//   1) 声明本插件注入的服务（webServer）。
//   2) 暴露 /api/dsh-rewind/user-message 路由：client 长按某条 user 消息后，
//      带 (sessionId, messageId) 来取该条的原文，供 InlineEditor 预填（只读）。
//
// 不碰会话写操作：截断/fork/重发全部走 client 侧内核已暴露的
// ctx.conversation / ctx.uiSession / composer inputActions / sendSession，
// host 只做只读文本回传，避免与内核 append-only 语义打架。
//
// 导出约定（照 dsh-prompt-custom 官方 host 半边）：
//   export const name  / export const inject  / export function apply(ctx, config)
//   webServer 注册走 ctx.inject(['webServer'], webCtx => ...)，不是自己解构 ctx。

export const name = 'dsh-rewind-message';
// 只注 webServer（注册 HTTP 路由）；不改 systemPrompt。
export const inject = ['webServer'];

export function apply(ctx, config) {
  const log = (m) => (ctx.logger?.info ? ctx.logger.info('[' + name + '] ' + m) : console.log(m));

  // webServer：注册只读路由，回传某条 user 消息原文。
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer ?? webCtx;
    if (webServer.route) {
      webServer.route('GET', '/api/dsh-rewind/user-message', async (req, res) => {
        try {
          const sp = (req.url && req.url.searchParams) ? req.url.searchParams
                   : new URL(req.url, 'http://localhost').searchParams;
          const sessionId = String(sp.get('sessionId') ?? '');
          const messageId = String(sp.get('messageId') ?? '');
          if (!sessionId || !messageId) {
            res.status(400).json({ ok: false, error: 'sessionId 与 messageId 必填' });
            return;
          }
          const text = await readUserMessageText(ctx, sessionId, messageId);
          res.json({ ok: true, sessionId, messageId, text, isUser: true });
        } catch (err) {
          if (ctx.logger?.warn) ctx.logger.warn('[' + name + '] 读取 user 消息失败: ' + (err?.message ?? err));
          res.status(500).json({ ok: false, error: String(err?.message ?? err) });
        }
      });
      log('webServer 路由 /api/dsh-rewind/user-message 已注册');
    } else {
      log('警告：webServer.route 不可用，路由未注册（client 取原文会失败）');
    }
  });

  log('host apply 完成（注入服务: ' + inject.join(', ') + '）');
}

async function readUserMessageText(ctx, sessionId, messageId) {
  // 只读：优先 remote session 的 messages；取不到就抛错由路由转 500。
  const remote = ctx.remote?.session ?? ctx.remote?.remoteSession;
  if (!remote) {
    throw new Error('session remote 句柄不可用（内核版本不匹配？）');
  }
  const list = remote.messages?.list
    ? await remote.messages.list({ sessionId, limit: 500 })
    : await remote.messages?.read?.({ sessionId });
  const items = list?.items ?? list?.messages ?? (Array.isArray(list) ? list : []);
  const hit = items.find((m) => m.messageId === messageId || m.id === messageId);
  if (!hit) throw new Error('未找到该消息（可能已被 fork 遮蔽）');
  const text = typeof hit.text === 'string'
    ? hit.text
    : (hit.content?.map?.((c) => c.text ?? '').join('') ?? '');
  return text;
}
