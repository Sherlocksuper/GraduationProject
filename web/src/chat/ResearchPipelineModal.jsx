import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Modal from "../rag/Modal.jsx";
import { apiErrorMessage, apiFetch, clearSessionIfUnauthorized } from "../client.js";

/** 视口内放置悬浮详情，避免底部被裁切；返回 fixed 定位与可用高度 */
function layoutPipelineTooltip(tip) {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const pad = 12;
  const maxW = Math.min(560, Math.max(240, vw - 2 * pad));
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
        mermaid.initialize({ startOnLoad: false, securityLevel: "loose", theme: "neutral" });
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
          将鼠标悬停在流程图<strong>节点</strong>上：课题与知识库参考、检索结果、模型输出等默认<strong>全文</strong>展示，可在弹层内滚动。若单字段极大（极少见），服务端会按上限保护；需要更大上限可设置环境变量
          <code className="pipelineModal__code">RESEARCH_PIPELINE_HINT_MAX_CHARS</code>（默认约 80 万字符）。
        </p>
        {data?.mermaidDiagramKind === "narrative" ? (
          <p className="pipelineModal__hint">
            本图为按子问题归并的叙事结构：收集、阅读、写作在多子问题下以扇出—汇聚表示可并行的分工；悬浮文案按阶段聚合多条
            trace，与单次调用的逐条时间序可能略有差异。
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
                    <div className="pipelineNodeTooltip__v">{tip.inputSummary}</div>
                    <div className="pipelineNodeTooltip__k">输出</div>
                    <div className="pipelineNodeTooltip__v">{tip.outputSummary}</div>
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
