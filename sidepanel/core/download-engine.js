export class DownloadEngine {
  static sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        return reject(new DOMException("Aborted", "AbortError"));
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      function onAbort() {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  static async downloadAndBuild({
    segments,
    concurrency = 8,
    targetFormat = "mp4",
    existingBuffers = null,
    signal = null,
    onProgress,
    onStatus
  }) {
    const total = segments.length;
    const buffers = existingBuffers || new Array(total);
    let currentIndex = 0;
    let completed = buffers.reduce((acc, buf) => acc + (buf ? 1 : 0), 0);
    let rateLimitUntil = 0;
    let throttleDelayMs = 0;

    async function waitIfRateLimited() {
      while (Date.now() < rateLimitUntil) {
        const waitMs = rateLimitUntil - Date.now();
        if (onStatus) {
          onStatus(`Chờ giới hạn 429 (${Math.ceil(waitMs / 1000)}s)... ${completed}/${total}`);
        }
        await DownloadEngine.sleep(Math.min(waitMs, 1000), signal);
      }
      if (throttleDelayMs > 0) {
        await DownloadEngine.sleep(throttleDelayMs, signal);
      }
    }

    async function fetchSegment(seg) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      await waitIfRateLimited();

      if (seg.byteRange) {
        const rangeHeaders = {
          ...seg.headers,
          Range: `bytes=${seg.byteRange.start}-${seg.byteRange.end}`
        };
        const res = await fetch(seg.url, { headers: rangeHeaders, signal });

        if (res.status === 206) return await res.arrayBuffer();
        if (res.status === 200) {
          const fullBuf = await res.arrayBuffer();
          return fullBuf.slice(seg.byteRange.start, seg.byteRange.end + 1);
        }

        if (res.status === 429 || res.status >= 500) {
          const err = new Error(`HTTP ${res.status}`);
          err.status = res.status;
          err.retryAfter = parseInt(res.headers.get("Retry-After") || "0", 10);
          throw err;
        }
      }

      const res = await fetch(seg.url, { headers: seg.headers || {}, signal });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        err.retryAfter = parseInt(res.headers.get("Retry-After") || "0", 10);
        throw err;
      }

      const buf = await res.arrayBuffer();
      if (seg.byteRange && buf.byteLength > seg.byteRange.start) {
        return buf.slice(seg.byteRange.start, seg.byteRange.end + 1);
      }
      return buf;
    }

    async function worker() {
      while (currentIndex < total) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const idx = currentIndex++;

        // Bỏ qua các phân đoạn đã tải xong trước khi tạm dừng
        if (buffers[idx]) continue;

        const seg = segments[idx];
        let normalRetries = 3;
        let rateLimitRetries = 8;

        while (true) {
          try {
            buffers[idx] = await fetchSegment(seg);
            completed++;
            if (onProgress) onProgress(completed, total);
            break;
          } catch (err) {
            if (signal?.aborted || err.name === "AbortError") {
              throw new DOMException("Aborted", "AbortError");
            }
            if (err.status === 429) {
              if (rateLimitRetries <= 0) {
                throw new Error(`Lỗi phân đoạn #${idx + 1}: Quá giới hạn request (HTTP 429)`);
              }
              const attempt = 9 - rateLimitRetries;
              rateLimitRetries--;
              throttleDelayMs = Math.min(500, throttleDelayMs + 150);

              const backoffMs = err.retryAfter > 0
                ? err.retryAfter * 1000
                : Math.round(3500 * Math.pow(1.45, attempt - 1) + Math.random() * 1000);

              rateLimitUntil = Math.max(rateLimitUntil, Date.now() + backoffMs);
            } else {
              if (normalRetries <= 0) {
                throw new Error(`Lỗi phân đoạn #${idx + 1}: ${err.message}`);
              }
              normalRetries--;
              await DownloadEngine.sleep(1500, signal);
            }
          }
        }
      }
    }

    if (onStatus) onStatus(`Đang tải: ${completed}/${total} (${Math.round((completed / total) * 100)}%)`);
    const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker());
    await Promise.all(workers);

    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    if (targetFormat === "ts") {
      return {
        blob: new Blob(buffers, { type: "video/mp2t" }),
        ext: "ts"
      };
    }

    if (onStatus) onStatus("Đang đóng gói MP4...");
    return this.remuxToMp4(buffers);
  }

  static remuxToMp4(buffers) {
    if (typeof muxjs === "undefined") {
      return { blob: new Blob(buffers, { type: "video/mp2t" }), ext: "ts" };
    }

    const transmuxer = new muxjs.mp4.Transmuxer();
    const mp4Chunks = [];
    let initSegmentAdded = false;

    transmuxer.on("data", (segment) => {
      if (!initSegmentAdded) {
        mp4Chunks.push(segment.initSegment.buffer);
        initSegmentAdded = true;
      }
      mp4Chunks.push(segment.data.buffer);
    });

    for (const buf of buffers) {
      transmuxer.push(new Uint8Array(buf));
    }
    transmuxer.flush();

    if (mp4Chunks.length === 0) {
      return { blob: new Blob(buffers, { type: "video/mp2t" }), ext: "ts" };
    }

    return {
      blob: new Blob(mp4Chunks, { type: "video/mp4" }),
      ext: "mp4"
    };
  }
}