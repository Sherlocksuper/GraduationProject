import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Modal from "../rag/Modal.jsx";
import { apiErrorMessage, apiFetch, clearSessionIfUnauthorized } from "../client.js";

/** 视口内放置悬浮详情，避免底部被裁切；返回 fixed 定位与可用高度 */
function layoutPipelineTooltip(tip) {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const pad = 12;
  const maxW = Math.min(640, Math.max(260, vw - 2 * pad));
  let maxH = Math.min(560, Math.floor(vh * 0.72));
  let left = tip.x + 14;
  left = Math.max(pad, Math.min(left, vw - maxW - pad));
  let top = tip.y + 14;
  if (top + maxH > vh - pad) {
    top = vh - pad - maxH;
  }
  if (top < pad) {
    top = pad;
    maxH = Math.min(maxH, Math.max(160, vh - 2 * pad));
  }
  return { left, top, maxW, maxH };
}

/** 从 Mermaid 渲染后的 g.node id 解析逻辑节点名（如 Mplan、n3） */
function logicalIdFromMermaidSvgGroupId(svgId, hintKeys) {
  const keys = Array.isArray(hintKeys) ? hintKeys : [];
  const m = String(svgId || "").match(/-([A-Za-z_][A-Za-z0-9_]*)-\d+$/);
  if (m && keys.includes(m[1])) return m[1];
  const s = String(svgId || "");
  const hit = keys.find((k) => s === k || s.endsWith(`-${k}`) || s.includes(`-${k}-`));
  return hit || (m ? m[1] : null);
}

/**
 * 将悬停长文拆成「横幅说明 / 角色块 / 普通段落」扁平列表。
 * 与后端 formatLlmMessagesForHint（[ROLE] + ──── 分隔）及中文【…】标题行对齐。
 */
function parsePipelineTipFlat(text) {
  const raw = String(text ?? "");
  if (!raw.trim()) return [{ kind: "plain", text: "—" }];

  const parts = [];
  const megaChunks = raw.split(/\n\n[═─]{8,}\n\n/);

  for (const mega of megaChunks) {
    let rest = mega.trim();
    if (!rest) continue;

    while (rest.length) {
      if (rest.startsWith("【")) {
        const nl = rest.indexOf("\n");
        if (nl === -1) {
          parts.push({ kind: "banner", text: rest });
          rest = "";
        } else {
          parts.push({ kind: "banner", text: rest.slice(0, nl) });
          rest = rest.slice(nl + 1).trimStart();
        }
        continue;
      }

      const roleMatch = rest.match(/^(\[[A-Za-z][A-Za-z0-9_]*\])\s*\n/);
      if (roleMatch) {
        const role = roleMatch[1].slice(1, -1);
        rest = rest.slice(roleMatch[0].length);
        const nextBanner = rest.search(/\n【/);
        const nextRole = rest.search(/\n\[[A-Za-z][A-Za-z0-9_]*\]\n/);
        let cut = rest.length;
        if (nextBanner !== -1) cut = Math.min(cut, nextBanner);
        if (nextRole !== -1) cut = Math.min(cut, nextRole);
        const body = rest.slice(0, cut).trimEnd();
        rest = cut >= rest.length ? "" : rest.slice(cut).replace(/^\n+/, "");
        parts.push({ kind: "role", role, body });
        continue;
      }

      const nextBanner = rest.search(/\n【/);
      const nextRole = rest.search(/\n\[[A-Za-z][A-Za-z0-9_]*\]\n/);
      let cut = rest.length;
      if (nextBanner !== -1) cut = Math.min(cut, nextBanner);
      if (nextRole !== -1) cut = Math.min(cut, nextRole);
      const plain = rest.slice(0, cut).trim();
      rest = cut >= rest.length ? "" : rest.slice(cut).replace(/^\n+/, "");
      if (plain) parts.push({ kind: "plain", text: plain });
    }
  }

  if (!parts.length) parts.push({ kind: "plain", text: raw.trim() || "—" });
  return parts;
}

/** 每个以「【」开头的标题与其后内容组成可折叠一节，直到下一个「【」标题。 */
function groupPipelineTipSections(flat) {
  /** @type {Array<{ kind: "section"; title: string; parts: typeof flat } | { kind: "loose"; part: (typeof flat)[0] }>} */
  const out = [];
  let i = 0;
  while (i < flat.length) {
    if (flat[i].kind === "banner") {
      const title = flat[i].text;
      i++;
      const inner = [];
      while (i < flat.length && flat[i].kind !== "banner") {
        inner.push(flat[i]);
        i++;
      }
      out.push({ kind: "section", title, parts: inner });
    } else {
      out.push({ kind: "loose", part: flat[i] });
      i++;
    }
  }
  return out;
}

function parsePipelineTipText(text) {
  return groupPipelineTipSections(parsePipelineTipFlat(text));
}

function PipelineTipPart({ part, idx }) {
  if (part.kind === "role") {
    return (
      <div key={idx} className="pipelineTipRoleWrap">
        <div className="pipelineTipRoleBar">
          <span className="pipelineTipRolePill">{part.role}</span>
        </div>
        <pre className="pipelineTipRoleBody">{part.body}</pre>
      </div>
    );
  }
  return (
    <pre key={idx} className="pipelineTipPlain">
      {part.text}
    </pre>
  );
}

function PipelineTipRich({ text }) {
  const sections = useMemo(() => parsePipelineTipText(text), [text]);
  return (
    <div className="pipelineTipRich">
      {sections.map((g, i) => {
        if (g.kind === "section") {
          return (
            <details key={i} className="pipelineTipDetails" open>
              <summary className="pipelineTipBanner">{g.title}</summary>
              <div className="pipelineTipSectionBody">
                {g.parts.length ? (
                  g.parts.map((p, j) => <PipelineTipPart key={`${i}-${j}`} part={p} idx={j} />)
                ) : (
                  <div className="pipelineTipSectionEmpty">（本节无正文）</div>
                )}
              </div>
            </details>
          );
        }
        return <PipelineTipPart key={i} part={g.part} idx={i} />;
      })}
    </div>
  );
}

export default function ResearchPipelineModal({ taskId, setUser, onClose }) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [data, setData] = useState(null);
  const [tip, setTip] = useState(null);
  const mermaidWrapRef = useRef(null);
  const tipHideTimerRef = useRef(null);

  const cancelTipHide = useCallback(() => {
    if (tipHideTimerRef.current != null) {
      clearTimeout(tipHideTimerRef.current);
      tipHideTimerRef.current = null;
    }
  }, []);

  const scheduleTipHide = useCallback(() => {
    cancelTipHide();
    tipHideTimerRef.current = setTimeout(() => {
      tipHideTimerRef.current = null;
      setTip(null);
    }, 220);
  }, [cancelTipHide]);

  useEffect(() => {
    let cancel = false;
    (async () => {
      setLoading(true);
      setErr("");
      try {
        const resp = await apiFetch(`/api/chat/research/${encodeURIComponent(taskId)}/pipeline`);
        if (clearSessionIfUnauthorized(resp, setUser)) return;
        const j = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(apiErrorMessage(j, resp.status));
        if (!cancel) setData(j);
      } catch (e) {
        if (!cancel) setErr(e?.message || "加载失败");
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [taskId, setUser]);

  useEffect(() => {
    setTip(null);
    cancelTipHide();
    const wrap = mermaidWrapRef.current;
    if (!data?.mermaid || !wrap) return;
    wrap.innerHTML = "";
    const el = document.createElement("pre");
    el.className = "mermaid";
    el.textContent = data.mermaid;
    wrap.appendChild(el);
    let cancelled = false;
    const cleaners = [];
    const hints = data.diagramNodeHints && typeof data.diagramNodeHints === "object" ? data.diagramNodeHints : {};
    const hintKeys = Object.keys(hints);

    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "loose",
          theme: "neutral",
          flowchart: {
            curve: "basis",
            padding: 10,
            nodeSpacing: 28,
            rankSpacing: 38
          },
          themeVariables: {
            fontSize: "13px",
            fontFamily: "ui-sans-serif, system-ui, sans-serif",
            primaryColor: "#e8eef8",
            primaryTextColor: "#0f172a",
            primaryBorderColor: "#94a3b8",
            lineColor: "#64748b",
            clusterBkg: "#f8fafc",
            titleColor: "#0f172a"
          }
        });
        await mermaid.run({ nodes: [el] });
      } catch (e) {
        if (!cancelled && wrap) {
          wrap.innerHTML = "";
          const pre = document.createElement("pre");
          pre.className = "pipelineMermaidFallback";
          pre.textContent = `流程图渲染失败：${e?.message || e}\n\n---- Mermaid 源码 ----\n${data.mermaid}`;
          wrap.appendChild(pre);
        }
        return;
      }
      if (cancelled || !wrap) return;
      const svg = wrap.querySelector("svg");
      if (!svg || !hintKeys.length) return;

      const groups = svg.querySelectorAll("g.node");
      for (const g of groups) {
        const lid = logicalIdFromMermaidSvgGroupId(g.id, hintKeys);
        if (!lid || !hints[lid]) continue;
        const h = hints[lid];
        const onEnter = (ev) => {
          cancelTipHide();
          setTip({
            lid,
            x: ev.clientX,
            y: ev.clientY,
            title: h.title || "",
            inputSummary: h.inputSummary || "—",
            outputSummary: h.outputSummary || "—"
          });
        };
        const onMove = (ev) => {
          setTip((prev) => (prev && prev.lid === lid ? { ...prev, x: ev.clientX, y: ev.clientY } : prev));
        };
        const onLeave = (ev) => {
          const rt = ev.relatedTarget;
          if (rt instanceof Element && rt.closest && rt.closest("g.node")) return;
          if (rt instanceof Element && rt.closest && rt.closest("#pipelineNodeTooltipRoot")) return;
          scheduleTipHide();
        };
        g.addEventListener("pointerenter", onEnter);
        g.addEventListener("pointermove", onMove);
        g.addEventListener("pointerleave", onLeave);
        cleaners.push(() => {
          g.removeEventListener("pointerenter", onEnter);
          g.removeEventListener("pointermove", onMove);
          g.removeEventListener("pointerleave", onLeave);
        });
      }
    })();

    return () => {
      cancelled = true;
      cancelTipHide();
      for (const fn of cleaners) fn();
      cleaners.length = 0;
      wrap.innerHTML = "";
    };
  }, [data?.mermaid, data?.diagramNodeHints, cancelTipHide, scheduleTipHide]);

  return (
    <Modal title="多智能体执行流程" onClose={onClose}>
      <div className="pipelineModal">
        <p className="pipelineModal__meta">
          任务 ID：<code className="pipelineModal__code">{taskId}</code>
          {data?.status ? (
            <>
              {" "}
              · 状态：<strong>{data.status}</strong>
            </>
          ) : null}
          {typeof data?.nodeCount === "number" ? (
            <>
              {" "}
              · 步骤数：<strong>{data.nodeCount}</strong>
            </>
          ) : null}
        </p>
        <p className="pipelineModal__hint">
          <strong>怎么读图：</strong>箭头表示先后顺序；「汇聚」表示多子问题并行后再合并；<strong>整稿总编</strong>在审稿之后通读 Markdown（默认开启，可用环境变量{" "}
          <code className="pipelineModal__code">RESEARCH_GLOBAL_PASS=0</code> 关闭）。节点为阶段说明，完整输入/输出请悬停查看。
        </p>
        <ul className="pipelineModal__legend pipelineModal__legend--verbose" aria-label="图例">
          <li>
            <strong>课题起点</strong>：用户深度研究主题及对话上文，作为整条管线的输入。
          </li>
          <li>
            <strong>收集（Researcher / Fetcher）</strong>：按子问题做知识库检索与网页检索、抓取与清洗，为阅读阶段准备材料。
          </li>
          <li>
            <strong>Reader</strong>：针对每个子问题阅读来源正文，输出带 URL 的证据要点（bullets）。
          </li>
          <li>
            <strong>Writer</strong>：按子问题把要点写成报告小节（JSON），再拼入最终 Markdown。
          </li>
          <li>
            <strong>摘要与总括（Coordinator）</strong>：在诸小节完成后生成开篇综述与结尾结论。
          </li>
          <li>
            <strong>Critic</strong>：检查来源与表述风险，必要时补搜或改写小节。
          </li>
          <li>
            <strong>整稿总编（GlobalEditor）</strong>：通读整篇一稿，合并跨节重复、理顺综述/正文/结论分工。
          </li>
        </ul>
        <p className="pipelineModal__hint pipelineModal__hint--tight">
          鼠标悬停在<strong>节点</strong>上可查看该步的模型输入/输出全文（过长时服务端会截断保护）。可调{" "}
          <code className="pipelineModal__code">RESEARCH_PIPELINE_HINT_MAX_CHARS</code>。
        </p>
        {data?.mermaidDiagramKind === "narrative" ? (
          <p className="pipelineModal__hint pipelineModal__hint--tight">
            叙事图：收集/阅读/写作在多子问题下为扇出—汇聚；与严格时间序 trace 可能略有差异。
          </p>
        ) : null}
        {data?.mermaidTruncated ? (
          <p className="pipelineModal__warn">
            线性流程图仅展示前若干节点；未画出的步骤无悬浮说明，但步骤总数已在上文标出。
          </p>
        ) : null}

        {loading ? <p className="pipelineModal__hint">加载中…</p> : null}
        {err ? <p className="pipelineModal__err">{err}</p> : null}

        {!loading && !err ? (
          <div className="pipelineModal__mermaidWrap" ref={mermaidWrapRef} aria-label="Mermaid 流程图" />
        ) : null}

        {tip && typeof document !== "undefined"
          ? createPortal(
              (() => {
                const { left, top, maxW, maxH } = layoutPipelineTooltip(tip);
                return (
                  <div
                    id="pipelineNodeTooltipRoot"
                    className="pipelineNodeTooltip"
                    style={{
                      left,
                      top,
                      width: maxW,
                      maxHeight: maxH,
                      zIndex: 13050
                    }}
                    role="tooltip"
                    onPointerEnter={cancelTipHide}
                    onPointerLeave={() => {
                      cancelTipHide();
                      setTip(null);
                    }}
                  >
                    {tip.title ? <div className="pipelineNodeTooltip__title">{tip.title}</div> : null}
                    <div className="pipelineNodeTooltip__k">输入</div>
                    <div className="pipelineNodeTooltip__v pipelineNodeTooltip__v--rich">
                      <PipelineTipRich text={tip.inputSummary} />
                    </div>
                    <div className="pipelineNodeTooltip__k">输出</div>
                    <div className="pipelineNodeTooltip__v pipelineNodeTooltip__v--rich">
                      <PipelineTipRich text={tip.outputSummary} />
                    </div>
                  </div>
                );
              })(),
              document.body
            )
          : null}
      </div>
    </Modal>
  );
}
