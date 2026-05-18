function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function uniq(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}

/** 知识库命中写入的占位 URL，多段引用常落在同一 host，不应触发「补联网扩源」 */
function allSourcesAreInternalKb(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return false;
  return sources.every((u) => String(u).toLowerCase().includes("kb.local"));
}

/** 收集阶段未走外网、仅 KB 时，Critic 不应按「多域名网页」标准强拉补搜（否则每节多一轮 Reader+Writer+搜索，极慢） */
function isKbPrimaryCollect(note) {
  const sp = String(note?.searchProvider || "").trim().toLowerCase();
  if (sp === "kb" || sp === "kb_only") return true;
  if (sp.startsWith("kb+")) return false;
  return false;
}

function hasNumbers(text) {
  const s = String(text || "");
  return /\d|%|％|年|月|日/.test(s);
}

export function critiqueSection({ section, note }) {
  const issues = [];
  const sources = Array.isArray(section?.sources) ? section.sources : [];
  const hosts = uniq(sources.map(hostOf));
  const relaxWebSourceRules = isKbPrimaryCollect(note) || allSourcesAreInternalKb(sources);

  if (sources.length < 2) {
    if (!relaxWebSourceRules) {
      issues.push({
        code: "sources_too_few",
        message: `来源不足（${sources.length}），建议至少 2 条`,
        severity: "high",
        meta: { sources }
      });
    }
  }
  if (hosts.length < 2 && sources.length >= 2) {
    if (!relaxWebSourceRules) {
      issues.push({
        code: "sources_low_diversity",
        message: `来源域名多样性不足（${hosts.length}），建议至少 2 个不同域名`,
        severity: "medium",
        meta: { hosts }
      });
    }
  }

  const paragraphs = Array.isArray(section?.paragraphs) ? section.paragraphs : [];
  const evidenceSupports = (Array.isArray(note?.evidence?.bullets) ? note.evidence.bullets : [])
    .map((b) => String(b?.support || ""))
    .join("\n");

  if (paragraphs.some(hasNumbers) && !hasNumbers(evidenceSupports)) {
    issues.push({
      code: "numeric_claim_without_numeric_evidence",
      message: "正文包含数字/时间等硬断言，但证据引用未包含数字信息，建议降级表述或补充可核验来源",
      severity: "medium"
    });
  }

  return { issues };
}

