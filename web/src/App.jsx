import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

function newId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatTime(ts) {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function formatDateTime(ts) {
  try {
    const d = new Date(ts);
    return d.toLocaleString([], {
      hour: "2-digit",
      minute: "2-digit",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
  } catch {
    return "";
  }
}

function traceSummary(payload) {
  const p = payload || {};
  if (p.error) return `error: ${String(p.error)}`;
  if (p.msg) return String(p.msg);
  if (p.query) return `query: ${String(p.query)}`;
  if (p.provider) return `provider: ${String(p.provider)}`;
  if (p.url) return `url: ${String(p.url)}`;
  if (typeof p.resultCount === "number") return `results: ${p.resultCount}`;
  if (Array.isArray(p.urls) && p.urls.length) return `urls: ${p.urls.length}`;
  if (typeof p.chars === "number") return `chars: ${p.chars}`;
  if (Array.isArray(p.sources) && p.sources.length) return `sources: ${p.sources.length}`;
  if (typeof p.sourceCount === "number") return `sources: ${p.sourceCount}`;
  return "";
}

function isNonEmptyString(s) {
  return typeof s === "string" && s.trim().length > 0;
}

export default function App() {
  const [view, setView] = useState("chat"); // chat | research
  const [sessionId] = useState(() => newId());
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState(() => [
    { id: newId(), role: "assistant", content: "你好！请输入你的问题。", ts: Date.now() }
  ]);
  const [sending, setSending] = useState(false);
  const listRef = useRef(null);

  const [topic, setTopic] = useState("");
  const [creating, setCreating] = useState(false);
  const [taskId, setTaskId] = useState("");
  const [task, setTask] = useState(null);
  const [reportMd, setReportMd] = useState("");
  const [researchError, setResearchError] = useState("");
  const [showTrace, setShowTrace] = useState(false);
  const [expandedTraceIdx, setExpandedTraceIdx] = useState(-1);

  const canSend = useMemo(() => input.trim().length > 0 && !sending, [input, sending]);

  async function send() {
    const question = input.trim();
    if (!question || sending) return;

    setSending(true);
    setInput("");
    const userMsg = { id: newId(), role: "user", content: question, ts: Date.now() };
    setMessages((prev) => [...prev, userMsg]);

    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, question })
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data?.error || `HTTP ${resp.status}`);
      }
      setMessages((prev) => [
        ...prev,
        { id: newId(), role: "assistant", content: data.answer, ts: Date.now() }
      ]);
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        {
          id: newId(),
          role: "assistant",
          content: `请求失败：${e?.message || "未知错误"}`,
          ts: Date.now()
        }
      ]);
    } finally {
      setSending(false);
      queueMicrotask(() => {
        const el = listRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const canCreate = useMemo(() => topic.trim().length > 0 && !creating, [topic, creating]);

  async function createResearch() {
    const t = topic.trim();
    if (!t || creating) return;
    setCreating(true);
    setResearchError("");
    setTaskId("");
    setTask(null);
    setReportMd("");
    setShowTrace(false);
    setExpandedTraceIdx(-1);
    try {
      const resp = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: t })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
      setTaskId(String(data.taskId || ""));
    } catch (e) {
      setResearchError(e?.message || "创建任务失败");
    } finally {
      setCreating(false);
    }
  }

  useEffect(() => {
    if (!taskId) return;
    let stopped = false;
    let timer = null;

    async function tick() {
      try {
        const resp = await fetch(`/api/research/${encodeURIComponent(taskId)}`);
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
        if (stopped) return;
        setTask(data.task || null);

        const status = data?.task?.status;
        if (status === "done") {
          const r = await fetch(`/api/research/${encodeURIComponent(taskId)}/artifact/report.md`);
          const text = await r.text();
          if (stopped) return;
          setReportMd(text);
        }
        if (status === "done" || status === "failed") {
          if (timer) clearInterval(timer);
          timer = null;
        }
      } catch (e) {
        if (stopped) return;
        setResearchError(e?.message || "轮询失败");
      }
    }

    tick();
    timer = setInterval(tick, 1000);
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
    };
  }, [taskId]);

  return (
    <div className="app">
      <header className="header">
        <div className="titleRow">
          <div className="title">DeepResearch</div>
          <div className="headerRight">
            <nav className="tabs" aria-label="功能切换">
              <button
                className={`tab ${view === "chat" ? "tab--active" : ""}`}
                onClick={() => setView("chat")}
                type="button"
              >
                Chat
              </button>
              <button
                className={`tab ${view === "research" ? "tab--active" : ""}`}
                onClick={() => setView("research")}
                type="button"
              >
                Research
              </button>
            </nav>
            <div className="badge">ReAct-ready</div>
          </div>
        </div>
        <div className="subtitle">
          {view === "chat" ? (
            <>Session · {sessionId.slice(0, 8)}</>
          ) : (
            <>Research Task · {taskId ? taskId.slice(0, 10) : "—"}</>
          )}
        </div>
      </header>

      <main className="main">
        {view === "chat" ? (
          <>
            <div className="chat" ref={listRef} aria-label="聊天记录">
              {messages.map((m) => (
                <div key={m.id} className={`msg msg--${m.role}`}>
                  <div className="avatar" aria-hidden="true">
                    {m.role === "user" ? "你" : "AI"}
                  </div>
                  <div className="content">
                    <div className="meta">
                      <span className="name">{m.role === "user" ? "你" : "研究助理"}</span>
                      <span className="time">{m.ts ? formatTime(m.ts) : ""}</span>
                    </div>
                    <div className={`bubble markdown markdown--${m.role}`}>
                      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                        {m.content}
                      </ReactMarkdown>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="composer">
              <textarea
                className="input"
                placeholder="输入问题，Enter 发送，Shift+Enter 换行"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                rows={2}
              />
              <button className="send" onClick={send} disabled={!canSend}>
                {sending ? "发送中…" : "发送"}
              </button>
            </div>
          </>
        ) : (
          <>
            <section className="panel" aria-label="研究任务">
              <div className="panelHeader">
                <div className="panelTitle">Research Task</div>
                <div className="panelHint">Planner → Search → Fetch → Reader → Writer</div>
              </div>

              <div className="formRow">
                <input
                  className="textInput"
                  placeholder="输入研究主题，例如：AI Agent 在软件工程中的应用与风险（未来3-5年）"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                />
                <button className="send" onClick={createResearch} disabled={!canCreate}>
                  {creating ? "创建中…" : "开始研究"}
                </button>
              </div>

              {researchError ? <div className="error">{researchError}</div> : null}

              <div className="statusGrid">
                <div className="kv">
                  <div className="k">状态</div>
                  <div className="v">{task?.status || (taskId ? "loading…" : "—")}</div>
                </div>
                <div className="kv">
                  <div className="k">创建时间</div>
                  <div className="v">{task?.createdAt ? formatDateTime(task.createdAt) : "—"}</div>
                </div>
                <div className="kv">
                  <div className="k">Artifacts</div>
                  <div className="v">{Array.isArray(task?.artifacts) ? task.artifacts.join(", ") : "—"}</div>
                </div>
                <div className="kv">
                  <div className="k">Trace</div>
                  <div className="v">{Array.isArray(task?.trace) ? `${task.trace.length} events` : "—"}</div>
                </div>
              </div>

              {task?.error ? <div className="error">失败：{task.error}</div> : null}

              {taskId ? (
                <div className="actions">
                  <button className="ghost" type="button" onClick={() => navigator.clipboard?.writeText(taskId)}>
                    复制 taskId
                  </button>
                  <button className="ghost" type="button" onClick={() => setShowTrace((v) => !v)} disabled={!task?.trace}>
                    {showTrace ? "隐藏 trace" : "查看 trace"}
                  </button>
                  <a className="ghost" href={`/api/research/${encodeURIComponent(taskId)}/artifact/report.md`} target="_blank" rel="noreferrer">
                    打开 report.md
                  </a>
                  <a className="ghost" href={`/api/research/${encodeURIComponent(taskId)}/artifact/notes.json`} target="_blank" rel="noreferrer">
                    打开 notes.json
                  </a>
                </div>
              ) : null}

              {showTrace && Array.isArray(task?.trace) ? (
                <div className="trace">
                  {task.trace.slice(-80).map((e, idx) => (
                    <button
                      key={idx}
                      className={`traceRow ${expandedTraceIdx === idx ? "traceRow--expanded" : ""}`}
                      type="button"
                      onClick={() => setExpandedTraceIdx((cur) => (cur === idx ? -1 : idx))}
                      title="点击展开/收起详情"
                    >
                      <div className="traceTs">{String(e.ts || "").slice(11, 19)}</div>
                      <div className="traceMain">
                        <span className="traceTag">{e.stage}</span>
                        <span className="traceAgent">{e.agent}</span>
                        <span className="traceType">{e.type}</span>
                        {e?.payload?.subquestionId ? (
                          <span className="traceSubq">{e.payload.subquestionId}</span>
                        ) : null}
                        {traceSummary(e?.payload) ? (
                          <span className="traceSummary">{traceSummary(e.payload)}</span>
                        ) : null}
                      </div>
                      {expandedTraceIdx === idx ? (
                        <pre className="traceDetail">
                          {(() => {
                            const p = e?.payload || {};
                            const preview = Array.isArray(p.resultsPreview) ? p.resultsPreview : [];
                            const urls = Array.isArray(p.urls) ? p.urls : [];
                            const hasPreview = preview.some((x) => x && isNonEmptyString(x.url));

                            if (!hasPreview && !urls.length) {
                              return JSON.stringify(p, null, 2);
                            }

                            return (
                              <>
                                {p.provider ? <div className="traceKV">provider: {String(p.provider)}</div> : null}
                                {p.query ? <div className="traceKV">query: {String(p.query)}</div> : null}
                                {typeof p.resultCount === "number" ? (
                                  <div className="traceKV">resultCount: {p.resultCount}</div>
                                ) : null}

                                {hasPreview ? (
                                  <details open>
                                    <summary>搜索结果预览（{preview.length}）</summary>
                                    <div className="traceList">
                                      {preview.map((r, i2) => (
                                        <div className="traceItem" key={i2}>
                                          <div className="traceItemTitle">
                                            {r.source ? <span className="traceMiniTag">{r.source}</span> : null}
                                            <a href={r.url} target="_blank" rel="noreferrer">
                                              {r.title || r.url}
                                            </a>
                                          </div>
                                          {r.snippet ? <div className="traceItemSnippet">{r.snippet}</div> : null}
                                        </div>
                                      ))}
                                    </div>
                                  </details>
                                ) : null}

                                {urls.length ? (
                                  <details>
                                    <summary>URL 列表（{urls.length}，点击展开）</summary>
                                    <div className="traceList">
                                      {urls.map((u, i3) => (
                                        <div className="traceItem" key={i3}>
                                          <a href={u} target="_blank" rel="noreferrer">
                                            {u}
                                          </a>
                                        </div>
                                      ))}
                                    </div>
                                  </details>
                                ) : null}

                                <details>
                                  <summary>payload JSON（点击展开）</summary>
                                  <pre className="traceJson">{JSON.stringify(p, null, 2)}</pre>
                                </details>
                              </>
                            );
                          })()}
                        </pre>
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </section>

            <section className="chat" aria-label="研究报告">
              {task?.status === "done" && reportMd ? (
                <div className="markdown markdown--report">
                  <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{reportMd}</ReactMarkdown>
                </div>
              ) : (
                <div className="empty">
                  <div className="emptyTitle">{taskId ? "正在生成报告…" : "创建任务后，这里会显示报告。"}</div>
                  <div className="emptyHint">
                    中期版本会先产出结构化初稿；下一步我们会接入检索工具，为每段补齐引用与核验。
                  </div>
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

