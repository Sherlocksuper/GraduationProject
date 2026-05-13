import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch, apiErrorMessage, clearSessionIfUnauthorized, jsonHeaders } from "../client.js";
import { formatDateTime } from "../format.js";
import Modal from "./Modal.jsx";

export default function RagListPage({ setUser }) {
  const navigate = useNavigate();
  const [collections, setCollections] = useState([]);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createGoDetail, setCreateGoDetail] = useState(true);

  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState("");
  const [editName, setEditName] = useState("");

  const refresh = useCallback(async () => {
    const resp = await apiFetch("/api/rag/collections");
    if (clearSessionIfUnauthorized(resp, setUser)) return;
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return;
    setCollections(Array.isArray(data.collections) ? data.collections : []);
  }, [setUser]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function submitCreate() {
    const name = createName.trim() || "未命名知识库";
    setBusy(true);
    setHint("");
    try {
      const resp = await apiFetch("/api/rag/collections", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ name })
      });
      if (clearSessionIfUnauthorized(resp, setUser)) return;
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setHint(apiErrorMessage(data, resp.status));
        return;
      }
      setCreateOpen(false);
      setCreateName("");
      await refresh();
      setHint("已创建。");
      if (createGoDetail && data.collection?.id) {
        navigate(`/rag/${encodeURIComponent(data.collection.id)}`);
      }
    } catch (e) {
      setHint(e?.message || "请求失败");
    } finally {
      setBusy(false);
    }
  }

  function openEdit(c) {
    setEditId(c.id);
    setEditName(c.name || "");
    setEditOpen(true);
    setHint("");
  }

  async function submitEdit() {
    const name = editName.trim();
    if (!name || !editId) return;
    setBusy(true);
    setHint("");
    try {
      const resp = await apiFetch(`/api/rag/collections/${encodeURIComponent(editId)}`, {
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
      setEditOpen(false);
      setEditId("");
      await refresh();
      setHint("已保存。");
    } catch (e) {
      setHint(e?.message || "请求失败");
    } finally {
      setBusy(false);
    }
  }

  async function deleteOne(id, e) {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    if (!window.confirm("确定删除该知识库及其所有分块？")) return;
    setBusy(true);
    setHint("");
    try {
      const resp = await apiFetch(`/api/rag/collections/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (clearSessionIfUnauthorized(resp, setUser)) return;
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setHint(apiErrorMessage(data, resp.status));
        return;
      }
      await refresh();
      setHint("已删除。");
    } catch (e) {
      setHint(e?.message || "请求失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ragPage ragPage--list">
      <div className="ragPage__head ragPage__head--crud">
        <div>
          <h1 className="ragPage__h1">知识库列表</h1>
          <p className="ragPage__lead">管理知识库：创建、重命名、删除；点名称进入详情维护分块与检索。</p>
        </div>
        <button type="button" className="send ragCrud__primaryBtn" onClick={() => setCreateOpen(true)} disabled={busy}>
          新建知识库
        </button>
      </div>

      {hint ? <div className="authInfo ragPage__hint">{hint}</div> : null}

      {collections.length === 0 ? (
        <p className="ragPage__empty">暂无知识库，请点击「新建知识库」。</p>
      ) : (
        <div className="ragTableWrap">
          <table className="ragTable">
            <thead>
              <tr>
                <th>名称</th>
                <th>创建时间</th>
                <th>向量数量</th>
                <th>向量模型</th>
                <th className="ragTable__colActWide" aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {collections.map((c) => (
                <tr
                  key={c.id}
                  className="ragTable__row ragTable__row--click"
                  tabIndex={0}
                  role="link"
                  onClick={() => navigate(`/rag/${encodeURIComponent(c.id)}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      navigate(`/rag/${encodeURIComponent(c.id)}`);
                    }
                  }}
                >
                  <td className="ragTable__name">{c.name}</td>
                  <td>{formatDateTime(c.createdAt)}</td>
                  <td>{c.chunkCount ?? 0}</td>
                  <td>
                    <code className="ragTable__code">{c.embeddingModel || "—"}</code>
                  </td>
                  <td className="ragTable__colActWide">
                    <div className="ragTable__actions" onClick={(e) => e.stopPropagation()}>
                      <button type="button" className="ghost ghost--small" disabled={busy} onClick={() => openEdit(c)}>
                        编辑
                      </button>
                      <button
                        type="button"
                        className="ghost ghost--small ragTable__del"
                        disabled={busy}
                        onClick={(e) => deleteOne(c.id, e)}
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {createOpen ? (
        <Modal
          title="新建知识库"
          onClose={() => !busy && setCreateOpen(false)}
          footer={
            <div className="modalActions">
              <button type="button" className="ghost" onClick={() => setCreateOpen(false)} disabled={busy}>
                取消
              </button>
              <button type="button" className="send" onClick={submitCreate} disabled={busy}>
                {busy ? "提交中…" : "创建"}
              </button>
            </div>
          }
        >
          <label className="authLabel">
            名称
            <input
              className="textInput"
              autoFocus
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder="例如：课程笔记"
              disabled={busy}
            />
          </label>
          <label className="ragModalCheck">
            <input
              type="checkbox"
              checked={createGoDetail}
              onChange={(e) => setCreateGoDetail(e.target.checked)}
              disabled={busy}
            />
            创建后进入详情页
          </label>
        </Modal>
      ) : null}

      {editOpen ? (
        <Modal
          title="编辑知识库"
          onClose={() => !busy && setEditOpen(false)}
          footer={
            <div className="modalActions">
              <button type="button" className="ghost" onClick={() => setEditOpen(false)} disabled={busy}>
                取消
              </button>
              <button type="button" className="send" onClick={submitEdit} disabled={busy}>
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
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              disabled={busy}
            />
          </label>
        </Modal>
      ) : null}
    </div>
  );
}
