# 中期报告：DeepResearch（ReAct 多智能体深度研究原型）

> 更新时间：2026-03-16  
> 面向场景：软件工程毕业设计 / 中期答辩展示  
> 关键词：ReAct、多智能体协作、工具调用、联网检索、证据链、可解释 Trace、质量保障（Critic）

---

## 1. 项目概述

本项目实现了一个面向“深度研究报告生成”的原型系统：用户输入一个开放式研究主题，系统将自动完成**规划 → 搜索 → 抓取/清洗 → 证据要点提炼 → 写作成文 → 质量检查（Critic）**，最终输出带来源链接的 Markdown 报告初稿，并提供可回放的执行链路（trace），用于答辩时展示“系统为何这样做、依据是什么、如何得到结论”。

系统目标不是一次性做到“事实完美正确”，而是优先保证：

- **能跑通**：端到端闭环可重复运行
- **能解释**：每一步行动与观察都可追溯
- **可控可靠**：有最小质量保障策略（重试、降级、Critic）

---

## 2. 中期目标与完成情况（对齐任务规划）

### 2.1 中期目标

- **端到端闭环**：主题输入 → 报告初稿输出（含来源）
- **ReAct 可解释性**：trace 记录行动与观察，可回放
- **最小质量保障**：信源筛选/失败降级/（Critic v0）引用与硬断言检查

### 2.2 已实现（可演示）

- **Research Task 状态机与 API**
  - `POST /api/research` 创建任务（返回 `taskId`）
  - `GET /api/research/:id` 轮询任务状态与 trace
  - `GET /api/research/:id/artifact/:name` 获取产物
- **产物（Artifacts）**
  - `plan.json`：Query Plan（子问题/关键词等）
  - `sources.json`：搜索结果与抓取文档集合
  - `notes.json`：按小节汇总证据要点与写作草稿（含搜索 provider 信息）
  - `report.md`：最终报告（各节附来源链接）
  - `critic_report.json`：Critic v0 输出（问题列表与修正统计）
- **联网检索**
  - 采用 `SEARCH_PROVIDER=tavily`（Tavily Search API）返回结构化 `url/title/snippet`
- **网页抓取与清洗**
  - 对可访问网页进行抓取并去噪（HTML→文本）
  - 对强反爬站点自动降级使用搜索 `snippet`（保证证据链不断）
- **证据卡片（Reader）**
  - 基于抓取/摘要文本生成 `bullets: {claim/support/url}`，作为写作依据
- **写作成文（Writer）**
  - 基于证据要点生成报告段落，并在每节输出 `sources`
  - 段落/字数约束为“软约束”，兼顾可读性与稳定性
- **质量保障（稳定性）**
  - 上游模型繁忙/超时等错误自动重试（指数退避），trace 记录重试原因与等待时长
  - Reader/Writer JSON 解析失败不会导致整任务失败：自动降级产出可交付小节
- **前端演示界面**
  - `Chat`：基础对话
  - `Research`：提交主题、显示状态、渲染 `report.md`、查看 trace、打开 `notes.json`
  - trace 支持折叠/展开，并展示“搜索结果预览/URL 列表/provider”

### 2.3 未实现 / 部分实现（后续迭代重点）

- **冲突标记（conflict marking）**：尚未实现
- **更强 Critic（生成-批判-修正闭环）**
  - 当前 v0 只做最小检查（来源数量/域名多样性/硬断言风险）与有限修正
  - 尚未实现系统化的多源交叉验证与“事实级回溯检查”
- **长期记忆/知识库（World Model）**：尚未实现
- **评测体系**：尚未实现自动化指标统计（引用覆盖率/来源多样性/耗时拆分等）
- **任务落盘**：当前任务与产物仍主要在内存中（重启会丢），尚未做稳定持久化
- **`report.txt` 输出**：目前以 `report.md` 为主

---

## 3. 系统架构与数据流（ReAct + 多智能体）

### 3.1 角色分工（逻辑层）

- **Coordinator（总控）**
  - 推进任务状态机，串联各阶段并汇总产物
- **Planner**
  - 输入主题 → 输出 Query Plan（子问题与关键词）
- **Researcher**
  - 调用 `web_search` 获取候选来源列表
- **Fetcher**
  - 尝试抓取并清洗网页；失败则用 snippet 降级
- **Reader**
  - 从文本中提炼证据要点（claim/support/url）
- **Writer**
  - 基于证据要点生成段落与小节，并输出来源列表
- **Critic v0**
  - 检查“来源不足/域名单一/硬断言风险”，必要时触发修正

### 3.2 ReAct Trace（可解释性）

每条事件包含：

- `ts`：时间戳
- `stage`：`planning/collecting/reading/writing/reviewing/done/...`
- `agent`：Planner/Researcher/Fetcher/Reader/Writer/Critic/Coordinator
- `type`：`reasoning/action/observation/decision/final`
- `payload`：输入/输出/错误/重试等细节

答辩展示重点：用一条完整 trace 串起“系统为何这样搜、搜到什么、如何提炼证据、如何写作、如何检查与修正”。

---

## 4. 关键实现说明（中期版本）

### 4.1 联网搜索（Tavily）

通过 Tavily 搜索 API 获取结构化结果（`url/title/snippet/source`），并在 trace 与 `sources.json/notes.json` 中记录 provider 信息，确保“证据链来源可解释”。

### 4.2 抓取失败的工程现实与降级策略

大量站点存在反爬（403/跳转/需要登录），为保证中期可演示、可交付，采用策略：

- 可抓取：抓取正文并清洗为文本
- 不可抓取：直接用搜索 `snippet` 作为证据文本（仍保留 URL）

这保证了“有来源、有证据”的闭环不会因为反爬中断。

### 4.3 JSON 输出稳定性：重试 + 降级

Planner/Reader/Writer 均依赖 LLM 输出结构化 JSON，现实中可能出现：

- 模型过载（overloaded / try again later）
- 输出截断
- 非法 JSON

对策：

- **自动重试**：指数退避，并写入 trace
- **降级输出**：Reader/Writer 失败时也能产出可交付的 notes/report（并在 trace 中标记 fallback）

### 4.4 Critic v0（最小质量保障）

当前 Critic v0 包含：

- **来源数量检查**：每节至少 2 条
- **域名多样性**：建议至少 2 个不同域名
- **硬断言风险**：段落出现明显数字/时间但证据缺失数字信息时，提示需要降级表述或补证据
- **自动修正（有限）**
  - 来源不足：补搜并重跑 Reader/Writer
  - 硬断言风险：触发改写（定性表述优先）

输出：`critic_report.json`（记录问题、修正次数、跳过次数）。

---

## 5. 演示流程（10 分钟建议脚本）

1. **问题与动机（1 min）**：信息爆炸，人工检索/单 LLM 的不足（缺乏证据链与可解释过程）
2. **架构（2 min）**：ReAct + 多智能体分工 + 工具链（搜索/抓取/阅读/写作/批判）
3. **现场演示（5 min）**
   - Research 输入 topic → 观察状态变化（planning/collecting/reading/writing/reviewing）
   - 展示 `report.md`（每节来源链接）
   - 展示 trace（展开 `Researcher observation` 看搜索结果预览；展开 `Fetcher` 看抓取/降级；展开 `Critic` 看修正）
4. **结果与展望（2 min）**：当前能力、已知风险、下一阶段迭代重点（冲突标记/强验证/评测/持久化）

---

## 6. 当前问题与风险预案

- **LLM 过载/不稳定**：自动重试 + trace 记录；必要时降级输出避免任务失败
- **反爬导致抓取失败**：snippet 降级；后续可引入更稳的抓取代理或官方数据源
- **来源质量参差不齐**：中期先保证“可追溯”；后续加入 domain rank、白名单/黑名单与冲突标记
- **任务可复现**：当前主要内存存储；后续建议落盘（按 taskId 保存 artifacts 与 trace）

---

## 7. 下一阶段迭代计划（建议）

按“答辩加分 / 工程收益”排序：

1. **冲突标记 v0**：同一子问题下的相反观点显式标注 + 双来源并列
2. **Critic 强化**：把“检查”变成“检查 + 修正闭环”（引用覆盖率、事实回溯）
3. **评测脚本**：批量 topic 跑任务，产出指标表与对比图
4. **任务落盘**：重启不丢、可复现实验、便于论文附录
5. **更强知识库/长期记忆**：结构化笔记 + 可检索存储（向量/结构化）

---

## 8. 变更记录（迭代补充区）

> 后续每次迭代如新增工具、改动流程、增加评测/质量机制，都在此记录要点与影响范围，便于论文与答辩材料同步更新。

- 2026-03-16：完成中期闭环（Planner→Tavily Search→Fetch/Snippet→Reader→Writer→Critic v0），前端支持 trace 折叠与搜索结果预览

