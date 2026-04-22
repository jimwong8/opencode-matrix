---
description: 读取当前 active session 或指定 session 的内容
---
立即使用本地 Python SDK 。

输入格式：
/session-memory-get [session_id]

规则：
1. 如果提供了 session_id，则读取该会话。
2. 如果省略 session_id，则读取当前 active session。
3. 返回最近消息或会话详情。
4. 如果没有 active session，明确提示先执行 。
