import { useCallback, useMemo, useState } from "react";
import { createDefaultAgentPrefs, loadAgentPrefs, saveAgentPrefs } from "../agentPreferences.js";
import Modal from "../rag/Modal.jsx";

/** 与后端研究管线 trace 中的 agent 字段一致，便于叙事与实验对照 */
const CATALOG = [
  {
    id: "orchestration",
    title: "总控与编排",
    blurb: "多智能体协同的调度中枢：负责任务生命周期、阶段切换与跨角色消息分发。"
  },
  {
    id: "planning",
    title: "规划与任务拆解",
    blurb: "将开放课题转化为可检索、可验证的子问题与查询计划。"
  },
  {
    id: "retrieval",
    title: "检索与抓取",
    blurb: "面向开放网络的证据采集与页面级清洗，为后续阅读智能体提供素材。"
  },
  {
    id: "reading",
    title: "证据阅读",
    blurb: "对网页与知识库片段做结构化理解，压缩噪声、保留可引用要点。"
  },
  {
    id: "writing",
    title: "报告写作",
    blurb: "将多源证据组织为连贯叙述，形成可交付的研究型答复。"
  },
  {
    id: "review",
    title: "质量评审",
    blurb: "对草稿做一致性、可核查性与风格层面的迭代改进。"
  },
  {
    id: "dialogue",
    title: "轻量对话通道",
    blurb: "在路由为「简单对话」时由单模型快速响应；与深度研究多智能体并行，体现「快路径 / 慢路径」双通道。"
  }
];

const AGENTS = [
  {
    catalogId: "orchestration",
    id: "Coordinator",
    name: "Coordinator",
    role: "总控智能体",
    desc: "编排 Planner→Researcher→Reader→Writer→Critic 等阶段，并在进度轨迹中记录关键决策。"
  },
  {
    catalogId: "planning",
    id: "Planner",
    name: "Planner",
    role: "规划智能体",
    desc: "把用户主题拆解为 Query Plan，决定检索关键词与先后次序。"
  },
  {
    catalogId: "retrieval",
    id: "Researcher",
    name: "Researcher",
    role: "检索调度智能体",
    desc: "根据计划触发联网检索与文档抓取，协调 Fetcher 的并发调用。"
  },
  {
    catalogId: "retrieval",
    id: "Fetcher",
    name: "Fetcher",
    role: "抓取执行智能体",
    desc: "对具体 URL 发起抓取与轻量清洗，输出可供 Reader 消费的文本。"
  },
  {
    catalogId: "reading",
    id: "Reader",
    name: "Reader",
    role: "阅读智能体",
    desc: "阅读长网页与知识库分块，抽取要点、引用线索与潜在矛盾。"
  },
  {
    catalogId: "writing",
    id: "Writer",
    name: "Writer",
    role: "写作智能体",
    desc: "按章节组织证据链，生成概述、正文与结论等报告式输出。"
  },
  {
    catalogId: "review",
    id: "Critic",
    name: "Critic",
    role: "评审智能体",
    desc: "对段落做事实密度、可核查性与表述风险检查，并可触发补充检索。"
  },
  {
    catalogId: "dialogue",
    id: "ChatAssistant",
    name: "ChatAssistant",
    role: "会话助手（快路径）",
    desc: "不经由完整研究编排时，由该通道直接生成自然语言回复；仍可与知识库 RAG 片段协同。"
  }
];

function cleanHintText(text) {
  return String(text || "").replace(/\*\*/g, "");
}

/** 属性标题旁的问号：悬浮显示完整说明（避免原生 title 只显示「?」） */
function ParamHint({ text }) {
  const t = cleanHintText(text);
  if (!t) return null;
  return (
    <span className="settingsParamHintWrap">
      <button type="button" className="settingsParamHint" aria-label={t}>
        ?
      </button>
      <span className="settingsParamHintTip" role="tooltip">
        {t}
      </span>
    </span>
  );
}

/** 各智能体卡片上的可运行参数（保存后随下次发消息 / 深度研究请求生效） */
function AgentRuntimeControls({ agentId, draft, setDraft }) {
  const range = (key, label, min, max, opts = {}) => {
    const { step = 1, fmt, hint } = opts;
    const show = fmt || ((v) => v);
    return (
      <div className="settingsAgentParam">
        <span className="settingsAgentParam__label">
          <span className="settingsAgentParam__titleRow">
            <span>{label}</span>
            <ParamHint text={hint} />
          </span>
          <span className="settingsAgentParam__val">{show(draft[key])}</span>
        </span>
        <input
          type="range"
          className="settingsRange settingsRange--inCard"
          min={min}
          max={max}
          step={step}
          value={draft[key] ?? min}
          onChange={(e) => setDraft((p) => ({ ...p, [key]: Number(e.target.value) }))}
        />
      </div>
    );
  };

  switch (agentId) {
    case "Coordinator":
      return (
        <div className="settingsAgentCard__params" role="group" aria-label="总控运行参数">
          <label className="settingsAgentParam">
            <span className="settingsAgentParam__label settingsAgentParam__label--solo">
              <span className="settingsAgentParam__titleRow">
                <span>对话路由</span>
                <ParamHint text="决定本条消息走「简单对话（单模型快路径）」还是「深度研究（多智能体）」，或交给系统结合分流模型与环境变量自动选择。" />
              </span>
            </span>
            <select
              className="textInput settingsAgentCard__select"
              value={draft.chatRouteMode || "auto"}
              onChange={(e) => setDraft((p) => ({ ...p, chatRouteMode: e.target.value }))}
            >
              <option value="auto">自动（分流 + 环境变量）</option>
              <option value="simple">强制简单对话</option>
              <option value="deep">强制深度研究</option>
            </select>
          </label>
          {range("traceTailCount", "研究进度展示条数（仅界面）", 5, 40, {
            hint: "对话页「研究进行中」里展示的最近几条智能体轨迹数量，只影响界面展示，不调用模型。"
          })}
        </div>
      );
    case "Planner":
      return (
        <div className="settingsAgentCard__params" role="group" aria-label="Planner 参数">
          {range("plannerMaxTokens", "规划输出 max_tokens", 400, 2000, {
            step: 50,
            hint: "调用 Planner 生成「子问题 + 关键词」JSON 时，允许模型输出的最大 token 数。过小易被截断导致解析失败；过大更耗 token。"
          })}
          <div className="settingsAgentParam">
            <span className="settingsAgentParam__label">
              <span className="settingsAgentParam__titleRow">
                <span>规划温度</span>
                <ParamHint text="Planner 采样温度：越高规划角度更多样，越低更稳定、更保守。一般与 max_tokens 配合调节。" />
              </span>
              <span className="settingsAgentParam__val">{Number(draft.plannerTemperature ?? 0.2).toFixed(2)}</span>
            </span>
            <input
              type="range"
              className="settingsRange settingsRange--inCard"
              min={5}
              max={50}
              value={Math.round((draft.plannerTemperature ?? 0.2) * 100)}
              onChange={(e) =>
                setDraft((p) => ({ ...p, plannerTemperature: Number(e.target.value) / 100 }))
              }
            />
          </div>
        </div>
      );
    case "Researcher":
      return (
        <div className="settingsAgentCard__params" role="group" aria-label="Researcher 参数">
          {range("ragTopK", "多库合并后进入提示的 Top-K", 1, 16, {
            hint: "多个知识库分别检索后按分数合并，取前 K 条片段写入提示或深度研究课题上下文；K 越大上下文越长、越可能触发模型长度限制。"
          })}
          {range("ragMinScore", "RAG 最低相似度（余弦）", 0, 0.95, {
            step: 0.01,
            fmt: (v) => (Number(v) <= 0 ? "关闭" : Number(v).toFixed(2)),
            hint: "大于 0 时：多库合并后若**最高分**仍低于该值，则**整轮不注入**知识库（简单对话与深度研究课题中的 KB 附录均不出现；知识库详情「检索测试」同步返回空列表并提示）。设为 0 关闭门槛。服务端环境变量 RAG_MIN_SCORE_DEFAULT 可在未传该字段时作为默认。"
          })}
        </div>
      );
    case "Fetcher":
      return (
        <div className="settingsAgentCard__params" role="group" aria-label="Fetcher 参数">
          <label className="settingsAgentParam settingsAgentParam--row">
            <input
              type="checkbox"
              checked={Boolean(draft.fetcherPreferKbOnly)}
              onChange={(e) => setDraft((p) => ({ ...p, fetcherPreferKbOnly: e.target.checked }))}
            />
            <span className="settingsAgentParam__checkboxText">
              有知识库命中时尽量跳过联网搜索（仅用 KB 文档进入阅读）
              <ParamHint text="勾选后：只要本轮子问题有知识库检索结果，就尽量不发起联网搜索与网页抓取，仅用 KB 文档进入 Reader（仍受服务端 RESEARCH_RAG_ALWAYS_WEB 等环境变量约束）。" />
            </span>
          </label>
        </div>
      );
    case "Reader":
      return (
        <div className="settingsAgentCard__params" role="group" aria-label="Reader 参数">
          {range("ragSnippetMaxChars", "写入对话/课题的每条 KB 片段最大字符", 400, 4000, {
            step: 100,
            hint: "每条知识库分块写入「简单对话」系统提示或「深度研究」课题说明时的最大字符数，用于控制总上下文长度。"
          })}
          {range("readerMaxSources", "进入阅读模型的来源条数", 2, 8, {
            hint: "每个子问题下，挑选多少条带 URL 的来源（网页或 KB）送进 Reader 做要点提炼；条数多信息更全但更耗 token。"
          })}
          {range("readerClipChars", "单来源正文截断长度", 600, 8000, {
            step: 100,
            hint: "单条来源网页/片段在送入 Reader 前截断到的最大字符数，避免某一页过长占满上下文。"
          })}
          {range("readerMaxTokens", "阅读阶段 max_tokens", 400, 2000, {
            step: 50,
            hint: "Reader 输出「证据要点」JSON 时允许的最大生成 token；过小可能截断导致解析失败。"
          })}
        </div>
      );
    case "Writer":
      return (
        <div className="settingsAgentCard__params" role="group" aria-label="Writer 参数">
          {range("writerMaxTokens", "小节写作 max_tokens", 320, 2000, {
            step: 40,
            hint: "Writer 为每个子问题生成小节（标题、摘要、段落、来源 URL 等）JSON 时的最大输出 token；过小内容易截断，过大更耗 token。"
          })}
        </div>
      );
    case "Critic":
      return (
        <div className="settingsAgentCard__params" role="group" aria-label="Critic 参数">
          {range("criticRewriteMaxTokens", "批判改写 max_tokens", 400, 2400, {
            step: 50,
            hint: "质量评审阶段（如去数字断言、补来源后重写）调用 Critic/二次 Writer 时，单次生成 JSON 的最大 token 上限。"
          })}
        </div>
      );
    case "ChatAssistant":
      return (
        <div className="settingsAgentCard__params" role="group" aria-label="会话助手参数">
          <span className="settingsAgentParam__label settingsAgentParam__label--block">
            <span className="settingsAgentParam__titleRow">
              <span>会话语气</span>
              <ParamHint text="仅在「简单对话」路径生效：通过系统提示约束回答篇幅与展开程度；深度研究不走此选项。" />
            </span>
          </span>
          <div className="settingsToneRow settingsToneRow--compact">
            {[
              { id: "balanced", label: "均衡" },
              { id: "concise", label: "简洁" },
              { id: "detailed", label: "展开" }
            ].map((opt) => (
              <label key={opt.id} className="settingsToneOption settingsToneOption--compact">
                <input
                  type="radio"
                  name="dialogueToneCard"
                  checked={draft.dialogueTone === opt.id}
                  onChange={() => setDraft((p) => ({ ...p, dialogueTone: opt.id }))}
                />
                <span className="settingsToneOption__main">{opt.label}</span>
              </label>
            ))}
          </div>
          <div className="settingsAgentParam">
            <span className="settingsAgentParam__label">
              <span className="settingsAgentParam__titleRow">
                <span>温度</span>
                <ParamHint text="简单对话时 LLM 的 sampling 温度：越高回答更发散，越低更稳、更确定。与 max_tokens 共同影响回复风格与长度。" />
              </span>
              <span className="settingsAgentParam__val">
                {Number(draft.simpleChatTemperature ?? 0.35).toFixed(2)}
              </span>
            </span>
            <input
              type="range"
              className="settingsRange settingsRange--inCard"
              min={5}
              max={99}
              value={Math.round((draft.simpleChatTemperature ?? 0.35) * 100)}
              onChange={(e) =>
                setDraft((p) => ({ ...p, simpleChatTemperature: Number(e.target.value) / 100 }))
              }
            />
          </div>
          {range("simpleChatMaxTokens", "max_tokens", 512, 4096, {
            step: 128,
            hint: "简单对话路径下模型单次回复允许生成的最大 token 数（上限）；实际还受模型上下文窗口与输入长度限制。"
          })}
        </div>
      );
    default:
      return null;
  }
}

export default function SettingsPage() {
  const [savedHint, setSavedHint] = useState("");
  const [flowModalOpen, setFlowModalOpen] = useState(false);
  const [draft, setDraft] = useState(() => loadAgentPrefs());

  const groups = useMemo(() => {
    const map = new Map(CATALOG.map((c) => [c.id, { ...c, agents: [] }]));
    for (const a of AGENTS) {
      const g = map.get(a.catalogId);
      if (g) g.agents.push(a);
    }
    return CATALOG.map((c) => map.get(c.id)).filter(Boolean);
  }, []);

  const setNick = useCallback((agentId, v) => {
    setDraft((prev) => ({
      ...prev,
      displayNames: { ...prev.displayNames, [agentId]: v }
    }));
  }, []);

  const setHighlight = useCallback((agentId, on) => {
    setDraft((prev) => ({
      ...prev,
      traceHighlight: { ...prev.traceHighlight, [agentId]: on }
    }));
  }, []);

  const save = useCallback(() => {
    saveAgentPrefs(draft);
    setSavedHint("已保存到本机浏览器");
    window.setTimeout(() => setSavedHint(""), 2400);
  }, [draft]);

  const resetDefaults = useCallback(() => {
    const next = createDefaultAgentPrefs();
    setDraft(next);
    saveAgentPrefs(next);
    setSavedHint("已恢复默认并保存");
    window.setTimeout(() => setSavedHint(""), 2400);
  }, []);

  return (
    <div className="settingsPage">
      <header className="settingsPage__hero">
        <div className="settingsPage__heroRow">
          <h1 className="settingsPage__title">多智能体 · 个性化设置</h1>
          <button type="button" className="ghost ghost--small" onClick={() => setFlowModalOpen(true)}>
            查看深度研究管线流程
          </button>
        </div>
        <p className="settingsPage__lead settingsPage__heroLead">
          本系统围绕「<strong>多智能体的智能聊天</strong>」叙事设计。以下按角色分组：每个智能体卡片内除<strong>昵称与进度高亮</strong>外，还包含<strong>该角色在管线中真实用到的参数</strong>（保存后随下次发送生效；服务端与管线内另有钳位）。
        </p>
      </header>

      {flowModalOpen ? (
        <Modal
          wide
          title="深度研究管线流程"
          onClose={() => setFlowModalOpen(false)}
          footer={
            <button type="button" className="send" onClick={() => setFlowModalOpen(false)}>
              关闭
            </button>
          }
        >
          <div className="settingsFlowBody">
            <h3>1. 路由</h3>
            <p>
              用户消息先经总控侧的<strong>对话路由</strong>（可在 Coordinator 卡片中设为自动、强制简单对话或强制深度研究）：简单对话走单模型快路径；深度研究则进入下方多阶段编排。
            </p>
            <h3>2. 深度研究阶段（与后端 trace 一致）</h3>
            <ol>
              <li>
                <strong>planning（Planner）</strong>：拆解子问题与检索计划。
              </li>
              <li>
                <strong>collecting（Researcher / Fetcher）</strong>：按计划采集证据——通常包含知识库向量检索，并按设置与环境变量决定是否补充联网搜索与页面抓取。
              </li>
              <li>
                <strong>reading（Reader）</strong>：对来源正文做结构化阅读，提炼要点与引用线索。
              </li>
              <li>
                <strong>writing（Writer + Coordinator）</strong>：按子问题写各小节；Coordinator 再生成概述与结论。
              </li>
              <li>
                <strong>reviewing（Critic）</strong>：评审草稿，必要时触发补充检索或改写。
              </li>
              <li>
                <strong>done</strong>：合并为最终报告式输出并结束任务。
              </li>
            </ol>
            <h3>3. 阶段顺序示意</h3>
            <pre className="settingsFlowDiagram" aria-label="阶段顺序">
              {`planning → collecting → reading → writing → reviewing → done`}
            </pre>
          </div>
        </Modal>
      ) : null}

      <div className="settingsPage__scroll" aria-label="智能体配置列表">
        {groups.map((g) => (
          <section key={g.id} className="settingsPage__group" aria-labelledby={`g-${g.id}`}>
            <div className="settingsPage__groupHead">
              <h2 id={`g-${g.id}`} className="settingsPage__h2">
                {g.title}
              </h2>
              <p className="settingsPage__groupBlurb">{g.blurb}</p>
            </div>
            <ul className="settingsAgentList">
              {g.agents.map((a) => (
                <li key={a.id} className="settingsAgentCard">
                  <div className="settingsAgentCard__top">
                    <div>
                      <div className="settingsAgentCard__name">{a.name}</div>
                      <div className="settingsAgentCard__role">{a.role}</div>
                    </div>
                    <label className="settingsAgentCard__hl">
                      <input
                        type="checkbox"
                        checked={Boolean(draft.traceHighlight[a.id])}
                        onChange={(e) => setHighlight(a.id, e.target.checked)}
                        disabled={a.id === "ChatAssistant"}
                      />
                      <span className="settingsAgentParam__titleRow">
                        <span>进度中高亮</span>
                        <ParamHint text="在深度研究进度轨迹中，将该智能体相关步骤用高亮样式标出；仅作用于深度研究，「ChatAssistant」不参与轨迹故选项禁用。" />
                      </span>
                    </label>
                  </div>
                  <p className="settingsAgentCard__desc">{a.desc}</p>
                  <label className="settingsAgentCard__nick">
                    <span>显示昵称（可选）</span>
                    <input
                      type="text"
                      className="textInput settingsAgentCard__nickInput"
                      placeholder={`默认显示为 ${a.name}`}
                      value={draft.displayNames[a.id] ?? ""}
                      onChange={(e) => setNick(a.id, e.target.value)}
                      maxLength={24}
                    />
                  </label>
                  <AgentRuntimeControls agentId={a.id} draft={draft} setDraft={setDraft} />
                  {a.id === "ChatAssistant" ? (
                    <p className="settingsPage__muted settingsPage__muted--tight">
                      「进度中高亮」仅作用于深度研究轨迹；语气与温度仅作用于简单对话路径。
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <div className="settingsPage__actions">
        <button type="button" className="send" onClick={save}>
          保存设置
        </button>
        <button type="button" className="ghost" onClick={resetDefaults}>
          恢复默认
        </button>
        {savedHint ? <span className="settingsPage__saved">{savedHint}</span> : null}
      </div>
    </div>
  );
}
