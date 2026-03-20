import { planTopic } from "./planner.js";
import { renderReportMarkdown, writeSection } from "./writer.js";
import { webSearch } from "./webSearch.js";
import { webFetchClean } from "./webFetchClean.js";
import { readEvidence } from "./reader.js";
import { critiqueSection } from "./critic.js";

export async function runResearchTask({ store, taskId, llmClient }) {
  const task = store.getTask(taskId);
  if (!task) throw new Error("task_not_found");

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
    trace: (e) => add(e)
  });

  store.putArtifact(taskId, "plan.json", plan);
  add({
    type: "decision",
    stage: "planning",
    agent: "Coordinator",
    payload: { msg: "Plan generated", subquestionCount: plan?.subquestions?.length || 0 }
  });

  add({
    type: "reasoning",
    stage: "collecting",
    agent: "Coordinator",
    payload: { msg: "Start collecting sources (web_search + web_fetch_clean)" }
  });
  store.setStatus(taskId, "collecting");

  const subquestions = Array.isArray(plan?.subquestions) ? plan.subquestions.slice(0, 6) : [];
  const collected = [];
  const blockedHosts = [
    "zhihu.com",
    "www.zhihu.com",
    "baike.baidu.com",
    "wenku.baidu.com",
    "weixin.qq.com",
    "mp.weixin.qq.com"
  ];
  for (const sq of subquestions) {
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
    const results = await webSearch({ query, topK: 4 });
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
        provider: providerSet.length ? providerSet.join(",") : "unknown",
        resultsPreview: results.slice(0, 6).map((r) => ({
          title: r.title || "",
          url: r.url,
          snippet: r.snippet || "",
          source: r.source || ""
        })),
        urls: results.map((r) => r.url)
      }
    });

    const docs = [];
    for (const r of results.slice(0, 3)) {
      const host = (() => {
        try {
          return new URL(r.url).host;
        } catch {
          return "";
        }
      })();
      const snippet = String(r?.snippet || "").trim();

      // 对强反爬/不可抓取站点：直接使用 snippet 作为证据，避免大量 403 噪音
      if (host && blockedHosts.includes(host)) {
        if (snippet) {
          docs.push({ url: r.url, title: r.title || "", text: snippet, via: "snippet" });
          add({
            type: "observation",
            stage: "collecting",
            agent: "Fetcher",
            payload: { subquestionId: qid, url: r.url, chars: snippet.length, via: "snippet", note: "blocked_host_skip_fetch" }
          });
        } else {
          add({
            type: "observation",
            stage: "collecting",
            agent: "Fetcher",
            payload: { subquestionId: qid, url: r.url, via: "skip", note: "blocked_host_skip_fetch_no_snippet" }
          });
        }
        continue;
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
          timeoutMs: 25_000,
          maxChars: 10_000
        });
        docs.push({ url: doc.url, title: r.title || "", text: doc.text, via: doc.via });
        add({
          type: "observation",
          stage: "collecting",
          agent: "Fetcher",
          payload: { subquestionId: qid, url: r.url, chars: (doc.text || "").length, via: doc.via }
        });
      } catch (e) {
        add({
          type: "observation",
          stage: "collecting",
          agent: "Fetcher",
          payload: { subquestionId: qid, url: r.url, error: String(e?.message || e || "fetch_failed") }
        });

        // 抓取失败时，用搜索 snippet 兜底（也算“有来源”的证据）
        if (snippet) {
          docs.push({
            url: r.url,
            title: r.title || "",
            text: snippet,
            via: "snippet"
          });
          add({
            type: "observation",
            stage: "collecting",
            agent: "Fetcher",
            payload: { subquestionId: qid, url: r.url, chars: snippet.length, via: "snippet" }
          });
        }
      }
    }

    // 如果抓取几乎全失败，则尝试降低 USE_JINA（直抓），并扩大候选 URL 数
    if (docs.length === 0) {
      const more = results.slice(0, 6);
      for (const r of more) {
        try {
          const doc = await webFetchClean({
            url: r.url,
            useJina: false,
            timeoutMs: 25_000,
            maxChars: 10_000
          });
          docs.push({ url: doc.url, title: r.title || "", text: doc.text, via: doc.via });
          add({
            type: "observation",
            stage: "collecting",
            agent: "Fetcher",
            payload: { subquestionId: qid, url: r.url, chars: (doc.text || "").length, via: doc.via }
          });
          if (docs.length >= 2) break;
        } catch (e) {
          add({
            type: "observation",
            stage: "collecting",
            agent: "Fetcher",
            payload: { subquestionId: qid, url: r.url, error: String(e?.message || e || "fetch_failed") }
          });

          const snippet = String(r?.snippet || "").trim();
          if (snippet) {
            docs.push({ url: r.url, title: r.title || "", text: snippet, via: "snippet" });
            add({
              type: "observation",
              stage: "collecting",
              agent: "Fetcher",
              payload: { subquestionId: qid, url: r.url, chars: snippet.length, via: "snippet" }
            });
            if (docs.length >= 2) break;
          }
        }
      }
    }

    collected.push({
      id: qid,
      question: String(sq?.question || ""),
      keywords: Array.isArray(sq?.keywords) ? sq.keywords : [],
      searchProvider: providerSet.length ? providerSet.join(",") : "unknown",
      results,
      docs
    });
  }
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

  for (const sq of subquestions) {
    const qid = String(sq?.id || "").trim() || "q?";
    const pack = collected.find((c) => c.id === qid) || { results: [], docs: [] };
    const urlToSource = new Map(
      (Array.isArray(pack.results) ? pack.results : [])
        .map((r) => [String(r?.url || "").trim(), String(r?.source || "").trim()])
        .filter(([u, s]) => u.startsWith("http") && s)
    );

    let ev;
    try {
      ev = await readEvidence({
        llmClient,
        topic: task.topic,
        subquestion: sq,
        docs: pack.docs,
        trace: (e) => add(e)
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

    let result;
    try {
      result = await writeSection({
        llmClient,
        topic: task.topic,
        subquestion: enrichedSq,
        trace: (e) => add(e)
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
    notes.push({
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
    });
    sections.push(result);
    add({
      type: "decision",
      stage: "writing",
      agent: "Coordinator",
      payload: { msg: "Section drafted", subquestionId: qid, sources: sectionSources.slice(0, 3) }
    });
  }

  store.putArtifact(taskId, "notes.json", { notes });

  // 生成“摘要/结论”（不严格依赖 JSON；失败就留空，不影响出报告）
  let overview = "";
  let conclusion = "";
  try {
    const { chatWithRetry } = await import("./llmChat.js");
    const brief = sections
      .map((s, i) => `${i + 1}. ${s.heading}\n- ${(s.summary || []).slice(0, 4).join("；")}`)
      .join("\n\n");
    add({ type: "action", stage: "writing", agent: "Coordinator", payload: { msg: "Generate overview & conclusion" } });
    overview = await chatWithRetry({
      llmClient,
      stage: "writing",
      agent: "Coordinator",
      meta: { kind: "overview" },
      retries: 4,
      maxTokens: 1200,
      messages: [
        { role: "system", content: "你是严谨的研究报告编辑，用中文输出，不要虚构数据。" },
        {
          role: "user",
          content:
            `主题：${task.topic}\n\n基于以下章节要点，写一段 280-420 字的报告摘要：\n\n${brief}`
        }
      ]
    });
    conclusion = await chatWithRetry({
      llmClient,
      stage: "writing",
      agent: "Coordinator",
      meta: { kind: "conclusion" },
      retries: 4,
      maxTokens: 1600,
      messages: [
        { role: "system", content: "你是严谨的研究报告编辑，用中文输出，不要虚构数据。" },
        {
          role: "user",
          content:
            `主题：${task.topic}\n\n基于以下章节要点，写一段 520-900 字的结论（包含：1) 核心判断 2) 2-4 条建议 3) 1-2 条风险提示）：\n\n${brief}`
        }
      ]
    });
    add({ type: "observation", stage: "writing", agent: "Coordinator", payload: { msg: "Overview & conclusion generated" } });
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
        const moreResults = await webSearch({ query, topK: 8 });
        const docs = [];
        for (const r of moreResults.slice(0, 4)) {
          const snippet = String(r?.snippet || "").trim();
          if (snippet) docs.push({ url: r.url, title: r.title || "", text: snippet, via: "snippet" });
        }
        const ev2 = await readEvidence({ llmClient, topic: task.topic, subquestion: { id: qid, question: note?.question }, docs, trace: (e) => add(e) });
        const enrichedSq2 = {
          id: qid,
          question: note?.question,
          keywords: note?.keywords || [],
          evidenceBullets: ev2.bullets
        };
        const sec2 = await writeSection({ llmClient, topic: task.topic, subquestion: enrichedSq2, trace: (e) => add(e) });
        sections[i] = sec2;
        notes[i] = { ...note, evidence: ev2, sources: sec2.sources, draft: sec2 };
      }

      if (needDeNumeric) {
        add({ type: "action", stage: "reviewing", agent: "Critic", payload: { id: qid, fix: "denumeric_rewrite" } });
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

        const raw = await chatWithRetry({
          llmClient,
          stage: "reviewing",
          agent: "Critic",
          meta: { id: qid },
          retries: 4,
          maxTokens: 1200,
          messages: [
            { role: "system", content: "你是严谨的 Critic，只输出 JSON。" },
            { role: "user", content: prompt }
          ]
        });

        // 复用 writer 的 JSON 抽取规则：直接让 writeSection 再走一次（避免重复实现解析）
        const sec3 = await writeSection({
          llmClient,
          topic: task.topic,
          subquestion: { ...sections[i], id: qid, question: note?.question, keywords: note?.keywords, evidenceBullets },
          trace: (e) => add(e)
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

  const reportMd = renderReportMarkdown({ topic: task.topic, plan, sections, overview, conclusion });
  store.putArtifact(taskId, "report.md", reportMd);

  store.setStatus(taskId, "done");
  add({
    type: "final",
    stage: "done",
    agent: "Coordinator",
    payload: { msg: "Task completed (sources + evidence-based writer)" }
  });
}

