import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { AuthenticatedShell } from "./AuthenticatedShell.jsx";
import {
  apiErrorMessage,
  apiFetch,
  clearSessionIfUnauthorized,
  jsonHeaders,
  writeStoredToken
} from "./client.js";
import { clip, formatDateTime, formatTime } from "./format.js";
import RagDetailPage from "./rag/RagDetailPage.jsx";
import RagListPage from "./rag/RagListPage.jsx";
import SettingsPage from "./settings/SettingsPage.jsx";
import ResearchPipelineModal from "./chat/ResearchPipelineModal.jsx";
import {
  loadAgentPrefs,
  useAgentPrefs,
  resolveAgentLabel,
  isAgentTraceHighlighted
} from "./agentPreferences.js";

function newId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** 与 server chatRepository 一致：避免 JSON 里的 null 变成字面量 "null" 写入绑定 */
function normalizeRagCollectionIdsArray(arr) {
  if (!Array.isArray(arr)) return [];
  return [
    ...new Set(
      arr
        .map((x) => String(x ?? "").trim())
        .filter((t) => t && t !== "null" && t !== "undefined")
    )
  ];
}

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const agentPrefs = useAgentPrefs();
  const [user, setUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authMode, setAuthMode] = useState("login");
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [registerDone, setRegisterDone] = useState(false);
  const [forgotDone, setForgotDone] = useState(false);
  const [verifyBanner, setVerifyBanner] = useState("");
  const [resetUrlToken, setResetUrlToken] = useState("");
  /** @type {"password" | "code"} */
  const [loginMethod, setLoginMethod] = useState("password");
  const [loginOtp, setLoginOtp] = useState("");
  const [loginCodeCooldown, setLoginCodeCooldown] = useState(0);

  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState("");

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [sending, setSending] = useState(false);
  /** @type {null | { taskId: string, status: string, stage: string, trace: Array<{ ts?: string, stage?: string, agent?: string, type?: string, summary?: string }> }} */
  const [researchProgress, setResearchProgress] = useState(null);
  const [ragHeaderTitle, setRagHeaderTitle] = useState("");
  /** @type {Array<{ id: string, name: string, chunkCount?: number }>} */
  const [ragCollections, setRagCollections] = useState([]);
  const [ragBindingBusy, setRagBindingBusy] = useState(false);
  const [pipelineModalTaskId, setPipelineModalTaskId] = useState(null);
  const listRef = useRef(null);
  const researchPollRef = useRef(null);
  const latestChatSessionRef = useRef(activeChatId);

  useEffect(() => {
    latestChatSessionRef.current = activeChatId;
  }, [activeChatId]);

  useEffect(() => {
    setPipelineModalTaskId(null);
  }, [activeChatId]);

  useEffect(() => {
    return () => {
      if (researchPollRef.current) {
        clearInterval(researchPollRef.current);
        researchPollRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (researchPollRef.current) {
      clearInterval(researchPollRef.current);
      researchPollRef.current = null;
    }
    setResearchProgress(null);
    setSending(false);
  }, [activeChatId]);

  const canSend = useMemo(
    () => input.trim().length > 0 && !sending && Boolean(activeChatId),
    [input, sending, activeChatId]
  );

  const refreshChats = useCallback(async () => {
    const resp = await apiFetch("/api/chats");
    if (clearSessionIfUnauthorized(resp, setUser)) return;
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return;
    setChats(Array.isArray(data.chats) ? data.chats : []);
  }, [setUser]);

  const activeChat = useMemo(
    () => chats.find((c) => c.id === activeChatId) || null,
    [chats, activeChatId]
  );

  const boundRagIds = useMemo(() => {
    const raw = activeChat?.ragCollectionIds;
    return normalizeRagCollectionIdsArray(Array.isArray(raw) ? raw : []);
  }, [activeChat]);

  const updateChatRagBindings = useCallback(
    async (collectionId, checked) => {
      const coll = String(collectionId ?? "").trim();
      if (!activeChatId || ragBindingBusy || !coll) return;
      const chat = chats.find((c) => c.id === activeChatId);
      const base = normalizeRagCollectionIdsArray(
        Array.isArray(chat?.ragCollectionIds) ? chat.ragCollectionIds : []
      );
      const next = checked
        ? [...new Set([...base, coll])]
        : base.filter((id) => id !== coll);
      setRagBindingBusy(true);
      try {
        const resp = await apiFetch(`/api/chats/${encodeURIComponent(activeChatId)}`, {
          method: "PATCH",
          headers: jsonHeaders,
          body: JSON.stringify({ ragCollectionIds: next })
        });
        if (clearSessionIfUnauthorized(resp, setUser)) return;
        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({}));
          throw new Error(apiErrorMessage(errData, resp.status));
        }
        await refreshChats();
      } catch (e) {
        console.error(e);
        await refreshChats();
      } finally {
        setRagBindingBusy(false);
      }
    },
    [activeChatId, chats, ragBindingBusy, refreshChats, setUser]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await apiFetch("/api/auth/me");
        const data = await resp.json().catch(() => ({}));
        if (cancelled) return;
        if (!data?.user) writeStoredToken("");
        setUser(data?.user || null);
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setAuthChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!authChecked || user) return;
    if (location.pathname.startsWith("/rag")) navigate("/", { replace: true });
  }, [authChecked, user, location.pathname, navigate]);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const v = p.get("verify");
    const rs = p.get("reset");
    if (!v && !rs) return;
    if (v) {
      (async () => {
        try {
          const r = await fetch(`/api/auth/verify-email?token=${encodeURIComponent(v)}`);
          const d = await r.json().catch(() => ({}));
          window.history.replaceState({}, "", window.location.pathname + window.location.hash);
          if (r.ok) {
            setVerifyBanner("邮箱验证成功，请使用账号密码登录。");
          } else {
            setVerifyBanner(
              d?.error === "invalid_or_expired_token"
                ? "验证链接无效或已过期，请重新注册。"
                : "验证失败，请稍后重试。"
            );
          }
        } catch {
          setVerifyBanner("验证请求失败。");
        }
      })();
    }
    if (rs) {
      setResetUrlToken(rs);
      setAuthMode("reset");
      window.history.replaceState({}, "", window.location.pathname + window.location.hash);
    }
  }, []);

  useEffect(() => {
    if (!user) {
      setRagCollections([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await apiFetch("/api/rag/collections");
        if (cancelled || clearSessionIfUnauthorized(r, setUser)) return;
        const d = await r.json().catch(() => ({}));
        if (!cancelled && r.ok) {
          setRagCollections(Array.isArray(d.collections) ? d.collections : []);
        }
      } catch {
        if (!cancelled) setRagCollections([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, setUser]);

  useEffect(() => {
    if (!user) {
      setChats([]);
      setActiveChatId("");
      setMessages([]);
      setRagHeaderTitle("");
      return;
    }
    let cancelled = false;
    (async () => {
      const resp = await apiFetch("/api/chats");
      if (cancelled || clearSessionIfUnauthorized(resp, setUser)) return;
      const data = await resp.json().catch(() => ({}));
      let list = Array.isArray(data.chats) ? data.chats : [];
      if (list.length === 0) {
        const cr = await apiFetch("/api/chats", { method: "POST" });
        if (cancelled || clearSessionIfUnauthorized(cr, setUser)) return;
        const created = await cr.json().catch(() => ({}));
        if (cr.ok && created.chat) {
          list = [created.chat];
        }
      }
      if (cancelled) return;
      setChats(list);
      if (list.length && !list.some((c) => c.id === activeChatId)) {
        setActiveChatId(list[0].id);
      } else if (list.length && !activeChatId) {
        setActiveChatId(list[0].id);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bootstrap lists once per login
  }, [user]);

  useEffect(() => {
    if (!user || !activeChatId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const resp = await apiFetch(`/api/chats/${encodeURIComponent(activeChatId)}/messages`);
      if (cancelled || clearSessionIfUnauthorized(resp, setUser)) return;
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setMessages([]);
        return;
      }
      if (cancelled) return;
      setMessages(Array.isArray(data.messages) ? data.messages : []);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, activeChatId, setUser]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    queueMicrotask(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [messages, activeChatId]);

  useEffect(() => {
    if (loginCodeCooldown <= 0) return undefined;
    const id = window.setInterval(() => {
      setLoginCodeCooldown((s) => (s <= 1 ? 0 : s - 1));
    }, 1000);
    return () => window.clearInterval(id);
  }, [loginCodeCooldown > 0]);

  async function sendLoginCode() {
    const email = authEmail.trim();
    if (!email) {
      setAuthError("请输入邮箱");
      return;
    }
    setAuthBusy(true);
    setAuthError("");
    try {
      const resp = await apiFetch("/api/auth/send-login-code", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ email })
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.status === 429) {
        const wait = Number(data.retryAfterSec) || 60;
        setLoginCodeCooldown(wait);
        throw new Error(`发送过频，请 ${wait} 秒后再试`);
      }
      if (!resp.ok) throw new Error(apiErrorMessage(data, resp.status));
      setLoginCodeCooldown(60);
    } catch (e) {
      setAuthError(e?.message || "发送失败");
    } finally {
      setAuthBusy(false);
    }
  }

  async function submitAuth() {
    const username = authUsername.trim();
    const password = authPassword;
    const email = authEmail.trim();

    if (authMode === "register") {
      if (!username || !password || !email) {
        setAuthError("请填写用户名、密码与邮箱");
        return;
      }
      setAuthBusy(true);
      setAuthError("");
      setRegisterDone(false);
      try {
        const resp = await apiFetch("/api/auth/register", {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ username, password, email })
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(apiErrorMessage(data, resp.status));
        setRegisterDone(true);
        setAuthPassword("");
      } catch (e) {
        setAuthError(e?.message || "请求失败");
      } finally {
        setAuthBusy(false);
      }
      return;
    }

    if (authMode === "login") {
      if (loginMethod === "code") {
        const em = authEmail.trim();
        const code = loginOtp.trim();
        if (!em) {
          setAuthError("请输入邮箱");
          return;
        }
        if (!/^\d{6}$/.test(code)) {
          setAuthError("请输入 6 位数字验证码");
          return;
        }
        setAuthBusy(true);
        setAuthError("");
        try {
          const resp = await apiFetch("/api/auth/login-with-code", {
            method: "POST",
            headers: jsonHeaders,
            body: JSON.stringify({ email: em, code })
          });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok) {
            throw new Error(data?.error === "invalid credentials" ? "验证码错误或已过期" : data?.error || `HTTP ${resp.status}`);
          }
          if (data.token) writeStoredToken(data.token);
          setUser(data.user ?? null);
          setLoginOtp("");
          setAuthPassword("");
        } catch (e) {
          setAuthError(e?.message || "请求失败");
        } finally {
          setAuthBusy(false);
        }
        return;
      }

      if (!username || !password) {
        setAuthError("请输入用户名和密码");
        return;
      }
      setAuthBusy(true);
      setAuthError("");
      try {
        const resp = await apiFetch("/api/auth/login", {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ username, password })
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          if (data?.error === "email_not_verified") {
            throw new Error("请先完成邮箱验证后再使用账号密码登录。");
          }
          throw new Error(data?.error || `HTTP ${resp.status}`);
        }
        if (data.token) writeStoredToken(data.token);
        setUser(data.user || { username });
        setAuthPassword("");
      } catch (e) {
        setAuthError(e?.message || "请求失败");
      } finally {
        setAuthBusy(false);
      }
      return;
    }

    if (authMode === "forgot") {
      if (!email) {
        setAuthError("请输入注册邮箱");
        return;
      }
      setAuthBusy(true);
      setAuthError("");
      setForgotDone(false);
      try {
        const resp = await apiFetch("/api/auth/forgot-password", {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ email })
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
        setForgotDone(true);
      } catch (e) {
        setAuthError(e?.message || "请求失败");
      } finally {
        setAuthBusy(false);
      }
      return;
    }

    if (authMode === "reset") {
      if (!resetUrlToken || !password) {
        setAuthError("请输入新密码");
        return;
      }
      setAuthBusy(true);
      setAuthError("");
      try {
        const resp = await fetch("/api/auth/reset-password", {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ token: resetUrlToken, password })
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
        setResetUrlToken("");
        setAuthPassword("");
        setAuthMode("login");
        setVerifyBanner("密码已重置，请使用新密码登录。");
      } catch (e) {
        setAuthError(e?.message || "请求失败");
      } finally {
        setAuthBusy(false);
      }
    }
  }

  async function logout() {
    setAuthBusy(true);
    setAuthError("");
    try {
      writeStoredToken("");
      setUser(null);
      setRagHeaderTitle("");
      await apiFetch("/api/auth/logout", { method: "POST" });
      navigate("/", { replace: true });
    } catch (e) {
      setAuthError(e?.message || "退出失败");
    } finally {
      setAuthBusy(false);
    }
  }

  async function newChat() {
    const resp = await apiFetch("/api/chats", { method: "POST" });
    if (clearSessionIfUnauthorized(resp, setUser)) return;
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return;
    const chat = data.chat;
    if (!chat?.id) return;
    setChats((prev) => [chat, ...prev.filter((c) => c.id !== chat.id)]);
    setActiveChatId(chat.id);
  }

  async function deleteChat(id, e) {
    e?.stopPropagation?.();
    const resp = await apiFetch(`/api/chats/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (clearSessionIfUnauthorized(resp, setUser)) return;
    if (!resp.ok) return;
    let rest = chats.filter((c) => c.id !== id);
    if (activeChatId === id) {
      if (rest.length) {
        setActiveChatId(rest[0].id);
      } else {
        const cr = await apiFetch("/api/chats", { method: "POST" });
        if (!clearSessionIfUnauthorized(cr, setUser) && cr.ok) {
          const d = await cr.json().catch(() => ({}));
          if (d.chat) {
            rest = [d.chat];
            setActiveChatId(d.chat.id);
          }
        }
      }
    }
    setChats(rest);
    await refreshChats();
  }

  async function send() {
    const question = input.trim();
    if (!question || sending || !activeChatId) return;

    const sessionIdAtStart = activeChatId;
    setSending(true);
    setInput("");
    const userMsg = { id: newId(), role: "user", content: question, ts: Date.now() };
    setMessages((prev) => [...prev, userMsg]);

    let asyncPolling = false;

    const scrollToBottom = () => {
      queueMicrotask(() => {
        const el = listRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    };

    try {
      const chatPrefs = loadAgentPrefs();
      const resp = await apiFetch("/api/chat", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          sessionId: sessionIdAtStart,
          question,
          dialogueTone: chatPrefs.dialogueTone,
          chatRouteMode: chatPrefs.chatRouteMode,
          ragTopK: chatPrefs.ragTopK,
          ragMinScore: chatPrefs.ragMinScore,
          ragSnippetMaxChars: chatPrefs.ragSnippetMaxChars,
          simpleChatTemperature: chatPrefs.simpleChatTemperature,
          simpleChatMaxTokens: chatPrefs.simpleChatMaxTokens,
          plannerMaxTokens: chatPrefs.plannerMaxTokens,
          plannerTemperature: chatPrefs.plannerTemperature,
          writerMaxTokens: chatPrefs.writerMaxTokens,
          readerMaxTokens: chatPrefs.readerMaxTokens,
          readerMaxSources: chatPrefs.readerMaxSources,
          readerClipChars: chatPrefs.readerClipChars,
          fetcherPreferKbOnly: chatPrefs.fetcherPreferKbOnly,
          criticRewriteMaxTokens: chatPrefs.criticRewriteMaxTokens
        })
      });
      if (clearSessionIfUnauthorized(resp, setUser)) {
        return;
      }
      const data = await resp.json().catch(() => ({}));

      if (resp.status === 409) {
        const mr = await apiFetch(`/api/chats/${encodeURIComponent(sessionIdAtStart)}/messages`);
        if (!clearSessionIfUnauthorized(mr, setUser) && mr.ok) {
          const md = await mr.json().catch(() => ({}));
          setMessages(Array.isArray(md.messages) ? md.messages : []);
        }
        throw new Error("当前对话有一条研究正在进行，请等待完成后再发送。");
      }

      if (resp.status === 202) {
        const taskId = String(data.taskId || "");
        if (!taskId) throw new Error("服务器未返回 taskId");
        asyncPolling = true;
        setResearchProgress({ taskId, status: "", stage: "已排队", trace: [] });

        if (researchPollRef.current) clearInterval(researchPollRef.current);
        researchPollRef.current = window.setInterval(async () => {
          try {
            if (latestChatSessionRef.current !== sessionIdAtStart) {
              if (researchPollRef.current) {
                clearInterval(researchPollRef.current);
                researchPollRef.current = null;
              }
              setResearchProgress(null);
              setSending(false);
              return;
            }
            const pr = await apiFetch(`/api/chat/research/${encodeURIComponent(taskId)}`);
            if (clearSessionIfUnauthorized(pr, setUser)) {
              if (researchPollRef.current) {
                clearInterval(researchPollRef.current);
                researchPollRef.current = null;
              }
              setResearchProgress(null);
              setSending(false);
              return;
            }
            const d = await pr.json().catch(() => ({}));
            if (!pr.ok) return;
            setResearchProgress({
              taskId,
              status: d.status || "",
              stage: d.stage || d.status || "",
              trace: Array.isArray(d.trace) ? d.trace : []
            });
            if (d.status === "done" || d.status === "failed") {
              if (researchPollRef.current) {
                clearInterval(researchPollRef.current);
                researchPollRef.current = null;
              }
              setResearchProgress(null);
              const mr = await apiFetch(`/api/chats/${encodeURIComponent(sessionIdAtStart)}/messages`);
              if (!clearSessionIfUnauthorized(mr, setUser) && mr.ok) {
                const md = await mr.json().catch(() => ({}));
                setMessages(Array.isArray(md.messages) ? md.messages : []);
              }
              await refreshChats();
              setSending(false);
              scrollToBottom();
            }
          } catch {
            if (researchPollRef.current) {
              clearInterval(researchPollRef.current);
              researchPollRef.current = null;
            }
            setResearchProgress(null);
            setSending(false);
          }
        }, 900);
        scrollToBottom();
        return;
      }

      if (!resp.ok) {
        throw new Error(data?.error || `HTTP ${resp.status}`);
      }
      const mr = await apiFetch(`/api/chats/${encodeURIComponent(sessionIdAtStart)}/messages`);
      if (!clearSessionIfUnauthorized(mr, setUser) && mr.ok) {
        const md = await mr.json().catch(() => ({}));
        setMessages(Array.isArray(md.messages) ? md.messages : []);
      } else {
        setMessages((prev) => [
          ...prev,
          { id: newId(), role: "assistant", content: data.answer, ts: Date.now() }
        ]);
      }
      await refreshChats();
    } catch (e) {
      const mr = await apiFetch(`/api/chats/${encodeURIComponent(sessionIdAtStart)}/messages`);
      if (!clearSessionIfUnauthorized(mr, setUser) && mr.ok) {
        const md = await mr.json().catch(() => ({}));
        setMessages(Array.isArray(md.messages) ? md.messages : []);
      }
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
      if (!asyncPolling) {
        setSending(false);
        scrollToBottom();
      }
    }
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const activeChatTitle = useMemo(() => {
    const c = chats.find((x) => x.id === activeChatId);
    return c?.title || "对话";
  }, [chats, activeChatId]);

  const shellSubtitle = useMemo(() => {
    const p = location.pathname;
    if (p === "/" || p === "")
      return (
        <>
          对话 · {clip(activeChatTitle, 40)}
        </>
      );
    if (p === "/rag")
      return (
        <>
          知识库 · 列表
        </>
      );
    if (/^\/rag\/[^/]+$/.test(p))
      return (
        <>
          知识库 · {clip(ragHeaderTitle || "加载中", 40)}
        </>
      );
    if (p === "/settings") return <>多智能体 · 个性化与编排说明</>;
    return <>DeepResearch</>;
  }, [location.pathname, activeChatTitle, ragHeaderTitle]);

  if (!authChecked) {
    return (
      <div className="app app--center">
        <div className="authHint">加载中…</div>
      </div>
    );
  }

  if (!user) {
    const showMainTabs = authMode === "login" || authMode === "register";
    return (
      <div className="app app--center">
        <section className="authCard" aria-label="登录或注册">
          <div className="authTitle">DeepResearch</div>
          {verifyBanner ? <div className="authInfo">{verifyBanner}</div> : null}
          {registerDone ? (
            <div className="authInfo authInfo--ok">
              注册成功，验证邮件已发送。请登录邮箱点击链接完成验证后再登录。
            </div>
          ) : null}
          {forgotDone ? (
            <div className="authInfo authInfo--ok">
              若该邮箱已注册，你将收到重置密码邮件（请检查垃圾箱）。
            </div>
          ) : null}
          {showMainTabs ? (
            <div className="authTabs">
              <button
                type="button"
                className={`authTab ${authMode === "login" ? "authTab--active" : ""}`}
                onClick={() => {
                  setAuthMode("login");
                  setAuthError("");
                  setRegisterDone(false);
                  setLoginMethod("password");
                  setLoginOtp("");
                }}
              >
                登录
              </button>
              <button
                type="button"
                className={`authTab ${authMode === "register" ? "authTab--active" : ""}`}
                onClick={() => {
                  setAuthMode("register");
                  setAuthError("");
                  setRegisterDone(false);
                }}
              >
                注册
              </button>
            </div>
          ) : null}

          {authMode === "forgot" ? (
            <>
              <p className="authHintInline">输入注册邮箱，我们将发送重置链接。</p>
              <label className="authLabel">
                邮箱
                <input
                  className="textInput authInput"
                  type="email"
                  autoComplete="email"
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                />
              </label>
            </>
          ) : null}

          {authMode === "reset" ? (
            <>
              <p className="authHintInline">设置新密码</p>
              <label className="authLabel">
                新密码
                <input
                  className="textInput authInput"
                  type="password"
                  autoComplete="new-password"
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                />
              </label>
            </>
          ) : null}

          {(authMode === "login" || authMode === "register") && (
            <>
              {authMode === "login" ? (
                <div className="authSubTabs" role="tablist" aria-label="登录方式">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={loginMethod === "password"}
                    className={`authSubTab ${loginMethod === "password" ? "authSubTab--active" : ""}`}
                    onClick={() => {
                      setLoginMethod("password");
                      setAuthError("");
                      setLoginOtp("");
                    }}
                  >
                    账号密码
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={loginMethod === "code"}
                    className={`authSubTab ${loginMethod === "code" ? "authSubTab--active" : ""}`}
                    onClick={() => {
                      setLoginMethod("code");
                      setAuthError("");
                    }}
                  >
                    邮箱验证码
                  </button>
                </div>
              ) : null}

              {authMode === "register" ? (
                <>
                  <label className="authLabel">
                    用户名
                    <input
                      className="textInput authInput"
                      autoComplete="username"
                      value={authUsername}
                      onChange={(e) => setAuthUsername(e.target.value)}
                    />
                  </label>
                  <label className="authLabel">
                    密码
                    <input
                      className="textInput authInput"
                      type="password"
                      autoComplete="new-password"
                      value={authPassword}
                      onChange={(e) => setAuthPassword(e.target.value)}
                    />
                  </label>
                  <label className="authLabel">
                    邮箱
                    <input
                      className="textInput authInput"
                      type="email"
                      autoComplete="email"
                      value={authEmail}
                      onChange={(e) => setAuthEmail(e.target.value)}
                    />
                  </label>
                </>
              ) : loginMethod === "code" ? (
                <>
                  <label className="authLabel">
                    邮箱
                    <div className="authInlineRow">
                      <input
                        className="textInput authInput"
                        type="email"
                        autoComplete="email"
                        value={authEmail}
                        onChange={(e) => setAuthEmail(e.target.value)}
                      />
                      <button
                        type="button"
                        className="send authCodeSendBtn"
                        onClick={sendLoginCode}
                        disabled={authBusy || loginCodeCooldown > 0}
                      >
                        {loginCodeCooldown > 0 ? `${loginCodeCooldown}s` : "获取验证码"}
                      </button>
                    </div>
                  </label>
                  <label className="authLabel">
                    验证码
                    <input
                      className="textInput authInput"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      placeholder="6 位数字"
                      value={loginOtp}
                      onChange={(e) => setLoginOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    />
                  </label>
                </>
              ) : (
                <>
                  <label className="authLabel">
                    用户名
                    <input
                      className="textInput authInput"
                      autoComplete="username"
                      value={authUsername}
                      onChange={(e) => setAuthUsername(e.target.value)}
                    />
                  </label>
                  <label className="authLabel">
                    密码
                    <input
                      className="textInput authInput"
                      type="password"
                      autoComplete="current-password"
                      value={authPassword}
                      onChange={(e) => setAuthPassword(e.target.value)}
                    />
                  </label>
                </>
              )}
            </>
          )}

          {authMode === "login" && loginMethod === "code" ? (
            <div className="authRow">
              <button
                type="button"
                className="authLinkBtn"
                onClick={() => {
                  setAuthMode("forgot");
                  setAuthError("");
                  setForgotDone(false);
                }}
              >
                忘记密码？
              </button>
            </div>
          ) : null}

          {authMode === "forgot" || authMode === "reset" ? (
            <button
              type="button"
              className="authLinkBtn authLinkBtn--solo"
              onClick={() => {
                setAuthMode("login");
                setAuthError("");
                setForgotDone(false);
              }}
            >
              返回登录
            </button>
          ) : null}

          {authError ? <div className="error authError">{authError}</div> : null}
          {(showMainTabs || authMode === "forgot" || authMode === "reset") && (
            <button className="send authSubmit" type="button" onClick={submitAuth} disabled={authBusy}>
              {authBusy
                ? "处理中…"
                : authMode === "register"
                  ? "注册"
                  : authMode === "forgot"
                    ? "发送重置邮件"
                    : authMode === "reset"
                      ? "确认新密码"
                      : "登录"}
            </button>
          )}
          <p className="authNote">
            注册需验证邮箱；密码与用户信息存于服务端。生产环境请配置 HTTPS 与更安全的密码存储。
          </p>
        </section>
      </div>
    );
  }

  const chatSidebar = (
    <aside className="sidebar" aria-label="历史记录">
      <div className="sidebarSection">
        <div className="sidebarSectionHead">
          <span className="sidebarSectionTitle">对话</span>
          <button className="sidebarNewBtn" type="button" onClick={newChat}>
            新对话
          </button>
        </div>
        <ul className="sidebarList">
          {chats.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className={`sidebarItem ${c.id === activeChatId ? "sidebarItem--active" : ""}`}
                onClick={() => {
                  setActiveChatId(c.id);
                }}
              >
                <span className="sidebarItemTitle">{clip(c.title || "新对话", 22)}</span>
                <span className="sidebarItemMeta">{formatDateTime(c.updatedAt)}</span>
              </button>
              <button
                type="button"
                className="sidebarItemDel"
                aria-label="删除对话"
                onClick={(e) => deleteChat(c.id, e)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );

  return (
    <Routes>
      <Route
        element={
          <AuthenticatedShell
            user={user}
            authBusy={authBusy}
            onLogout={logout}
            subtitle={shellSubtitle}
            sidebar={chatSidebar}
          />
        }
      >
        <Route
          index
          element={
            <>
              <div className="chat" ref={listRef} aria-label="聊天记录">
                {messages.map((m) => (
                  <div key={m.id} className={`msg msg--${m.role}`}>
                    <div className="avatar" aria-hidden="true">
                      {m.role === "user" ? "你" : "AI"}
                    </div>
                    <div className="content">
                      <div className="meta">
                        <span className="name">
                          {m.role === "user"
                            ? "你"
                            : (() => {
                                const ca = resolveAgentLabel("ChatAssistant", agentPrefs);
                                return ca === "ChatAssistant" ? "研究助理" : ca;
                              })()}
                        </span>
                        <span className="time">{m.ts ? formatTime(m.ts) : ""}</span>
                      </div>
                      {m.role === "assistant" && m.meta?.researchTaskId ? (
                        <div className="msgBubbleRow">
                          <div className="bubble markdown markdown--assistant">
                            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{m.content}</ReactMarkdown>
                          </div>
                          <button
                            type="button"
                            className="msgPipelineBtn"
                            title="查看本轮多智能体流程图与每步输入输出"
                            aria-label="查看多智能体流程图"
                            onClick={() => setPipelineModalTaskId(String(m.meta.researchTaskId))}
                          >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                              <path
                                d="M4 6h6v4H4V6zm10 0h6v4h-6V6zM4 14h6v4H4v-4zm10 0h6v4h-6v-4z"
                                stroke="currentColor"
                                strokeWidth="1.6"
                                strokeLinejoin="round"
                              />
                              <path d="M10 8h4M10 16h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                            </svg>
                          </button>
                        </div>
                      ) : (
                        <div className={`bubble markdown markdown--${m.role}`}>
                          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{m.content}</ReactMarkdown>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {researchProgress ? (
                <div className="chatProgress" aria-live="polite" aria-busy="true">
                  <div className="chatProgress__head">
                    <span className="chatProgress__title">研究进行中</span>
                    <span className="chatProgress__stage">
                      {researchProgress.stage || researchProgress.status || "准备中"}
                    </span>
                  </div>
                  <ul className="chatProgress__list">
                    {(researchProgress.trace || []).slice(
                      -Math.min(40, Math.max(5, Number(agentPrefs.traceTailCount) || 10))
                    ).map((row, i) => {
                      const ag = String(row.agent || "").trim() || "—";
                      const hl = isAgentTraceHighlighted(ag, agentPrefs);
                      return (
                      <li
                        key={`${row.ts || ""}-${i}`}
                        className={`chatProgress__item${hl ? " chatProgress__item--hl" : ""}`}
                      >
                        <span className="chatProgress__agent">{resolveAgentLabel(ag, agentPrefs)}</span>
                        <span className="chatProgress__meta">
                          {row.stage ? `${row.stage} · ` : ""}
                          {row.type || ""}
                        </span>
                        {row.summary ? <div className="chatProgress__summary">{row.summary}</div> : null}
                      </li>
                    );
                    })}
                  </ul>
                </div>
              ) : null}

              <div className="composerWrap">
                <div className="composerRagBindings" aria-label="当前对话绑定的知识库">
                  <div className="composerRagBindings__head">
                    <span className="composerRag__label">本对话知识库</span>
                    {ragBindingBusy ? <span className="composerRag__hint">保存中…</span> : null}
                  </div>
                  {ragCollections.length === 0 ? (
                    <p className="composerRag__hint">
                      暂无知识库，请先到「知识库」页创建并导入文档后再在此勾选绑定。
                    </p>
                  ) : (
                    <ul className="composerRagCheckList">
                      {ragCollections.map((c) => (
                        <li key={c.id}>
                          <label className="composerRagCheck">
                            <input
                              type="checkbox"
                              checked={boundRagIds.includes(String(c.id ?? "").trim())}
                              onChange={(e) => void updateChatRagBindings(String(c.id ?? "").trim(), e.target.checked)}
                              disabled={!activeChatId || ragBindingBusy}
                            />
                            <span className="composerRagCheck__text">
                              {clip(c.name || "未命名", 28)}
                              {typeof c.chunkCount === "number" ? (
                                <span className="composerRagCheck__meta"> · {c.chunkCount} 条</span>
                              ) : null}
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="composer">
                  <textarea
                    className="input"
                    placeholder={
                      activeChatId
                        ? boundRagIds.length
                          ? "将按你的问题检索「本对话」已勾选的知识库（可多库），回答中可带「[知识库-1]」等引用。深度研究会带上检索片段作为课题上下文。Enter 发送，Shift+Enter 换行"
                          : "未勾选知识库时仅使用联网研究管线。可在上方勾选要绑定的库后再提问。Enter 发送，Shift+Enter 换行"
                        : "请先创建或选择对话"
                    }
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={onKeyDown}
                    rows={2}
                    disabled={!activeChatId}
                  />
                  <button className="send" onClick={send} disabled={!canSend}>
                    {sending ? "研究中…" : "发送"}
                  </button>
                </div>
              </div>
              {pipelineModalTaskId ? (
                <ResearchPipelineModal
                  taskId={pipelineModalTaskId}
                  setUser={setUser}
                  onClose={() => setPipelineModalTaskId(null)}
                />
              ) : null}
            </>
          }
        />
        <Route path="rag" element={<RagListPage setUser={setUser} />} />
        <Route path="rag/:id" element={<RagDetailPage setUser={setUser} onHeaderTitle={setRagHeaderTitle} />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
