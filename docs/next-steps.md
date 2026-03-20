# 下一步计划（Roadmap）

本文档用于记录本项目从“可运行骨架”演进到“可写论文、可演示、可评测”的实现路线。当前系统已具备：React 前端聊天 UI、Express 后端 API、ReAct 多智能体编排骨架、工具注册与调用、内存会话记忆。

## 0. 当前基线能力

- 前端：输入问题 → 调用 `/api/chat` → 渲染回答
- 后端：`/api/chat` 驱动编排器：Planner（规划）→ Tool（执行）→ Answer（回答）
- 工具：`calculator` / `time` / `echo`
- 记忆：SessionStore（内存）记录 session 的消息历史
- 调试：`/api/chat?debug=1` 返回 `plan` 与 `observations`

## 1. 目标拆解（面向毕业设计）

建议把最终目标拆成 5 个可交付模块（论文也容易按模块写）：

1) **LLM 接入与 ReAct Prompt 规范化**
- 目标：Planner/Answer 从“规则”升级为“基于大模型的推理与行动”
- 产出：统一的消息协议、工具调用格式、可复现实验用的 prompt 模板

2) **工具体系扩展（至少 5 类工具）**
- 目标：体现 ReAct 的“行动能力”和多工具编排
- 产出：工具接口文档 + 可演示的复杂问题（需要调用多个工具才能完成）

3) **记忆/长期记忆与多轮对话**
- 目标：体现“智能体记忆”和“多轮一致性”
- 产出：短期记忆（窗口）+ 长期记忆（向量检索或结构化存储）的方案与对比

4) **多智能体协作机制升级**
- 目标：从串行三代理升级到可扩展的协作（分工、投票、仲裁、反思）
- 产出：多智能体通信协议与编排策略（如 Coordinator + Specialist Agents）

5) **评测与可视化（论文关键）**
- 目标：证明系统“更好/更可控/更可扩展”
- 产出：指标、数据集、对比基线、可视化日志/回放

## 2. 优先路线（推荐按顺序实现）

### 阶段 A：把 ReAct 过程“写清楚”（日志与协议）

- 统一事件/日志结构（用于前端回放、论文插图）
  - 事件类型：`reasoning`（规划）、`action`（工具调用）、`observation`（结果）、`final`（回答）
  - 每次 `/api/chat` 返回一个 `traceId`，可通过 `/api/trace/:traceId` 查询完整链路
- 规范工具接口文档（每个工具必须描述：name/desc/input/output/error）

验收标准：
- 任意一次问答可以完整复现：用了哪些工具、每一步输入输出是什么、最终为何得出该答案

### 阶段 B：接入 LLM（先把管道跑通）

实现建议：
- 新增 `LLMClient`，支持通过环境变量配置 provider
  - `LLM_PROVIDER=kimi|moonshot|openai|local|mock`
  - `KIMI_API_KEY=...`（注意不写入仓库）
  - `KIMI_MODEL=moonshot-v1-8k`（示例）
  - `KIMI_BASE_URL=https://api.moonshot.cn/v1`（示例）
  - 可参考示例文件：`server/.env.example`
- 先从 **AnswerAgent 接入 LLM** 开始（Planner 仍可先规则化）
  - 目标：让 AnswerAgent 能根据 `question + observations + memory` 生成更自然的回答
- 然后再升级 PlannerAgent 为 LLM Planner
  - 让 Planner 输出结构化 `steps`（工具调用序列）

工具调用格式建议（JSON）：

```json
{
  "type": "tool",
  "toolName": "calculator",
  "input": { "expression": "12*(3+4)" }
}
```

验收标准：
- Planner 能在含糊问题中选择工具（例如“帮我算一下并告诉我现在时间”）
- Answer 能把 observation 组织成自然语言，并对失败给出可恢复建议

### 阶段 C：扩展工具（体现系统价值）

至少建议新增以下 4 类（加上现有 3 个，工具数量会比较“像毕业设计”）：

- **WebSearch**：网络搜索（可先 mock 或用可控数据源）
- **RAG/KBSearch**：本地文档检索（Markdown/PDF → 切分 → 向量检索）
- **CodeSearch**：在项目代码中检索（对本项目自身做“自解释问答”演示）
- **TaskPlanner**：把问题拆成待办列表（对“规划能力”展示很直观）

验收标准：
- 设计 10 个演示问题，其中至少 5 个需要两步以上工具调用

### 阶段 D：记忆升级（短期 + 长期）

- 短期记忆（已具备）：窗口化消息（最近 N 条）
- 长期记忆（建议二选一，或都做对比）：
  - 方案 1：向量库（embedding + similarity search）
  - 方案 2：结构化记忆（key-value/事实表/用户画像）

验收标准：
- 多轮对话中能引用历史事实，并且不丢关键上下文

### 阶段 E：多智能体协作升级（分工 + 仲裁）

推荐结构：
- Coordinator（总控）：负责分解问题、分派子任务、汇总结果
- Specialist Agents：
  - ToolPlanner（工具规划）
  - Researcher（搜索/检索）
  - Critic（自检/纠错）
  - Writer（输出润色）

协作策略示例：
- 并行提出方案 → 投票/打分 → 选择最优 → 执行工具 → Critic 检查 → 最终输出

验收标准：
- 对同一问题能输出“带依据的答案”，并且能解释工具证据来源

## 3. 接口与数据结构（建议固定下来，便于论文描述）

### 3.1 `/api/chat` 请求与响应

请求：

```json
{
  "sessionId": "string",
  "question": "string"
}
```

响应（正常）：

```json
{
  "sessionId": "string",
  "answer": "string"
}
```

响应（debug=1）：
- 额外返回 `plan`、`observations`（后续可扩展为 `trace`）

### 3.2 Tool 规范（服务端内部）

- `name: string`
- `description: string`
- `inputSchema: object`（简化 JSON-Schema）
- `handler(input): Promise<object>`

## 4. 论文写作对齐建议

建议论文结构与实现阶段对齐：

- 第 1 章：背景与意义（ReAct、多智能体、工具调用的优势）
- 第 2 章：总体设计（前后端架构、模块划分、数据流）
- 第 3 章：ReAct 多智能体框架实现（Planner/Tool/Answer/Coordinator）
- 第 4 章：工具体系与接口规范（工具注册、输入校验、扩展策略）
- 第 5 章：记忆与对话管理（短期/长期记忆设计与对比）
- 第 6 章：实验与评测（数据集、指标、基线、结果）
- 第 7 章：总结与展望

## 5. 最小可复现实验（建议提前准备）

- 问题集（不少于 30 条），按类型分组：
  - 纯工具型（算式、时间）
  - 检索型（文档/网页）
  - 组合型（多工具链）
  - 多轮型（需要记忆）
- 指标：
  - 工具选择准确率
  - 工具调用成功率
  - 回答正确率/一致性
  - 延迟（端到端耗时）
