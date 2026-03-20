# Debug 记录

## 冒烟测试日志

日志文件默认位置：

- `docs/debug/runs/`（每次运行生成一个新的 JSON 文件）

运行方式（确保后端已启动，默认是 `http://localhost:3001`）：

```bash
npm --workspace server run smoke
```

自定义参数：

```bash
npm --workspace server run smoke -- --question "先告诉我现在时间，然后算 12*(3+4)" --debug 1
```

环境变量方式：

- `SMOKE_BASE_URL`：例如 `http://localhost:3001`
- `SMOKE_SESSION_ID`：会话 id
- `SMOKE_QUESTION`：测试问题
- `SMOKE_DEBUG`：`1` 或 `0`
- `SMOKE_LOG_DIR`：日志目录（默认 `docs/debug/runs`）
- `SMOKE_LOG_PATH`：日志文件路径（显式指定则覆盖默认命名）

## 日志字段说明（精简版）

每条记录示例字段：

- `ts`：时间戳（ISO）
- `sessionId`：会话 id
- `question`：本次测试问题
- `ok` / `status`：HTTP 结果
- `answer`：最终返回的自然语言回答
- `plan` / `observations`：当 `debug=1` 时返回的工具调用计划与执行结果
- `trace`：当 `debug=1` 时返回的迭代细节（关键用于定位问题）
  - `iter`：第几轮
  - `attempts`：本轮模型原始输出（包含工具调用标记的 JSON）
  - `tool_requests` / `final`：从模型输出中解析出的结构化字段
  - `steps`：系统实际执行的工具步骤
  - `observations`：工具返回结果
