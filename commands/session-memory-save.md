---
description: 向当前 active session 或指定 session 保存一条消息
---
立即使用本地 Python SDK 。

输入格式：
/session-memory-save [session_id] <role> <content>

规则：
1. 如果提供了 session_id，则写入该会话。
2. 如果省略 session_id，则写入当前 active session。
3. role 只能是 user、assistant、system 之一。
4. 返回成功/失败结果；若成功，返回 message id。
5. 如果没有 active session，明确提示先执行 。
