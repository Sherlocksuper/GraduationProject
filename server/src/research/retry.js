function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function isRetryableUpstreamError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("overloaded") ||
    msg.includes("try again later") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("econnreset") ||
    msg.includes("enotfound") ||
    msg.includes("429")
  );
}

export async function withRetry(fn, { retries = 3, baseDelayMs = 800, maxDelayMs = 8000, onRetry, isRetryable } = {}) {
  let attempt = 0;
  // attempt: 1..retries
  while (attempt < retries) {
    attempt++;
    try {
      return await fn({ attempt });
    } catch (err) {
      const retryable = (isRetryable || isRetryableUpstreamError)(err);
      if (!retryable || attempt >= retries) throw err;
      const backoff = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      const jitter = Math.floor(Math.random() * Math.min(250, backoff));
      const delayMs = backoff + jitter;
      onRetry?.({ attempt, delayMs, err });
      await sleep(delayMs);
    }
  }
  throw new Error("retry_exhausted");
}

