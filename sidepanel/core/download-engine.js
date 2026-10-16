export class DownloadEngine {
  static async downloadAndBuild({ segments, concurrency = 8, targetFormat = "mp4", onProgress, onStatus }) {
    const total = segments.length;
    const buffers = new Array(total);
    let currentIndex = 0;
    let completed = 0;

    async function fetchSegment(seg) {
      if (seg.byteRange) {
        try {
          const rangeHeaders = {
            ...seg.headers,
            Range: `bytes=${seg.byteRange.start}-${seg.byteRange.end}`
          };
          const res = await fetch(seg.url, { headers: rangeHeaders });
          if (res.status === 206) return await res.arrayBuffer();
          if (res.status === 200) {
            const fullBuf = await res.arrayBuffer();
            return fullBuf.slice(seg.byteRange.start, seg.byteRange.end + 1);
          }
        } catch (_) {}
      }

      const res = await fetch(seg.url, { headers: seg.headers || {} });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();

      if (seg.byteRange && buf.byteLength > seg.byteRange.start) {
        return buf.slice(seg.byteRange.start, seg.byteRange.end + 1);
      }
      return buf;
    }

    async function worker() {
      while (currentIndex < total) {
        const idx = currentIndex++;
        const seg = segments[idx];
        let retries = 2;

        while (retries >= 0) {
          try {
            buffers[idx] = await fetchSegment(seg);
            completed++;
            if (onProgress) onProgress(completed, total);
            break;
          } catch (err) {
            if (retries === 0) throw new Error(`Lỗi phân đoạn #${idx + 1}: ${err.message}`);
            retries--;
          }
        }
      }
    }

    if (onStatus) onStatus("Đang tải...");
    const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker());
    await Promise.all(workers);

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