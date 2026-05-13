import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiFetch, apiErrorMessage, clearSessionIfUnauthorized, jsonHeaders } from "../client.js";
import { clip, formatDateTime } from "../format.js";
import { useAgentPrefs } from "../agentPreferences.js";
import Modal from "./Modal.jsx";
import { isLikelyTextFile, readFilesAsUtf8MergedWithProgress } from "./readTextFiles.js";

export default function RagDetailPage({ setUser, onHeaderTitle }) {
  const { id: rawId } = useParams();
  const id = String(rawId || "").trim();
  const agentPrefs = useAgentPrefs();

  const [meta, setMeta] = useState(null);
  const [chunks, setChunks] = useState([]);
  const [loadErr, setLoadErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState("");
  const [question, setQuestion] = useState("");
  /** @type {Array<{ chunkIndex?: number, content: string, score: number }>} */
  const [hits, setHits] = useState([]);
  /** 检索弹窗内提示（不占用页顶 hint） */
  const [retrievalFeedback, setRetrievalFeedback] = useState("");

  const [modal, setModal] = useState(null);
  const [collectionName, setCollectionName] = useState("");
  const [chunkContent, setChunkContent] = useState("");
  const [editChunkRow, setEditChunkRow] = useState(null);
  const [bulkText, setBulkText] = useState("");
  const [bulkPendingFiles, setBulkPendingFiles] = useState([]);
  /** 弹窗内文件选择反馈（避免 setHint 只在遮罩后可见） */
  const [bulkFilePickFeedback, setBulkFilePickFeedback] = useState("");
  const [bulkChunkSize, setBulkChunkSize] = useState(800);
  const [bulkOverlap, setBulkOverlap] = useState(120);

  /** 列表搜索（防抖后走服务端 q） */
  const [chunkSearch, setChunkSearch] = useState("");
  const [searchDebounced, setSearchDebounced] = useState("");
  const [chunkPage, setChunkPage] = useState(1);
  const [chunkPageSize, setChunkPageSize] = useState(20);
  const [chunkTotal, setChunkTotal] = useState(0);
  const [chunkLoadErr, setChunkLoadErr] = useState("");
  const [chunksLoading, setChunksLoading] = useState(false);
  /** @type {{ message: string, percent: number | null } | null} */
  const [progress, setProgress] = useState(null);
  /** 懒加载向量 JSON：rowId -> { loading?, data?, error? } */
  const [vecByRow, setVecByRow] = useState({});

  const [newChunkFiles, setNewChunkFiles] = useState([]);
  const [editChunkFiles, setEditChunkFiles] = useState([]);

  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const selectAllRef = useRef(null);
  const bulkFileRef = useRef(null);
  const chunkFileRef = useRef(null);
  const chunkEditFileRef = useRef(null);

  const allFilteredSelected =
    chunks.length > 0 && chunks.every((r) => selectedIds.has(r.rowId));
  const someFilteredSelected = chunks.some((r) => selectedIds.has(r.rowId));

  useEffect(() => {
    const el = selectAllRef.current;
    if (el && "indeterminate" in el) {
      el.indeterminate = someFilteredSelected && !allFilteredSelected;
    }
  }, [someFilteredSelected, allFilteredSelected]);

  useEffect(() => {
    setChunkSearch("");
    setSearchDebounced("");
    setChunkPage(1);
    setSelectedIds(new Set());
    setVecByRow({});
  }, [id]);

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(chunkSearch.trim()), 300);
    return () => clearTimeout(t);
  }, [chunkSearch]);

  useEffect(() => {
    setChunkPage(1);
  }, [searchDebounced, id]);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [chunkPage, searchDebounced]);

  const loadMeta = useCallback(async () => {
    if (!id) return;
    setLoadErr("");
    try {
      const r1 = await apiFetch(`/api/rag/collections/${encodeURIComponent(id)}`);
      if (clearSessionIfUnauthorized(r1, setUser)) return;
      const d1 = await r1.json().catch(() => ({}));
      if (!r1.ok) {
        setLoadErr(apiErrorMessage(d1, r1.status));
        setMeta(null);
        return;
      }
      setMeta(d1.collection || null);
      setLoadErr("");
    } catch (e) {
      setLoadErr(e?.message || "加载失败");
      setMeta(null);
    }
  }, [id, setUser]);

  const loadChunks = useCallback(async () => {
    if (!id) return;
    setChunkLoadErr("");
    setChunksLoading(true);
    try {
      const qs = new URLSearchParams({
        page: String(chunkPage),
        pageSize: String(chunkPageSize)
      });
      if (searchDebounced) qs.set("q", searchDebounced);
      const r2 = await apiFetch(`/api/rag/collections/${encodeURIComponent(id)}/chunks?${qs}`);
      if (clearSessionIfUnauthorized(r2, setUser)) return;
      const d2 = await r2.json().catch(() => ({}));
      if (!r2.ok) {
        setChunkLoadErr(apiErrorMessage(d2, r2.status));
        setChunks([]);
        setChunkTotal(0);
        return;
      }
      setChunks(Array.isArray(d2.chunks) ? d2.chunks : []);
      setChunkTotal(Number(d2.total) || 0);
    } catch (e) {
      setChunkLoadErr(e?.message || "分块列表加载失败");
      setChunks([]);
      setChunkTotal(0);
    } finally {
      setChunksLoading(false);
    }
  }, [id, chunkPage, chunkPageSize, searchDebounced, setUser]);

  const refreshMetaAndChunks = useCallback(async () => {
    await Promise.all([loadMeta(), loadChunks()]);
  }, [loadMeta, loadChunks]);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    loadChunks();
  }, [loadChunks]);

  const maxPage = Math.max(1, Math.ceil(chunkTotal / chunkPageSize) || 1);
  useEffect(() => {
    if (chunkTotal > 0 && chunkPage > maxPage) {
      setChunkPage(maxPage);
    }
  }, [chunkPage, chunkTotal, chunkPageSize, maxPage]);

  useEffect(() => {
    onHeaderTitle?.(meta?.name || "");
    return () => onHeaderTitle?.("");
  }, [meta?.name, onHeaderTitle]);

  function closeModal() {
    if (busy) return;
    setModal(null);
    setChunkContent("");
    setEditChunkRow(null);
    setBulkText("");
    setBulkPendingFiles([]);
    setBulkFilePickFeedback("");
    setNewChunkFiles([]);
    setEditChunkFiles([]);
    setProgress(null);
  }

  useEffect(() => {
    if (modal !== "retrieval") {
      setRetrievalFeedback("");
      setHits([]);
    }
  }, [modal]);

  async function saveCollectionName() {
    const name = collectionName.trim();
    if (!id || !name) return;
    setBusy(true);
    setHint("");
    try {
      const resp = await apiFetch(`/api/rag/collections/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({ name })
      });
      if (clearSessionIfUnauthorized(resp, setUser)) return;
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setHint(apiErrorMessage(data, resp.status));
        return;
      }
      setMeta(data.collection || null);
      onHeaderTitle?.(data.collection?.name || "");
      closeModal();
      setHint("知识库名称已更新。");
    } catch (e) {
      setHint(e?.message || "请求失败");
    } finally {
      setBusy(false);
    }
  }

  async function submitNewChunk() {
    if (!id) return;
    let content = chunkContent.trim();
    setBusy(true);
    setHint("");
    try {
      if (newChunkFiles.length) {
        setProgress({ message: "正在读取待导入文件…", percent: null });
        const merged = await readFilesAsUtf8MergedWithProgress(newChunkFiles, (r) =>
          setProgress({ message: "正在读取待导入文件…", percent: Math.round(r * 100) })
        );
        content = content ? `${content}\n\n${merged}` : merged;
      }
      if (!content.trim()) {
        setHint("请输入文本内容或选择文件。");
        return;
      }
      setProgress({ message: "正在向量化并保存…", percent: null });
      const resp = await apiFetch(`/api/rag/collections/${encodeURIComponent(id)}/chunks`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ content })
      });
      if (clearSessionIfUnauthorized(resp, setUser)) return;
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const extra = data?.message ? ` ${data.message}` : "";
        setHint(`${apiErrorMessage(data, resp.status)}${extra}`);
        return;
      }
      closeModal();
      setVecByRow({});
      await refreshMetaAndChunks();
      setSelectedIds(new Set());
      setHint("已新增分块并完成向量化。");
    } catch (e) {
      setHint(e?.message || "请求失败");
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }

  async function submitEditChunk() {
    if (!id || !editChunkRow) return;
    let content = chunkContent.trim();
    setBusy(true);
    setHint("");
    try {
      if (editChunkFiles.length) {
        setProgress({ message: "正在读取待导入文件…", percent: null });
        const merged = await readFilesAsUtf8MergedWithProgress(editChunkFiles, (r) =>
          setProgress({ message: "正在读取待导入文件…", percent: Math.round(r * 100) })
        );
        content = content ? `${content}\n\n${merged}` : merged;
      }
      if (!content.trim()) {
        setHint("请输入文本内容或选择文件。");
        return;
      }
      setProgress({ message: "正在向量化并保存…", percent: null });
      const resp = await apiFetch(
        `/api/rag/collections/${encodeURIComponent(id)}/chunks/${encodeURIComponent(editChunkRow.rowId)}`,
        {
          method: "PUT",
          headers: jsonHeaders,
          body: JSON.stringify({ content })
        }
      );
      if (clearSessionIfUnauthorized(resp, setUser)) return;
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const extra = data?.message ? ` ${data.message}` : "";
        setHint(`${apiErrorMessage(data, resp.status)}${extra}`);
        return;
      }
      const editedRowId = editChunkRow.rowId;
      closeModal();
      setVecByRow((prev) => {
        const n = { ...prev };
        delete n[editedRowId];
        return n;
      });
      await refreshMetaAndChunks();
      setHint("分块已更新并重新向量化。");
    } catch (e) {
      setHint(e?.message || "请求失败");
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }

  async function deleteChunk(row) {
    if (!id || !row?.rowId) return;
    if (!window.confirm("确定删除该分块？")) return;
    setBusy(true);
    setHint("");
    try {
      const resp = await apiFetch(
        `/api/rag/collections/${encodeURIComponent(id)}/chunks/${encodeURIComponent(row.rowId)}`,
        { method: "DELETE" }
      );
      if (clearSessionIfUnauthorized(resp, setUser)) return;
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setHint(apiErrorMessage(data, resp.status));
        return;
      }
      setVecByRow({});
      await refreshMetaAndChunks();
      setSelectedIds(new Set());
      setHint("已删除分块。");
    } catch (e) {
      setHint(e?.message || "请求失败");
    } finally {
      setBusy(false);
    }
  }

  function toggleRowSelected(rowId) {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      if (n.has(rowId)) n.delete(rowId);
      else n.add(rowId);
      return n;
    });
  }

  function toggleSelectAllFiltered() {
    const ids = chunks.map((r) => r.rowId);
    setSelectedIds((prev) => {
      const n = new Set(prev);
      const allOn = ids.length > 0 && ids.every((rid) => n.has(rid));
      if (allOn) ids.forEach((rid) => n.delete(rid));
      else ids.forEach((rid) => n.add(rid));
      return n;
    });
  }

  /** @param {{ onResult?: (r: { accepted: File[]; rejected: File[] }) => void }} [opts] */
  function addTextFilesToList(ev, setFileList, opts) {
    const input = ev.target;
    // 必须先拷贝 File[]：清空 value 会使 FileList 失效，否则后续 length 为 0、界面无反应
    const all = Array.from(input.files || []);
    input.value = "";
    if (!all.length) return;
    const accepted = all.filter(isLikelyTextFile);
    const rejected = all.filter((f) => !isLikelyTextFile(f));
    opts?.onResult?.({ accepted, rejected });
    if (!accepted.length) {
      if (!opts?.onResult) {
        setHint("未识别到支持的文本类文件（如 .txt、.md、.json 等）");
      }
      return;
    }
    setFileList((prev) => [...prev, ...accepted]);
  }

  function clipFileNames(files, maxNames = 4) {
    const names = files.map((f) => f.name);
    if (names.length <= maxNames) return names.join("、");
    return `${names.slice(0, maxNames).join("、")} 等 ${names.length} 个`;
  }

  function formatBytes(n) {
    const b = Math.max(0, Number(n) || 0);
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  }

  function onBulkFilesPicked(ev) {
    addTextFilesToList(ev, setBulkPendingFiles, {
      onResult: ({ accepted, rejected }) => {
        const parts = [];
        if (accepted.length) {
          parts.push(`已加入 ${accepted.length} 个文件：${clipFileNames(accepted)}。`);
        }
        if (rejected.length) {
          parts.push(`未加入（需 .txt / .md 等纯文本）：${clipFileNames(rejected)}。`);
        }
        setBulkFilePickFeedback(parts.join(""));
      }
    });
  }

  async function loadChunkEmbedding(rowId) {
    if (!id) return;
    let shouldLoad = true;
    setVecByRow((prev) => {
      if (prev[rowId]?.loading || prev[rowId]?.data !== undefined) {
        shouldLoad = false;
        return prev;
      }
      return { ...prev, [rowId]: { loading: true } };
    });
    if (!shouldLoad) return;
    try {
      const resp = await apiFetch(
        `/api/rag/collections/${encodeURIComponent(id)}/chunks/${encodeURIComponent(rowId)}`
      );
      if (clearSessionIfUnauthorized(resp, setUser)) return;
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setVecByRow((prev) => ({
          ...prev,
          [rowId]: { loading: false, error: apiErrorMessage(data, resp.status) }
        }));
        return;
      }
      const emb = data.chunk?.embedding;
      setVecByRow((prev) => ({
        ...prev,
        [rowId]: { loading: false, data: Array.isArray(emb) ? emb : [] }
      }));
    } catch (e) {
      setVecByRow((prev) => ({
        ...prev,
        [rowId]: { loading: false, error: e?.message || "加载失败" }
      }));
    }
  }

  async function batchDeleteChunks() {
    const ids = [...selectedIds];
    if (!id || !ids.length) return;
    if (!window.confirm(`确定删除选中的 ${ids.length} 条分块？`)) return;
    setBusy(true);
    setHint("");
    try {
      const resp = await apiFetch(`/api/rag/collections/${encodeURIComponent(id)}/chunks/batch-delete`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ rowIds: ids })
      });
      if (clearSessionIfUnauthorized(resp, setUser)) return;
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setHint(apiErrorMessage(data, resp.status));
        return;
      }
      setVecByRow({});
      await refreshMetaAndChunks();
      setSelectedIds(new Set());
      setHint(`已批量删除 ${data.deleted ?? ids.length} 条分块。`);
    } catch (e) {
      setHint(e?.message || "请求失败");
    } finally {
      setBusy(false);
    }
  }

  async function submitBulkIngest() {
    if (!id) return;
    setBusy(true);
    setHint("");
    try {
      let mergedFromFiles = "";
      if (bulkPendingFiles.length) {
        setProgress({ message: "正在读取并合并文件…", percent: null });
        mergedFromFiles = await readFilesAsUtf8MergedWithProgress(bulkPendingFiles, (r) =>
          setProgress({ message: "正在读取并合并文件…", percent: Math.round(r * 100) })
        );
      }
      const manual = String(bulkText || "").trim();
      const fullText = [manual, mergedFromFiles].filter(Boolean).join("\n\n");
      if (!fullText.trim()) {
        setHint("请在「全文」中输入内容，或至少选择一个文件。");
        return;
      }
      setProgress({ message: "正在上传、分块并向量化（可能较久）…", percent: null });
      const resp = await apiFetch(`/api/rag/collections/${encodeURIComponent(id)}/ingest`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          text: fullText,
          chunkSize: bulkChunkSize,
          overlap: bulkOverlap
        })
      });
      if (clearSessionIfUnauthorized(resp, setUser)) return;
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const extra = data?.message ? ` ${data.message}` : "";
        setHint(`${apiErrorMessage(data, resp.status)}${extra}`);
        return;
      }
      closeModal();
      setChunkPage(1);
      setVecByRow({});
      await refreshMetaAndChunks();
      setSelectedIds(new Set());
      setHint(`批量导入完成，共 ${data.chunkCount ?? 0} 个分块（已覆盖原分块）。`);
    } catch (e) {
      setHint(e?.message || "请求失败");
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }

  async function runQuery() {
    const q = question.trim();
    if (!id || !q) {
      setRetrievalFeedback("请输入检索问题。");
      return;
    }
    setBusy(true);
    setRetrievalFeedback("");
    try {
      const resp = await apiFetch(`/api/rag/collections/${encodeURIComponent(id)}/query`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          question: q,
          topK: 8,
          minScore: Number(agentPrefs.ragMinScore) || 0
        })
      });
      if (clearSessionIfUnauthorized(resp, setUser)) return;
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const extra = data?.message ? ` ${data.message}` : "";
        setRetrievalFeedback(`${apiErrorMessage(data, resp.status)}${extra}`);
        setHits([]);
        return;
      }
      setHits(Array.isArray(data.hits) ? data.hits : []);
      const thr = Number(data.minScore) || 0;
      if (data.belowMinScore && thr > 0) {
        const b =
          data.bestScore != null && Number.isFinite(Number(data.bestScore))
            ? (Number(data.bestScore) * 100).toFixed(1)
            : "—";
        const m = (thr * 100).toFixed(1);
        setRetrievalFeedback(
          `最高相似度 ${b}% 低于当前阈值 ${m}%（「设置 → Researcher → RAG 最低相似度」）。与聊天/深度研究一致：不展示命中、整轮不注入 RAG。`
        );
      } else if (data.hits?.length) {
        setRetrievalFeedback(`命中 ${data.hits.length} 条。`);
      } else {
        setRetrievalFeedback("未命中分块。");
      }
    } catch (e) {
      setHits([]);
      setRetrievalFeedback(e?.message || "请求失败");
    } finally {
      setBusy(false);
    }
  }

  if (!id) {
    return (
      <div className="ragPage">
        <p className="error">无效的知识库 ID。</p>
        <Link to="/rag" className="authLinkBtn">
          返回列表
        </Link>
      </div>
    );
  }

  if (loadErr) {
    return (
      <div className="ragPage">
        <p className="error">{loadErr}</p>
        <Link to="/rag" className="authLinkBtn">
          返回列表
        </Link>
      </div>
    );
  }

  return (
    <div className="ragPage ragPage--detail">
      <div className="ragDetail__surface">
        <div className="ragDetail__top">
          <Link to="/rag" className="ragDetail__back">
            ← 返回知识库列表
          </Link>
          {meta ? (
            <div className="ragDetail__meta ragDetail__meta--plain">
              <div className="ragDetail__titleRow">
                <div className="ragDetail__titleMain">
                  <h1 className="ragPage__h1 ragDetail__name">{meta.name}</h1>
                  <span className="ragDetail__statsInline">
                    （创建时间 {formatDateTime(meta.createdAt)} · 向量数量 {meta.chunkCount ?? 0} · 向量模型{" "}
                    <code className="ragDetail__statsCode">{meta.embeddingModel || "—"}</code>）
                  </span>
                </div>
                <div className="ragDetail__titleActions">
                  <button
                    type="button"
                    className="ghost ghost--small"
                    disabled={busy}
                    onClick={() => {
                      setCollectionName(meta.name || "");
                      setModal("collection");
                    }}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="ghost ghost--small"
                    disabled={busy}
                    onClick={() => {
                      setRetrievalFeedback("");
                      setModal("retrieval");
                    }}
                  >
                    检索测试
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <p className="authHint">加载中…</p>
          )}
        </div>

        {progress ? (
          <div className="ragProgress" role="status" aria-live="polite">
            <p className="ragProgress__msg">{progress.message}</p>
            <div
              className={`ragProgress__track${progress.percent == null ? " ragProgress__track--indeterminate" : ""}`}
            >
              <div
                className="ragProgress__bar"
                style={progress.percent != null ? { width: `${progress.percent}%` } : undefined}
              />
            </div>
          </div>
        ) : null}

        <div className="ragCrudToolbar ragCrudToolbar--compact ragCrudToolbar--merged">
          <button
            type="button"
            className="send ragCrud__primaryBtn"
            disabled={busy}
            onClick={() => {
              setNewChunkFiles([]);
              setChunkContent("");
              setModal("chunk");
            }}
          >
            新建分块
          </button>
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => {
              setBulkFilePickFeedback("");
              setModal("bulk");
            }}
          >
            批量分块导入
          </button>
        </div>

        {hint ? <div className="authInfo ragPage__hint ragDetail__hint">{hint}</div> : null}
      </div>

      <section className="ragChunkSection ragChunkSection--scroll" aria-label="分块列表">
        <h2 className="ragChunkSection__title">分块与向量</h2>
        {chunkLoadErr ? <p className="error">{chunkLoadErr}</p> : null}
        {!chunksLoading && chunkTotal === 0 ? (
          <p className="ragPage__empty">暂无分块，请使用「新建分块」或「批量分块导入」。</p>
        ) : chunksLoading && chunkTotal === 0 ? (
          <p className="authHint">加载分块列表…</p>
        ) : (
          <>
            <div className="ragChunkFilterBar">
              <label className="ragChunkFilterBar__search">
                <span className="ragChunkFilterBar__label">搜索</span>
                <input
                  className="textInput ragChunkFilterBar__input"
                  value={chunkSearch}
                  onChange={(e) => setChunkSearch(e.target.value)}
                  placeholder="按正文或序号过滤（服务端）…"
                  disabled={busy}
                />
              </label>
              <span className="ragChunkFilterBar__meta">
                共 {chunkTotal} 条{searchDebounced ? "（已按关键词筛选）" : ""}
                {selectedIds.size > 0 ? ` · 已选 ${selectedIds.size} 条` : ""}
                {chunksLoading ? " · 刷新中…" : ""}
              </span>
              <button
                type="button"
                className="ghost ragTable__del"
                disabled={busy || selectedIds.size === 0}
                onClick={batchDeleteChunks}
              >
                批量删除
              </button>
            </div>
            <div className="ragTableWrap">
              <table className="ragTable ragTable--chunks">
                <thead>
                  <tr>
                    <th className="ragTable__colCheck">
                      <input
                        ref={selectAllRef}
                        type="checkbox"
                        checked={allFilteredSelected}
                        onChange={toggleSelectAllFiltered}
                        disabled={busy || chunks.length === 0}
                        aria-label="全选当前页"
                      />
                    </th>
                    <th className="ragTable__colIdx">#</th>
                    <th>文本内容</th>
                    <th className="ragTable__colDim">维度</th>
                    <th className="ragTable__colActWide" aria-label="操作" />
                  </tr>
                </thead>
                <tbody>
                  {chunks.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="ragTable__emptyRow">
                        本页无分块，请翻页或调整搜索。
                      </td>
                    </tr>
                  ) : (
                    chunks.map((row) => {
                      const vecState = vecByRow[row.rowId];
                      return (
                        <tr key={row.rowId}>
                          <td className="ragTable__colCheck">
                            <input
                              type="checkbox"
                              checked={selectedIds.has(row.rowId)}
                              onChange={() => toggleRowSelected(row.rowId)}
                              disabled={busy}
                              aria-label={`选择分块 #${row.chunkIndex}`}
                            />
                          </td>
                          <td className="ragTable__colIdx">{row.chunkIndex}</td>
                          <td>
                            <div className="ragTable__contentCell" title={row.content}>
                              {clip(row.content, 200)}
                            </div>
                          </td>
                          <td className="ragTable__colDim">{row.embeddingDim ?? 0}</td>
                          <td className="ragTable__colActWide">
                            <div className="ragTable__actions">
                              <button
                                type="button"
                                className="ghost ghost--small"
                                disabled={busy}
                                onClick={() => {
                                  setEditChunkFiles([]);
                                  setEditChunkRow(row);
                                  setChunkContent(row.content || "");
                                  setModal("chunkEdit");
                                }}
                              >
                                编辑
                              </button>
                              <button
                                type="button"
                                className="ghost ghost--small ragTable__del"
                                disabled={busy}
                                onClick={() => deleteChunk(row)}
                              >
                                删除
                              </button>
                              <details
                                className="ragTable__vecDetails"
                                onToggle={(e) => {
                                  if (!e.currentTarget.open) return;
                                  void loadChunkEmbedding(row.rowId);
                                }}
                              >
                                <summary>向量 JSON</summary>
                                {vecState?.loading ? (
                                  <p className="authHintInline">加载中…</p>
                                ) : vecState?.error ? (
                                  <p className="error">{vecState.error}</p>
                                ) : vecState?.data !== undefined ? (
                                  <pre className="ragChunkCard__json ragChunkCard__json--inline">
                                    {JSON.stringify(vecState.data, null, 0)}
                                  </pre>
                                ) : (
                                  <p className="authHintInline">准备加载…</p>
                                )}
                              </details>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            <div className="ragPager">
              <button
                type="button"
                className="ghost ghost--small"
                disabled={busy || chunkPage <= 1}
                onClick={() => setChunkPage((p) => Math.max(1, p - 1))}
              >
                上一页
              </button>
              <span>
                第 {chunkPage} / {maxPage} 页 · 每页{" "}
                <select
                  className="ragPager__select"
                  value={chunkPageSize}
                  disabled={busy}
                  onChange={(e) => {
                    setChunkPageSize(Number(e.target.value) || 20);
                    setChunkPage(1);
                  }}
                >
                  <option value={10}>10</option>
                  <option value={20}>20</option>
                  <option value={50}>50</option>
                </select>{" "}
                条
              </span>
              <button
                type="button"
                className="ghost ghost--small"
                disabled={busy || chunkPage >= maxPage}
                onClick={() => setChunkPage((p) => p + 1)}
              >
                下一页
              </button>
            </div>
          </>
        )}
      </section>

      {modal === "collection" ? (
        <Modal
          title="编辑知识库"
          onClose={closeModal}
          footer={
            <div className="modalActions">
              <button type="button" className="ghost" onClick={closeModal} disabled={busy}>
                取消
              </button>
              <button type="button" className="send" onClick={saveCollectionName} disabled={busy}>
                {busy ? "保存中…" : "保存"}
              </button>
            </div>
          }
        >
          <label className="authLabel">
            名称
            <input
              className="textInput"
              autoFocus
              value={collectionName}
              onChange={(e) => setCollectionName(e.target.value)}
              disabled={busy}
            />
          </label>
        </Modal>
      ) : null}

      {modal === "chunk" ? (
        <Modal
          title="新建分块"
          onClose={closeModal}
          footer={
            <div className="modalActions">
              <button type="button" className="ghost" onClick={closeModal} disabled={busy}>
                取消
              </button>
              <button type="button" className="send" onClick={submitNewChunk} disabled={busy}>
                {busy ? "向量化中…" : "创建"}
              </button>
            </div>
          }
        >
          <p className="authHintInline">整段文本将向量化存为一条分块（不分句）。</p>
          <div className="ragFileRow">
            <input
              ref={chunkFileRef}
              type="file"
              className="ragFileInputHidden"
              accept=".txt,.md,.markdown,.json,.csv,.log,.html,.htm,.xml,.yml,.yaml,text/plain,text/markdown,text/html,text/xml,application/json"
              multiple
              onChange={(e) => addTextFilesToList(e, setNewChunkFiles)}
            />
            <button type="button" className="ghost" disabled={busy} onClick={() => chunkFileRef.current?.click()}>
              从文件载入
            </button>
            <span className="ragFileRow__hint">
              支持 .txt、.md 等 UTF-8 文本；大文件仅显示文件名，点击「创建」时再读取并合并到正文。
            </span>
          </div>
          {newChunkFiles.length > 0 ? (
            <ul className="ragPendingFiles" aria-label="待导入文件">
              {newChunkFiles.map((f, i) => (
                <li key={`${f.name}-${i}-${f.lastModified}`} className="ragPendingFiles__item">
                  <span title={f.name}>{f.name}</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setNewChunkFiles((prev) => prev.filter((_, j) => j !== i))}
                    aria-label={`移除 ${f.name}`}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <label className="authLabel">
            文本内容
            <textarea
              className="input ragPanel__textarea"
              rows={10}
              autoFocus
              value={chunkContent}
              onChange={(e) => setChunkContent(e.target.value)}
              disabled={busy}
            />
          </label>
        </Modal>
      ) : null}

      {modal === "chunkEdit" && editChunkRow ? (
        <Modal
          title={`编辑分块 #${editChunkRow.chunkIndex}`}
          onClose={closeModal}
          footer={
            <div className="modalActions">
              <button type="button" className="ghost" onClick={closeModal} disabled={busy}>
                取消
              </button>
              <button type="button" className="send" onClick={submitEditChunk} disabled={busy}>
                {busy ? "向量化中…" : "保存"}
              </button>
            </div>
          }
        >
          <div className="ragFileRow">
            <input
              ref={chunkEditFileRef}
              type="file"
              className="ragFileInputHidden"
              accept=".txt,.md,.markdown,.json,.csv,.log,.html,.htm,.xml,.yml,.yaml,text/plain,text/markdown,text/html,text/xml,application/json"
              multiple
              onChange={(e) => addTextFilesToList(e, setEditChunkFiles)}
            />
            <button type="button" className="ghost" disabled={busy} onClick={() => chunkEditFileRef.current?.click()}>
              从文件载入
            </button>
            <span className="ragFileRow__hint">
              大文件仅显示文件名；点击「保存」时再读取并与下方文本合并（UTF-8）。
            </span>
          </div>
          {editChunkFiles.length > 0 ? (
            <ul className="ragPendingFiles" aria-label="待导入文件">
              {editChunkFiles.map((f, i) => (
                <li key={`${f.name}-${i}-${f.lastModified}`} className="ragPendingFiles__item">
                  <span title={f.name}>{f.name}</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setEditChunkFiles((prev) => prev.filter((_, j) => j !== i))}
                    aria-label={`移除 ${f.name}`}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <label className="authLabel">
            文本内容
            <textarea
              className="input ragPanel__textarea"
              rows={10}
              autoFocus
              value={chunkContent}
              onChange={(e) => setChunkContent(e.target.value)}
              disabled={busy}
            />
          </label>
        </Modal>
      ) : null}

      {modal === "bulk" ? (
        <Modal
          title="批量分块导入"
          onClose={closeModal}
          footer={
            <div className="modalActions">
              <button type="button" className="ghost" onClick={closeModal} disabled={busy}>
                取消
              </button>
              <button type="button" className="send" onClick={submitBulkIngest} disabled={busy}>
                {busy ? "处理中…" : "导入（覆盖现有分块）"}
              </button>
            </div>
          }
        >
          <p className="authHintInline ragModalWarn">
            将按分块参数切分全文并全部重新向量化，<strong>会清空本库已有分块</strong>。
          </p>
          <div className="ragFileRow">
            <input
              ref={bulkFileRef}
              type="file"
              className="ragFileInputHidden"
              accept=".txt,.md,.markdown,.json,.csv,.log,.html,.htm,.xml,.yml,.yaml,text/plain,text/markdown,text/html,text/xml,application/json"
              multiple
              onChange={onBulkFilesPicked}
            />
            <button type="button" className="ghost" disabled={busy} onClick={() => bulkFileRef.current?.click()}>
              从文件载入
            </button>
            <span className="ragFileRow__hint">
              支持 .txt、.md 等；多文件按顺序合并（UTF-8）。大文件仅列出文件名，点击「导入」时再读取。
            </span>
          </div>
          <div className="ragBulkPickStatus" role="status" aria-live="polite">
            {bulkPendingFiles.length > 0 ? (
              <p className="ragBulkPickStatus__queue">
                已排队 <strong>{bulkPendingFiles.length}</strong> 个文件（合计{" "}
                {formatBytes(bulkPendingFiles.reduce((s, f) => s + (f.size || 0), 0))}）。点击「导入」时再读取
                UTF-8，并拼接到下方「全文」之后。
              </p>
            ) : !bulkFilePickFeedback ? (
              <p className="ragBulkPickStatus__idle">尚未从文件载入；也可仅在下方输入全文。</p>
            ) : null}
            {bulkFilePickFeedback ? (
              <p
                className={
                  bulkFilePickFeedback.includes("未加入")
                    ? "ragBulkPickStatus__last ragBulkPickStatus__last--warn"
                    : "ragBulkPickStatus__last"
                }
              >
                {bulkFilePickFeedback}
              </p>
            ) : null}
          </div>
          {bulkPendingFiles.length > 0 ? (
            <ul className="ragPendingFiles" aria-label="待导入文件">
              {bulkPendingFiles.map((f, i) => (
                <li key={`${f.name}-${i}-${f.lastModified}`} className="ragPendingFiles__item">
                  <span title={f.name}>{f.name}</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setBulkPendingFiles((prev) => prev.filter((_, j) => j !== i))}
                    aria-label={`移除 ${f.name}`}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <label className="authLabel">
            全文（可仅手动输入；有文件时在导入时自动合并到其后）
            <textarea
              className="input ragPanel__textarea"
              rows={10}
              autoFocus
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              disabled={busy}
            />
          </label>
          <div className="ragModalRow2">
            <label className="authLabel">
              chunkSize
              <input
                className="textInput"
                type="number"
                min={100}
                value={bulkChunkSize}
                onChange={(e) => setBulkChunkSize(Number(e.target.value) || 800)}
                disabled={busy}
              />
            </label>
            <label className="authLabel">
              overlap
              <input
                className="textInput"
                type="number"
                min={0}
                value={bulkOverlap}
                onChange={(e) => setBulkOverlap(Number(e.target.value) || 0)}
                disabled={busy}
              />
            </label>
          </div>
        </Modal>
      ) : null}

      {modal === "retrieval" ? (
        <Modal
          title="检索测试"
          onClose={closeModal}
          footer={
            <div className="modalActions">
              <button type="button" className="ghost" onClick={closeModal} disabled={busy}>
                关闭
              </button>
              <button type="button" className="send" onClick={() => void runQuery()} disabled={busy}>
                {busy ? "检索中…" : "检索"}
              </button>
            </div>
          }
        >
          <p className="authHintInline ragModalRetrievalEnv">
            需配置 <code>ARK_API_KEY</code> 或 <code>EMBEDDING_API_KEY</code>；<code>EMBEDDING_MODEL</code>；多模态设{" "}
            <code>EMBEDDING_USE_MULTIMODAL=1</code>。
          </p>
          <p className="authHintInline ragModalRetrievalThreshold">
            「设置 → Researcher」中的 <strong>RAG 最低相似度</strong> 大于 0 时：此处与聊天、深度研究<strong>共用同一规则</strong>——合并排序后若<strong>最高分</strong>仍低于该阈值，返回空列表（整轮不注入知识库）。
          </p>
          <label className="authLabel">
            问题
            <input
              className="textInput"
              autoFocus
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              disabled={busy}
              placeholder="用自然语言提问"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void runQuery();
                }
              }}
            />
          </label>
          {retrievalFeedback ? <p className="authHintInline ragModalRetrievalFb">{retrievalFeedback}</p> : null}
          {hits.length ? (
            <div className="ragModalRetrievalHits">
              <ul className="ragHitList">
                {hits.map((h, i) => (
                  <li key={`${h.chunkIndex ?? i}-${i}`} className="ragHit">
                    <div className="ragHit__score">相关度 {(Number(h.score) * 100).toFixed(1)}%</div>
                    <pre className="ragHit__content">{h.content}</pre>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}
