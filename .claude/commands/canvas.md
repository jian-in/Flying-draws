---
description: 打开 Flying draws 画布（可带画板名，不存在就新建）
argument-hint: "[画板名]"
---

调用 `mcp__flying-draws__canvas_open` 打开画布并把窗口带到前面。

画板参数：$ARGUMENTS

- 上面的画板参数不为空时，把它作为 `board` 传进去（画板不存在会自动新建）；带空格的名字同时作为 `title`。
- 为空时不传 `board`，打开当前画板。

打开后用一句话告诉我现在在哪块画板、第几版，不要做别的。
