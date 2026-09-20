// agent/lib/http.mjs — طلبات JSON مع إعادة محاولة بسيطة

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function getJson(url, { headers = {}, retries = 2, retryDelayMs = 3000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; hamza-predictions-agent)", ...headers } });
      if (res.status === 429) {
        // تجاوز حدّ الطلبات: انتظر ثم أعد المحاولة
        const wait = Number(res.headers.get("retry-after")) * 1000 || 65000;
        await sleep(wait);
        lastErr = new Error("429 rate limited");
        continue;
      }
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(`${res.status} ${json?.message ?? res.statusText}`);
      return json;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(retryDelayMs);
    }
  }
  throw lastErr;
}
