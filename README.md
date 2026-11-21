# dsh-rewind-message

回退并编辑已发送的问题 —— DeepSeek Harness Web 插件。

长按 / 右键一条已发送的 user 消息 → 就地编辑器改文本 → 作为新分支重发（旧后续轮次保留在原分支，内核 append-only 不物理删除）。快捷键 `Cmd/Ctrl + Backspace` 回退编辑最后一条 user 问题。

## 安装

```sh
dsh plugin --profile web add dsh-rewind-message
```

npm: https://www.npmjs.com/package/dsh-rewind-message

## 机制

- `lib/index.js`（host 半边）：只读路由 `GET /api/dsh-rewind-message/user-message`，回传某条 user 消息原文，不写会话日志。
- `lib/client.js`（client 半边）：注册 `uiConversation.interactions` 手势（长按/右键 user 消息），弹 Modal 就地编辑，走内核 composer 的 `inputActions.insertText` / `sendSession` 重发。

## 兼容

- dsh >= 0.2.1-rc.5 < 0.3.0（含显式预发布分支）
- `@deepseek-ai/cordis >=4.0.5 <5`

## License

MIT
