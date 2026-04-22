---
description: 创建一个新的 session-memory 会话并返回会话 ID
---
立即使用本地 Python SDK 。

执行要求：
1. 为当前任务创建一个新的 session-memory 会话。
2. 使用：
   - user_id = jimwong
   - title = 当前任务或主题名
   - metadata_json 包含当前项目路径（如果有）
3. 返回创建成功后的 session id。
4. 如果失败，明确返回失败原因，不要假装成功。
