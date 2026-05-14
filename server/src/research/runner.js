import { planTopic } from "./planner.js";
import { renderReportMarkdown, writeSection } from "./writer.js";
import { coordinatorBriefTopic } from "./topicSubquestionLines.js";
import { webSearch } from "./webSearch.js";
import { webFetchClean } from "./webFetchClean.js";
import { readEvidence } from "./reader.js";
import { critiqueSection } from "./critic.js";
import { compactLlmMessages } from "./llmTraceMessages.js";
import { isGlobalPassEnabled, polishReportMarkdownFull } from "./globalPassEditor.js";

function clampResearch(n, lo, hi, d) {
  const x = Number(n);
  if (!Number.isFinite(x)) return d;
  return Math.max(lo, Math.min(hi, x));
}

/** 来自用户设置的深度研究运行时参数（由 HTTP 请求传入并钳位） */
export function normalizeResearchRuntime(rt) {
  const r = rt && typeof rt === "object" ? rt : {};
  return {
    plannerMaxTokens: Math.floor(clampResearch(r.plannerMaxTokens, 400, 2000, 1200)),
    plannerTemperature: clampResearch(r.plannerTemperature, 0, 0.9, 0.2),
    writerMaxTokens: Math.floor(clampResearch(r.writerMaxTokens, 320, 2000, 560)),
    readerMaxTokens: Math.floor(clampResearch(r.readerMaxTokens, 400, 2000, 900)),
    readerMaxSources: Math.floor(clampResearch(r.readerMaxSources, 2, 8, 3)),
    readerClipChars: Math.floor(clampResearch(r.readerClipChars, 600, 8000, 2400)),
    fetcherPreferKbOnly: (() => {
      const v = r.fetcherPreferKbOnly;
      if (v === true || v === 1) return true;
      if (v === false || v === 0) return false;
      const s = String(v ?? "").toLowerCase().trim();
      return s === "true" || s === "1" || s === "yes";
    })(),
    criticRewriteMaxTokens: Math.floor(clampResearch(r.criticRewriteMaxTokens, 400, 2400, 1200)),
    /** JSON 不合格时最多再向模型要几轮完整输出（Reader/Writer 各自循环上限） */
    readerJsonAttempts: Math.floor(clampResearch(r.readerJsonAttempts, 1, 4, 2)),
    readerLlmRetries: Math.floor(clampResearch(r.readerLlmRetries, 1, 8, 3)),
    writerJsonAttempts: Math.floor(clampResearch(r.writerJsonAttempts, 1, 4, 2)),
    writerLlmRetries: Math.floor(clampResearch(r.writerLlmRetries, 1, 8, 3))
  };
}

/** Reader 只取前若干条来源：知识库优先，再补网页；强命中时可仅用知识库。子问题/小节标题用 compactTopicKey 做去重归一化。 */
function compactTopicKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000·.。:：,，、;；!！?？「」『』（）()\[\]【】]/g, "")
    .replace(/的/g, "");
}

/** 短串是否为长串的子序列（同序出现），用于识别「代号」相对「成立时间和代号」等整体/局部重复 */
function isSubsequence(short, long) {
  if (!short || !long || short.length > long.length) return false;
  let i = 0;
  for (let c = 0; c < long.length; c++) {
    if (long[c] === short[i]) i++;
    if (i === short.length) return true;
  }
  return false;
}

/** 窄子问题是否应被宽子问题吸收（去掉窄的，保留一节即可） */
function isNestedSubquestionDuplicate(narrowKey, broadKey) {
  if (narrowKey.length < 5 || broadKey.length <= narrowKey.length) return false;
  if (!isSubsequence(narrowKey, broadKey)) return false;
  const gap = broadKey.length - narrowKey.length;
  if (gap > 14) return false;
  if (narrowKey.length / broadKey.length < 0.35) return false;
  return true;
}

/** 去掉 Planner 产出的同义重复子问题（避免两节标题只差「的」） */
function dedupeSubquestions(sqs) {
  const arr = Array.isArray(sqs) ? sqs : [];
  const out = [];
  const keyOf = (sq) => compactTopicKey(String(sq?.question || "").trim());

  for (const sq of arr) {
    const q = String(sq?.question || "").trim();
    if (!q) continue;
    const k = keyOf(sq);
    if (k.length < 4) {
      out.push(sq);
      continue;
    }

    // 新来的子问题更「宽」时，去掉 out 里已被其包含的较窄子问题
    for (let i = out.length - 1; i >= 0; i--) {
      const pk = keyOf(out[i]);
      if (pk.length < 4) continue;
      if (k.length > pk.length && isNestedSubquestionDuplicate(pk, k)) out.splice(i, 1);
    }

    let dup = false;
    for (const prev of out) {
      const pk = keyOf(prev);
      if (!pk) continue;
      if (k === pk) {
        dup = true;
        break;
      }
      if (k.length >= 10 && pk.length >= 10 && (k.includes(pk) || pk.includes(k))) {
        const ratio = Math.min(k.length, pk.length) / Math.max(k.length, pk.length);
        if (ratio >= 0.92) {
          dup = true;
          break;
        }
      }
      // 已保留的更宽子问题已覆盖本条（窄），不再加入
      if (pk.length > k.length && isNestedSubquestionDuplicate(k, pk)) {
        dup = true;
        break;
      }
    }
    if (!dup) out.push(sq);
  }
  return out;
}

/** 合并 Writer 产出的相邻重复小节（标题几乎相同、内容重复叙述） */
function mergeAdjacentNearDuplicateSections(sections, notes) {
  if (!Array.isArray(sections) || !Array.isArray(notes) || sections.length !== notes.length) return;
  const outS = [];
  const outN = [];
  const uniqStr = (arr) => {
    const seen = new Set();
    const r = [];
    for (const x of arr || []) {
      const t = String(x || "").trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      r.push(t);
    }
    return r;
  };
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const note = notes[i];
    if (!outS.length) {
      outS.push(sec);
      outN.push(note);
      continue;
    }
    const prev = outS[outS.length - 1];
    const pk = compactTopicKey(prev?.heading || "");
    const ck = compactTopicKey(sec?.heading || "");
    const same =
      pk.length >= 6 &&
      ck.length >= 6 &&
      (pk === ck || (pk.includes(ck) || ck.includes(pk) ? Math.min(pk.length, ck.length) / Math.max(pk.length, ck.length) >= 0.9 : false));
    if (same) {
      prev.summary = uniqStr([...(prev.summary || []), ...(sec.summary || [])]).slice(0, 6);
      prev.paragraphs = uniqStr([...(prev.paragraphs || []), ...(sec.paragraphs || [])]).slice(0, 8);
      prev.sources = [...new Set([...(prev.sources || []), ...(sec.sources || [])].map(String))].slice(0, 8);
      const pb = outN[outN.length - 1]?.evidence?.bullets || [];
      const nb = note?.evidence?.bullets || [];
      outN[outN.length - 1] = {
        ...outN[outN.length - 1],
        draft: prev,
        sources: prev.sources,
        evidence: { ...outN[outN.length - 1].evidence, bullets: [...pb, ...nb].slice(0, 12) }
      };
      continue;
    }
    outS.push(sec);
    outN.push(note);
  }
  sections.splice(0, sections.length, ...outS);
  notes.splice(0, notes.length, ...outN);
}

function mergeKbAndWebDocLists(kbDocs, webDocs, { skipWeb }) {
  const kb = (Array.isArray(kbDocs) ? kbDocs : []).filter(
    (d) => d && String(d.text || "").trim() && String(d.url || "").startsWith("http")
  );
  const web = (Array.isArray(webDocs) ? webDocs : []).filter((d) => d && String(d.text || "").trim());
  if (skipWeb) return kb.slice(0, 6);
  const kbHead = kb.slice(0, 2);
  const room = Math.max(0, 6 - kbHead.length);
  const webHead = web.slice(0, Math.min(4, room + 2));
  return [...kbHead, ...webHead].slice(0, 6);
}

function envResearchInt(name, def, lo, hi) {
  const v = Number(String(process.env[name] ?? "").trim());
  if (!Number.isFinite(v)) return def;
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}

/** 有界并发 map：保序，适合子问题检索 / 读写等 I/O 与 LLM 混合阶段。 */
async function mapLimit(items, limit, mapper) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const lim = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  const ret = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      ret[i] = await mapper(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: lim }, () => worker()));
  return ret;
}

export async function runResearchTask({ store, taskId, llmClient, retrieveKbDocs, runtime } = {}) {
  const task = store.getTask(taskId);
  if (!task) throw new Error("task_not_found");

  const rt = normalizeResearchRuntime(runtime);
  const collectConc = envResearchInt("RESEARCH_COLLECT_CONCURRENCY", 3, 1, 8);
  const sectionConc = envResearchInt("RESEARCH_SECTION_CONCURRENCY", 2, 1, 6);
  const fetchTimeoutMs = (() => {
    const v = Number(String(process.env.RESEARCH_FETCH_TIMEOUT_MS ?? "").trim());
    if (!Number.isFinite(v)) return 25_000;
    return Math.max(5000, Math.min(60_000, Math.floor(v)));
  })();

  const add = (event) => store.addTraceEvent(taskId, event);

  add({
    type: "reasoning",
    stage: "planning",
    agent: "Coordinator",
    payload: { msg: "Start planning" }
  });
  store.setStatus(taskId, "planning");

  const plan = await planTopic({
    llmClient,
    topic: task.topic,
    trace: (e) => add(e),
    maxTokens: rt.plannerMaxTokens,
    temperature: rt.plannerTemperature
  });

  add({
    type: "reasoning",
    stage: "collecting",
    agent: "Coordinator",
    payload: {
      msg: retrieveKbDocs
        ? "Start collecting sources（知识库向量检索 + 按需联网）"
        : "Start collecting sources (web_search + web_fetch_clean)"
    }
  });
  store.setStatus(taskId, "collecting");

  const rawSq = Array.isArray(plan?.subquestions) ? plan.subquestions : [];
  const subquestions = dedupeSubquestions(rawSq).slice(0, 5);
  if (subquestions.length < rawSq.length) {
    add({
      type: "decision",
      stage: "planning",
      agent: "Coordinator",
      payload: { msg: "Deduped near-duplicate subquestions", before: rawSq.length, after: subquestions.length }
    });
  }
  plan.subquestions = subquestions;
  store.putArtifact(taskId, "plan.json", plan);
  add({
    type: "decision",
    stage: "planning",
    agent: "Coordinator",
    payload: { msg: "Plan generated", subquestionCount: subquestions.length }
  });

  const blockedHosts = [
    "zhihu.com",
    "www.zhihu.com",
    "baike.baidu.com",
    "wenku.baidu.com",
    "weixin.qq.com",
    "mp.weixin.qq.com"
  ];
  const collected = await mapLimit(subquestions, collectConc, async (sq) => {
    const qid = String(sq?.id || "").trim() || "q?";
    const query =
      (Array.isArray(sq?.keywords) && sq.keywords.length
        ? sq.keywords.slice(0, 5).join(" ")
        : String(sq?.question || "")) || task.topic;

    add({
      type: "action",
      stage: "collecting",
      agent: "Researcher",
      payload: { subquestionId: qid, query }
    });

    let kbDocs = [];
    if (typeof retrieveKbDocs === "function") {
      try {
        kbDocs = await retrieveKbDocs(query);
        if (kbDocs.length) {
          add({
            type: "observation",
            stage: "collecting",
            agent: "Researcher",
            payload: {
              subquestionId: qid,
              note: "kb_retrieve_ok",
              query,
              kbHits: kbDocs.length,
              kbPreview: kbDocs.slice(0, 12).map((d) => ({
                title: String(d.title || "").slice(0, 220),
                url: String(d.url || "").slice(0, 400),
                ragScore: Number(d.ragScore) || 0,
                textChars: String(d.text || "").length
              }))
            }
          });
        } else {
          add({
            type: "observation",
            stage: "collecting",
            agent: "Researcher",
            payload: { subquestionId: qid, note: "kb_retrieve_empty", query, kbHits: 0 }
          });
        }
      } catch (e) {
        add({
          type: "observation",
          stage: "collecting",
          agent: "Researcher",
          payload: { subquestionId: qid, note: "kb_retrieve_failed", error: String(e?.message || e || "error") }
        });
      }
    }

    const kbAvg =
      kbDocs.length > 0 ? kbDocs.reduce((s, d) => s + (Number(d.ragScore) || 0), 0) / kbDocs.length : 0;
    const skipWebThreshold = Number(process.env.RESEARCH_RAG_SKIP_WEB_SCORE || "0.38");
    let skipWeb =
      typeof retrieveKbDocs === "function" &&
      kbDocs.length >= 2 &&
      kbAvg >= skipWebThreshold &&
      String(process.env.RESEARCH_RAG_ALWAYS_WEB || "").trim() !== "1";

    if (rt.fetcherPreferKbOnly && typeof retrieveKbDocs === "function" && kbDocs.length >= 1) {
      skipWeb = String(process.env.RESEARCH_RAG_ALWAYS_WEB || "").trim() !== "1";
    }

    let results = [];
    if (!skipWeb) {
      results = await webSearch({ query, topK: kbDocs.length ? 3 : 4 });
    } else {
      add({
        type: "decision",
        stage: "collecting",
        agent: "Researcher",
        payload: {
          subquestionId: qid,
          msg: "Skip web search (strong knowledge-base hits)",
          kbCount: kbDocs.length,
          kbAvgScore: kbAvg
        }
      });
    }

    const providerSet = Array.from(
      new Set(results.map((r) => String(r?.source || "").trim()).filter(Boolean))
    );
    add({
      type: "observation",
      stage: "collecting",
      agent: "Researcher",
      payload: {
        subquestionId: qid,
        resultCount: results.length,
        kbDocCount: kbDocs.length,
        skipWeb,
        provider: providerSet.length ? providerSet.join(",") : skipWeb ? "kb_only" : "unknown",
        resultsPreview: results.slice(0, 6).map((r) => ({
          title: r.title || "",
          url: r.url,
          snippet: r.snippet || "",
          source: r.source || ""
        })),
        urls: results.map((r) => r.url)
      }
    });

    const fetchOneTop = async (r) => {
      const host = (() => {
        try {
          return new URL(r.url).host;
        } catch {
          return "";
        }
      })();
      const snippet = String(r?.snippet || "").trim();

      if (host && blockedHosts.includes(host)) {
        if (snippet) {
          add({
            type: "observation",
            stage: "collecting",
            agent: "Fetcher",
            payload: { subquestionId: qid, url: r.url, chars: snippet.length, via: "snippet", note: "blocked_host_skip_fetch" }
          });
          return { url: r.url, title: r.title || "", text: snippet, via: "snippet" };
        }
        add({
          type: "observation",
          stage: "collecting",
          agent: "Fetcher",
          payload: { subquestionId: qid, url: r.url, via: "skip", note: "blocked_host_skip_fetch_no_snippet" }
        });
        return null;
      }

      try {
        add({
          type: "action",
          stage: "collecting",
          agent: "Fetcher",
          payload: { subquestionId: qid, url: r.url }
        });
        const doc = await webFetchClean({
          url: r.url,
          useJina: String(process.env.USE_JINA || "0") === "1",
          timeoutMs: fetchTimeoutMs,
          maxChars: 10_000
        });
        add({
          type: "observation",
          stage: "collecting",
          agent: "Fetcher",
          payload: { subquestionId: qid, url: r.url, chars: (doc.text || "").length, via: doc.via }
        });
        return { url: doc.url, title: r.title || "", text: doc.text, via: doc.via };
      } catch (e) {
        add({
          type: "observation",
          stage: "collecting",
          agent: "Fetcher",
          payload: { subquestionId: qid, url: r.url, error: String(e?.message || e || "fetch_failed") }
        });

        if (snippet) {
          add({
            type: "observation",
            stage: "collecting",
            agent: "Fetcher",
            payload: { subquestionId: qid, url: r.url, chars: snippet.length, via: "snippet" }
          });
          return { url: r.url, title: r.title || "", text: snippet, via: "snippet" };
        }
        return null;
      }
    };

    const webDocs = (await Promise.all(results.slice(0, 3).map((r) => fetchOneTop(r)))).filter(Boolean);

    // 如果抓取几乎全失败，则尝试降低 USE_JINA（直抓），并扩大候选 URL 数（并行尝试，按序取前两条有效证据）
    if (!skipWeb && webDocs.length === 0) {
      const more = results.slice(0, 6);
      const extraRows = await Promise.all(
        more.map(async (r) => {
          try {
            const doc = await webFetchClean({
              url: r.url,
              useJina: false,
              timeoutMs: fetchTimeoutMs,
              maxChars: 10_000
            });
            add({
              type: "observation",
              stage: "collecting",
              agent: "Fetcher",
              payload: { subquestionId: qid, url: r.url, chars: (doc.text || "").length, via: doc.via }
            });
            return { url: doc.url, title: r.title || "", text: doc.text, via: doc.via };
          } catch (e) {
            add({
              type: "observation",
              stage: "collecting",
              agent: "Fetcher",
              payload: { subquestionId: qid, url: r.url, error: String(e?.message || e || "fetch_failed") }
            });

            const snippet2 = String(r?.snippet || "").trim();
            if (snippet2) {
              add({
                type: "observation",
                stage: "collecting",
                agent: "Fetcher",
                payload: { subquestionId: qid, url: r.url, chars: snippet2.length, via: "snippet" }
              });
              return { url: r.url, title: r.title || "", text: snippet2, via: "snippet" };
            }
            return null;
          }
        })
      );
      for (const row of extraRows) {
        if (row) {
          webDocs.push(row);
          if (webDocs.length >= 2) break;
        }
      }
    }

    const docs = mergeKbAndWebDocLists(kbDocs, webDocs, { skipWeb });
    const searchLabel = skipWeb
      ? "kb"
      : kbDocs.length
        ? `kb+${providerSet.length ? providerSet.join(",") : "web"}`
        : providerSet.length
          ? providerSet.join(",")
          : "unknown";

    return {
      id: qid,
      question: String(sq?.question || ""),
      keywords: Array.isArray(sq?.keywords) ? sq.keywords : [],
      searchProvider: searchLabel,
      results,
      docs
    };
  });
  store.putArtifact(taskId, "sources.json", { collected });

  add({
    type: "reasoning",
    stage: "reading",
    agent: "Coordinator",
    payload: { msg: "Start reading evidence (LLM) and drafting notes" }
  });
  store.setStatus(taskId, "reading");

  add({
    type: "reasoning",
    stage: "writing",
    agent: "Coordinator",
    payload: { msg: "Start writing sections (evidence-based)" }
  });
  store.setStatus(taskId, "writing");

  const notes = [];
  const sections = [];

  const sectionRows = await mapLimit(subquestions, sectionConc, async (sq, si) => {
    const qid = String(sq?.id || "").trim() || "q?";
    const pack = collected[si] || collected.find((c) => c.id === qid) || { results: [], docs: [] };
    const urlToSource = new Map(
      (Array.isArray(pack.results) ? pack.results : [])
        .map((r) => [String(r?.url || "").trim(), String(r?.source || "").trim()])
        .filter(([u, s]) => u.startsWith("http") && s)
    );
    for (const d of Array.isArray(pack.docs) ? pack.docs : []) {
      const u = String(d?.url || "").trim();
      if (u.startsWith("http") && u.includes("kb.local")) urlToSource.set(u, "rag");
    }

    let ev;
    try {
      ev = await readEvidence({
        llmClient,
        topic: task.topic,
        subquestion: sq,
        docs: pack.docs,
        trace: (e) => add(e),
        maxTokens: rt.readerMaxTokens,
        maxSources: rt.readerMaxSources,
        clipChars: rt.readerClipChars,
        jsonAttempts: rt.readerJsonAttempts,
        llmRetries: rt.readerLlmRetries
      });
    } catch (e) {
      // Reader 解析失败时，不让整个任务失败，降级为基于原始 docs/snippet 的简单要点
      const bullets = (Array.isArray(pack.docs) ? pack.docs : [])
        .slice(0, 4)
        .map((d, idx) => ({
          claim: `（降级）来自来源 ${idx + 1} 的概括要点`,
          support: String(d?.text || "").slice(0, 80),
          url: d?.url || ""
        }))
        .filter((b) => b.url);

      ev = {
        bullets,
        gaps: ["（降级）Reader JSON 解析失败，建议稍后重试以获得更精细的证据要点。"]
      };

      add({
        type: "observation",
        stage: "reading",
        agent: "Coordinator",
        payload: {
          subquestionId: qid,
          error: String(e?.message || e || "reader_failed"),
          fallback: "reader_fallback_from_docs",
          bulletCount: bullets.length
        }
      });
    }

    const evWithSource = {
      ...ev,
      bullets: (Array.isArray(ev?.bullets) ? ev.bullets : []).map((b) => ({
        ...b,
        source: urlToSource.get(String(b?.url || "").trim()) || pack.searchProvider || "unknown"
      }))
    };

    const enrichedSq = {
      ...sq,
      evidenceBullets: evWithSource.bullets
    };

    add({
      type: "reasoning",
      stage: "writing",
      agent: "Coordinator",
      payload: {
        msg: "小节写作：正在调用模型生成本节 JSON（此处与下一条 Writer 日志之间通常是一次 LLM 往返；若很久无更新，多为上游排队、限流或超时重试）",
        sectionIndex: si + 1,
        sectionTotal: subquestions.length,
        subquestionId: qid
      }
    });

    let result;
    try {
      result = await writeSection({
        llmClient,
        topic: task.topic,
        subquestion: enrichedSq,
        trace: (e) => add(e),
        maxTokens: rt.writerMaxTokens,
        jsonAttempts: rt.writerJsonAttempts,
        llmRetries: rt.writerLlmRetries
      });
    } catch (e) {
      const urls = Array.from(
        new Set(
          (Array.isArray(evWithSource?.bullets) ? evWithSource.bullets : [])
            .map((b) => String(b?.url || "").trim())
            .filter((u) => u.startsWith("http"))
        )
      ).slice(0, 4);
      const claims = (Array.isArray(evWithSource?.bullets) ? evWithSource.bullets : [])
        .map((b) => String(b?.claim || "").trim())
        .filter(Boolean)
        .slice(0, 3);
      const supports = (Array.isArray(evWithSource?.bullets) ? evWithSource.bullets : [])
        .map((b) => String(b?.support || "").trim())
        .filter(Boolean)
        .slice(0, 2);

      result = {
        heading: String(sq?.question || qid).slice(0, 18),
        summary: claims.length ? claims : ["（降级）证据不足", "（降级）请补充检索", "（降级）后续将核验"],
        paragraphs: supports.length
          ? supports.map((t) => `（降级生成）${t}`)
          : ["（降级生成）当前写作输出不稳定，已使用证据片段生成本节草稿。", "（降级生成）建议稍后重试以获得更高质量的段落。"],
        sources: urls
      };
      add({
        type: "observation",
        stage: "writing",
        agent: "Coordinator",
        payload: {
          subquestionId: qid,
          error: String(e?.message || e || "writer_failed"),
          fallback: "writer_section_fallback_from_evidence",
          sources: urls
        }
      });
    }

    const sectionSources = Array.isArray(result.sources) ? result.sources : [];
    const note = {
      id: qid,
      question: String(sq?.question || ""),
      keywords: Array.isArray(sq?.keywords) ? sq.keywords : [],
      sourceHints: Array.isArray(sq?.sourceHints) ? sq.sourceHints : [],
      searchProvider: pack.searchProvider || "unknown",
      searchQuery:
        (Array.isArray(sq?.keywords) && sq.keywords.length
          ? sq.keywords.slice(0, 5).join(" ")
          : String(sq?.question || "")) || task.topic,
      searchResultsPreview: (Array.isArray(pack.results) ? pack.results : []).slice(0, 5).map((r) => ({
        title: r.title || "",
        url: r.url,
        snippet: r.snippet || "",
        source: r.source || ""
      })),
      docsPreview: (Array.isArray(pack.docs) ? pack.docs : []).slice(0, 3).map((d) => ({
        url: d.url,
        via: d.via,
        chars: (d.text || "").length
      })),
      evidence: evWithSource,
      sources: sectionSources,
      draft: result
    };
    return { note, section: result, qid, sectionSources };
  });

  for (const row of sectionRows) {
    notes.push(row.note);
    sections.push(row.section);
    add({
      type: "decision",
      stage: "writing",
      agent: "Coordinator",
      payload: { msg: "Section drafted", subquestionId: row.qid, sources: row.sectionSources.slice(0, 3) }
    });
  }

  const secCountBeforeMerge = sections.length;
  mergeAdjacentNearDuplicateSections(sections, notes);
  if (sections.length < secCountBeforeMerge) {
    add({
      type: "decision",
      stage: "writing",
      agent: "Coordinator",
      payload: { msg: "Merged adjacent near-duplicate sections", before: secCountBeforeMerge, after: sections.length }
    });
  }

  store.putArtifact(taskId, "notes.json", { notes });

  // 生成“摘要/结论”（不严格依赖 JSON；失败就留空，不影响出报告）
  let overview = "";
  let conclusion = "";
  try {
    const { chatWithRetry } = await import("./llmChat.js");
    const brief = sections
      .map((s, i) => `${i + 1}. ${s.heading}\n- ${(s.summary || []).slice(0, 3).join(" / ")}`)
      .join("\n\n");
    const overviewMessages = [
      {
        role: "system",
        content:
          "你用中文写一段连贯说明，不要虚构数据。不要用「目录」「摘要」等标题；不要列大纲。像给朋友口头总结；**总长度控制在约 120-200 字**，不要重复各小节里已经写过的定义。"
      },
      {
        role: "user",
        content:
          `主题：${coordinatorBriefTopic(task.topic)}\n\n下面是小节要点（只作参考，勿逐条复述）：\n\n${brief}\n\n请写一段自然叙述（约 120-200 字）。`
      }
    ];
    const conclusionMessages = [
      {
        role: "system",
        content:
          "你用中文写收尾说明，不要虚构数据。不要用编号大纲。语气像聊天总结；**总长度约 200-380 字**，分 2-3 个短自然段即可，不要重复前文已细说的定义。"
      },
      {
        role: "user",
        content:
          `主题：${coordinatorBriefTopic(task.topic)}\n\n参考各节要点（勿逐条复述）：\n\n${brief}\n\n请写约 200-380 字。`
      }
    ];
    add({
      type: "action",
      stage: "writing",
      agent: "Coordinator",
      payload: {
        msg: "Generate overview",
        kind: "overview",
        llmMessages: compactLlmMessages(overviewMessages)
      }
    });
    add({
      type: "action",
      stage: "writing",
      agent: "Coordinator",
      payload: {
        msg: "Generate conclusion",
        kind: "conclusion",
        llmMessages: compactLlmMessages(conclusionMessages)
      }
    });

    const [ovSettled, conSettled] = await Promise.allSettled([
      chatWithRetry({
        llmClient,
        stage: "writing",
        agent: "Coordinator",
        meta: { kind: "overview" },
        retries: 4,
        maxTokens: 480,
        messages: overviewMessages
      }),
      chatWithRetry({
        llmClient,
        stage: "writing",
        agent: "Coordinator",
        meta: { kind: "conclusion" },
        retries: 4,
        maxTokens: 640,
        messages: conclusionMessages
      })
    ]);

    if (ovSettled.status === "fulfilled") {
      overview = String(ovSettled.value || "").trim();
      add({
        type: "observation",
        stage: "writing",
        agent: "Coordinator",
        payload: { kind: "overview", raw: overview }
      });
    } else {
      add({
        type: "observation",
        stage: "writing",
        agent: "Coordinator",
        payload: { msg: "Overview skipped", error: String(ovSettled.reason?.message || ovSettled.reason || "error") }
      });
    }

    if (conSettled.status === "fulfilled") {
      conclusion = String(conSettled.value || "").trim();
      add({
        type: "observation",
        stage: "writing",
        agent: "Coordinator",
        payload: { kind: "conclusion", raw: conclusion }
      });
    } else {
      add({
        type: "observation",
        stage: "writing",
        agent: "Coordinator",
        payload: { msg: "Conclusion skipped", error: String(conSettled.reason?.message || conSettled.reason || "error") }
      });
    }

    add({ type: "observation", stage: "writing", agent: "Coordinator", payload: { msg: "Overview & conclusion pass done" } });
  } catch (e) {
    add({
      type: "observation",
      stage: "writing",
      agent: "Coordinator",
      payload: { msg: "Overview/conclusion skipped", error: String(e?.message || e || "error") }
    });
  }

  // Critic v0：检查引用覆盖与数值断言（中期最小质量保障）
  add({ type: "reasoning", stage: "reviewing", agent: "Coordinator", payload: { msg: "Start Critic v0" } });
  store.setStatus(taskId, "reviewing");
  const criticReport = { taskId, ts: new Date().toISOString(), items: [], fixed: 0, skipped: 0 };

  const { chatWithRetry } = await import("./llmChat.js");
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const note = notes[i];
    const qid = note?.id || `sec_${i + 1}`;
    const { issues } = critiqueSection({ section: sec, note });
    criticReport.items.push({ id: qid, heading: sec?.heading, issueCount: issues.length, issues });
    if (!issues.length) continue;

    // 自动修正策略：
    // - 若来源不足：补搜 topK=8，优先 snippet 兜底，重跑 Reader+Writer
    // - 若数值断言无证据：重写本节，移除具体数字/年份，保留定性表述
    const needMoreSources = issues.some((x) => x.code === "sources_too_few" || x.code === "sources_low_diversity");
    const needDeNumeric = issues.some((x) => x.code === "numeric_claim_without_numeric_evidence");

    try {
      if (needMoreSources) {
        const query = note?.searchQuery || note?.question || task.topic;
        add({ type: "action", stage: "reviewing", agent: "Critic", payload: { id: qid, fix: "expand_search", query } });
        let kbExtra = [];
        if (typeof retrieveKbDocs === "function") {
          try {
            kbExtra = await retrieveKbDocs(query);
          } catch {
            kbExtra = [];
          }
        }
        const moreResults = await webSearch({ query, topK: 8 });
        const webSnip = [];
        for (const r of moreResults.slice(0, 4)) {
          const snippet = String(r?.snippet || "").trim();
          if (snippet) webSnip.push({ url: r.url, title: r.title || "", text: snippet, via: "snippet" });
        }
        const docs = mergeKbAndWebDocLists(kbExtra, webSnip, { skipWeb: false });
        const ev2 = await readEvidence({
          llmClient,
          topic: task.topic,
          subquestion: { id: qid, question: note?.question },
          docs,
          trace: (e) => add(e),
          maxTokens: rt.readerMaxTokens,
          maxSources: rt.readerMaxSources,
          clipChars: rt.readerClipChars,
          jsonAttempts: rt.readerJsonAttempts,
          llmRetries: rt.readerLlmRetries
        });
        const enrichedSq2 = {
          id: qid,
          question: note?.question,
          keywords: note?.keywords || [],
          evidenceBullets: ev2.bullets
        };
        const sec2 = await writeSection({
          llmClient,
          topic: task.topic,
          subquestion: enrichedSq2,
          trace: (e) => add(e),
          maxTokens: rt.writerMaxTokens,
          jsonAttempts: rt.writerJsonAttempts,
          llmRetries: rt.writerLlmRetries
        });
        sections[i] = sec2;
        notes[i] = { ...note, evidence: ev2, sources: sec2.sources, draft: sec2 };
      }

      if (needDeNumeric) {
        const sources = Array.isArray(sections[i]?.sources) ? sections[i].sources : [];
        const evidenceBullets = Array.isArray(notes[i]?.evidence?.bullets) ? notes[i].evidence.bullets : [];
        const prompt = [
          "你是报告批判与修正智能体（Critic）。请对给定小节进行改写：",
          "- 移除或弱化无法由证据直接支撑的具体数字/年份/比例。",
          "- 保留结构与逻辑，尽量让内容更严谨。",
          "- 仍需输出严格 JSON：{heading, summary[], paragraphs[], sources[]}。",
          "- sources 必须只从给定 sources 列表中选择。",
          "",
          `小节标题：${sections[i]?.heading || ""}`,
          "允许 sources：",
          ...sources.map((u) => `- ${u}`),
          "",
          "证据要点：",
          ...evidenceBullets.slice(0, 8).map((b) => `- ${b.claim} (${b.url})`),
          "",
          "当前正文：",
          ...(Array.isArray(sections[i]?.paragraphs) ? sections[i].paragraphs : [])
        ].join("\n");

        const criticMessages = [
          { role: "system", content: "你是严谨的 Critic，只输出 JSON。" },
          { role: "user", content: prompt }
        ];
        add({
          type: "action",
          stage: "reviewing",
          agent: "Critic",
          payload: {
            id: qid,
            fix: "denumeric_rewrite",
            llmMessages: compactLlmMessages(criticMessages)
          }
        });
        await chatWithRetry({
          llmClient,
          stage: "reviewing",
          agent: "Critic",
          meta: { id: qid },
          retries: 4,
          maxTokens: rt.criticRewriteMaxTokens,
          messages: criticMessages
        });

        // 复用 writer 的 JSON 抽取规则：直接让 writeSection 再走一次（避免重复实现解析）
        const sec3 = await writeSection({
          llmClient,
          topic: task.topic,
          subquestion: { ...sections[i], id: qid, question: note?.question, keywords: note?.keywords, evidenceBullets },
          trace: (e) => add(e),
          maxTokens: rt.writerMaxTokens,
          jsonAttempts: rt.writerJsonAttempts,
          llmRetries: rt.writerLlmRetries
        });
        // 如果上述失败，则至少保留原本 sources，不影响交付
        sections[i] = sec3 || sections[i];
        notes[i] = { ...notes[i], sources: sections[i].sources, draft: sections[i] };
      }

      criticReport.fixed += 1;
      add({ type: "decision", stage: "reviewing", agent: "Critic", payload: { id: qid, status: "fixed" } });
    } catch (e) {
      criticReport.skipped += 1;
      add({
        type: "observation",
        stage: "reviewing",
        agent: "Critic",
        payload: { id: qid, status: "skipped", error: String(e?.message || e || "critic_failed") }
      });
    }
  }

  store.putArtifact(taskId, "critic_report.json", criticReport);
  store.putArtifact(taskId, "notes.json", { notes }); // updated

  let reportMd = renderReportMarkdown({ topic: task.topic, plan, sections, overview, conclusion });
  if (isGlobalPassEnabled()) {
    store.putArtifact(taskId, "report_predraft.md", reportMd);
    reportMd = await polishReportMarkdownFull({
      llmClient,
      topic: task.topic,
      markdown: reportMd,
      trace: (e) => add(e)
    });
  }
  store.putArtifact(taskId, "report.md", reportMd);

  store.setStatus(taskId, "done");
  add({
    type: "final",
    stage: "done",
    agent: "Coordinator",
    payload: { msg: "Task completed (sources + evidence-based writer)" }
  });
}

