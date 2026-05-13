/** 常见纯文本扩展名（小写，含点） */
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".text",
  ".json",
  ".csv",
  ".tsv",
  ".log",
  ".xml",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".less",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".py",
  ".go",
  ".rs",
  ".rb",
  ".php",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".bat",
  ".cmd",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".cfg",
  ".env",
  ".rst",
  ".adoc",
  ".asciidoc",
  ".vue",
  ".svelte"
]);

function extOf(name) {
  const lower = String(name || "").toLowerCase();
  const i = lower.lastIndexOf(".");
  return i >= 0 ? lower.slice(i) : "";
}

/**
 * 是否按「纯文本」读取（扩展名或 MIME）。
 * 无扩展名且 MIME 为空时保守拒绝，避免误把二进制当 UTF-8。
 */
export function isLikelyTextFile(file) {
  if (!file || typeof file.name !== "string") return false;
  const ext = extOf(file.name);
  if (TEXT_EXTENSIONS.has(ext)) return true;
  const t = String(file.type || "").toLowerCase();
  if (t.startsWith("text/")) return true;
  if (t === "application/json" || t === "application/xml") return true;
  if (t === "application/javascript" || t === "application/x-javascript") return true;
  if (t === "application/typescript") return true;
  return false;
}

function readOneAsUtf8(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(new Error(`无法读取：${file.name}`));
    r.readAsText(file, "UTF-8");
  });
}

/**
 * @param {File} file
 * @param {(ratio: number) => void} [onProgress] ratio in [0,1] when lengthComputable
 */
function readOneAsUtf8WithProgress(file, onProgress) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onprogress = (e) => {
      if (e.lengthComputable && typeof onProgress === "function" && e.total > 0) {
        onProgress(Math.min(1, Math.max(0, e.loaded / e.total)));
      }
    };
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(new Error(`无法读取：${file.name}`));
    r.readAsText(file, "UTF-8");
  });
}

/**
 * 多文件按顺序合并为一段 UTF-8 文本（带文件名分隔），便于批量导入。
 * @param {FileList | File[]} fileList
 */
export async function readFilesAsUtf8Merged(fileList) {
  const files = Array.from(fileList || []).filter(isLikelyTextFile);
  if (!files.length) {
    throw new Error("未识别到支持的文本类文件（如 .txt、.md、.json 等）");
  }
  const parts = [];
  for (const f of files) {
    const body = await readOneAsUtf8(f);
    parts.push(`<!-- 文件: ${f.name} -->\n${body}`);
  }
  return parts.join("\n\n---\n\n");
}

/**
 * 顺序读取多文件并合并；onOverallProgress 在整体进度 [0,1] 时回调（按文件大小加权）。
 * @param {FileList | File[]} fileList
 * @param {(ratio: number) => void} [onOverallProgress]
 */
export async function readFilesAsUtf8MergedWithProgress(fileList, onOverallProgress) {
  const files = Array.from(fileList || []).filter(isLikelyTextFile);
  if (!files.length) {
    throw new Error("未识别到支持的文本类文件（如 .txt、.md、.json 等）");
  }
  const totalBytes = files.reduce((s, f) => s + (f.size || 0), 0);
  const parts = [];
  let doneBytes = 0;
  for (let i = 0; i < files.length; i += 1) {
    const f = files[i];
    const sz = f.size || 0;
    const body = await readOneAsUtf8WithProgress(f, (fileRatio) => {
      if (totalBytes > 0 && typeof onOverallProgress === "function") {
        const cur = doneBytes + sz * fileRatio;
        onOverallProgress(Math.min(1, Math.max(0, cur / totalBytes)));
      } else if (typeof onOverallProgress === "function") {
        const cur = (i + fileRatio) / files.length;
        onOverallProgress(Math.min(1, Math.max(0, cur)));
      }
    });
    doneBytes += sz;
    parts.push(`<!-- 文件: ${f.name} -->\n${body}`);
    if (totalBytes > 0 && typeof onOverallProgress === "function") {
      onOverallProgress(Math.min(1, Math.max(0, doneBytes / totalBytes)));
    } else if (typeof onOverallProgress === "function") {
      onOverallProgress(Math.min(1, Math.max(0, (i + 1) / files.length)));
    }
  }
  return parts.join("\n\n---\n\n");
}
