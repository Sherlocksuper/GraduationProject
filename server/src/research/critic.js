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

function hasNumbers(text) {
  const s = String(text || "");
  return /\d|%|％|年|月|日/.test(s);
}

export function critiqueSection({ section, note }) {
  const issues = [];
  const sources = Array.isArray(section?.sources) ? section.sources : [];
  const hosts = uniq(sources.map(hostOf));

  if (sources.length < 2) {
    issues.push({
      code: "sources_too_few",
      message: `来源不足（${sources.length}），建议至少 2 条`,
      severity: "high",
      meta: { sources }
    });
  }
  if (hosts.length < 2 && sources.length >= 2) {
    issues.push({
      code: "sources_low_diversity",
      message: `来源域名多样性不足（${hosts.length}），建议至少 2 个不同域名`,
      severity: "medium",
      meta: { hosts }
    });
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

