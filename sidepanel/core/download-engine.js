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

  // Loại bỏ header PNG/rác ngụy trang ở đầu phân đoạn TS (nếu có)
  static normalizeTsSegment(buffer) {
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const len = u8.byteLength;
    if (len >= 188 && u8[0] === 0x47 && (len < 376 || u8[188] === 0x47)) {
      return u8;
    }
    const limit = Math.min(len - 188, 8192);
    for (let i = 0; i < limit; i++) {
      if (u8[i] === 0x47 && u8[i + 188] === 0x47) {
        if (i + 376 >= len || u8[i + 376] === 0x47) {
          return u8.subarray(i);
        }
      }
    }
    return u8;
  }

  static async downloadAndBuild({
    segments,
    concurrency = 8,
    segmentDelay = 0,
    maxSpeed = 0, // MB/s (0 = Unlimited)
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
    let autoThrottleDelayMs = 0;
    let nextAllowedRequestAt = 0;

    // Biến phục vụ giới hạn tốc độ tải (MB/s)
    const maxBytesPerSec = maxSpeed > 0 ? maxSpeed * 1048576 : 0;
    let bwWindowStart = performance.now();
    let bwBytesInWindow = 0;

    async function consumeResponseWithSpeedLimit(res) {
      if (!maxBytesPerSec || !res.body) {
        return await res.arrayBuffer();
      }

      const reader = res.body.getReader();
      const chunks = [];
      let totalLen = 0;

      while (true) {
        if (signal?.aborted) {
          await reader.cancel();
          throw new DOMException("Aborted", "AbortError");
        }
        const { done, value } = await reader.read();
        if (done) break;

        chunks.push(value);
        totalLen += value.byteLength;

        const now = performance.now();
        if (now - bwWindowStart > 1500) {
          bwWindowStart = now;
          bwBytesInWindow = 0;
        }
        bwBytesInWindow += value.byteLength;

        const expectedMs = (bwBytesInWindow / maxBytesPerSec) * 1000;
        const elapsedMs = now - bwWindowStart;
        if (expectedMs > elapsedMs + 15) {
          await DownloadEngine.sleep(Math.round(expectedMs - elapsedMs), signal);
        }
      }

      const merged = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return merged.buffer;
    }

    async function waitBeforeRequest() {
      while (Date.now() < rateLimitUntil) {
        const waitMs = rateLimitUntil - Date.now();
        if (onStatus) {
          onStatus(`Chờ giới hạn 429 (${Math.ceil(waitMs / 1000)}s)... ${completed}/${total}`);
        }
        await DownloadEngine.sleep(Math.min(waitMs, 1000), signal);
      }

      // Điều phối giãn cách giữa các request trên toàn bộ các luồng
      const effectiveDelay = Math.max(segmentDelay, autoThrottleDelayMs);
      if (effectiveDelay > 0) {
        const now = Date.now();
        const scheduledAt = Math.max(now, nextAllowedRequestAt);
        nextAllowedRequestAt = scheduledAt + effectiveDelay;
        const waitMs = scheduledAt - now;
        if (waitMs > 0) {
          await DownloadEngine.sleep(waitMs, signal);
        }
      }
    }

    async function fetchSegment(seg) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      await waitBeforeRequest();

      if (seg.byteRange) {
        const rangeHeaders = {
          ...seg.headers,
          Range: `bytes=${seg.byteRange.start}-${seg.byteRange.end}`
        };
        const res = await fetch(seg.url, { headers: rangeHeaders, signal });

        if (res.status === 206) {
          const buf = await consumeResponseWithSpeedLimit(res);
          return DownloadEngine.normalizeTsSegment(buf);
        }
        if (res.status === 200) {
          const fullBuf = await consumeResponseWithSpeedLimit(res);
          const sliced = fullBuf.slice(seg.byteRange.start, seg.byteRange.end + 1);
          return DownloadEngine.normalizeTsSegment(sliced);
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

      const buf = await consumeResponseWithSpeedLimit(res);
      if (seg.byteRange && buf.byteLength > seg.byteRange.start) {
        return DownloadEngine.normalizeTsSegment(buf.slice(seg.byteRange.start, seg.byteRange.end + 1));
      }
      return DownloadEngine.normalizeTsSegment(buf);
    }

    async function worker() {
      while (currentIndex < total) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const idx = currentIndex++;

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
              autoThrottleDelayMs = Math.min(600, autoThrottleDelayMs + 150);

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
    return this.remuxToStandardMp4(buffers);
  }

  // --- BỘ ĐÓNG GÓI STANDARD MP4 (FTYP + MOOV + MDAT) CÓ CHỈ MỤC SEEK ĐẦY ĐỦ ---
  static remuxToStandardMp4(buffers) {
    if (typeof muxjs === "undefined" || !muxjs.mp2t) {
      return { blob: new Blob(buffers, { type: "video/mp2t" }), ext: "ts" };
    }

    const packetStream = new muxjs.mp2t.TransportPacketStream();
    const parseStream = new muxjs.mp2t.TransportParseStream();
    const elementaryStream = new muxjs.mp2t.ElementaryStream();
    const timestampRollover = new muxjs.mp2t.TimestampRolloverStream();
    const adtsStream = new muxjs.codecs.Adts();
    const spsParserStream = new muxjs.codecs.h264.H264Stream();

    packetStream.pipe(parseStream).pipe(elementaryStream).pipe(timestampRollover);

    let spsConfig = null;
    spsParserStream.on("data", (nal) => {
      if (nal.nalUnitType === "seq_parameter_set_rbsp" && nal.config) {
        spsConfig = nal.config;
      }
    });

    const videoSamples = [];
    const audioSamples = [];
    let spsNal = null;
    let ppsNal = null;
    let audioMeta = null;
    let pendingVideoFrame = null;

    function flushPendingVideoFrame() {
      if (!pendingVideoFrame || pendingVideoFrame.vclCount === 0) {
        pendingVideoFrame = null;
        return;
      }
      let totalSize = 0;
      for (const nal of pendingVideoFrame.nals) {
        totalSize += 4 + nal.byteLength;
      }
      const sampleData = new Uint8Array(totalSize);
      const view = new DataView(sampleData.buffer);
      let offset = 0;
      for (const nal of pendingVideoFrame.nals) {
        view.setUint32(offset, nal.byteLength);
        offset += 4;
        sampleData.set(nal, offset);
        offset += nal.byteLength;
      }
      videoSamples.push({
        data: sampleData,
        size: totalSize,
        pts: pendingVideoFrame.pts,
        dts: pendingVideoFrame.dts,
        isKeyframe: pendingVideoFrame.isKeyframe
      });
      pendingVideoFrame = null;
    }

    adtsStream.on("data", (frame) => {
      if (!audioMeta) {
        audioMeta = {
          audioobjecttype: frame.audioobjecttype,
          channelcount: frame.channelcount,
          samplerate: frame.samplerate,
          samplingfrequencyindex: frame.samplingfrequencyindex,
          samplesize: frame.samplesize || 16
        };
      }
      const copy = new Uint8Array(frame.data.byteLength);
      copy.set(frame.data);
      audioSamples.push({
        data: copy,
        size: copy.byteLength,
        pts: frame.pts,
        dts: frame.dts
      });
    });

    timestampRollover.on("data", (pes) => {
      if (pes.type === "audio") {
        adtsStream.push(pes);
      } else if (pes.type === "video") {
        const nals = DownloadEngine.extractAnnexBNals(pes.data);
        if (nals.length === 0) return;

        if (pes.pts !== undefined && pendingVideoFrame && pendingVideoFrame.vclCount > 0) {
          flushPendingVideoFrame();
        }
        if (!pendingVideoFrame) {
          const pts = pes.pts !== undefined ? pes.pts : (videoSamples[videoSamples.length - 1]?.pts || 0);
          const dts = pes.dts !== undefined ? pes.dts : pts;
          pendingVideoFrame = { pts, dts, nals: [], vclCount: 0, isKeyframe: false };
        }

        for (const nal of nals) {
          if (nal.byteLength === 0) continue;
          const nalType = nal[0] & 0x1f;

          if (nalType === 7) {
            if (!spsNal) {
              spsNal = new Uint8Array(nal);
              // Đẩy qua H264Stream của mux.js để lấy kích thước width/height chuẩn từ SPS
              const tmp = new Uint8Array(spsNal.byteLength + 10);
              tmp.set([0, 0, 0, 1], 0);
              tmp.set(spsNal, 4);
              tmp.set([0, 0, 0, 1, 9, 0xf0], 4 + spsNal.byteLength);
              spsParserStream.push({ type: "video", pts: 0, dts: 0, data: tmp });
              spsParserStream.flush();
            }
          } else if (nalType === 8) {
            if (!ppsNal) ppsNal = new Uint8Array(nal);
          } else if (nalType === 9) {
            // Nếu gặp AUD mới khi đã có slice hình trước đó trong cùng PES -> tách frame
            if (pendingVideoFrame.vclCount > 0) {
              const prevPts = pendingVideoFrame.pts;
              const prevDts = pendingVideoFrame.dts;
              flushPendingVideoFrame();
              pendingVideoFrame = { pts: prevPts + 3000, dts: prevDts + 3000, nals: [], vclCount: 0, isKeyframe: false };
            }
          } else if (nalType >= 1 && nalType <= 5) {
            if (nalType === 5) pendingVideoFrame.isKeyframe = true;
            pendingVideoFrame.nals.push(new Uint8Array(nal));
            pendingVideoFrame.vclCount++;
          } else if (nalType === 6) {
            pendingVideoFrame.nals.push(new Uint8Array(nal));
          }
        }
      }
    });

    for (let i = 0; i < buffers.length; i++) {
      const u8 = DownloadEngine.normalizeTsSegment(buffers[i]);
      packetStream.push(u8);
      packetStream.flush();
      adtsStream.flush();
    }
    flushPendingVideoFrame();

    if (videoSamples.length === 0 && audioSamples.length === 0) {
      return { blob: new Blob(buffers, { type: "video/mp2t" }), ext: "ts" };
    }

    try {
      return DownloadEngine.buildStandardMp4Blob({
        videoSamples,
        audioSamples,
        spsNal,
        ppsNal,
        spsConfig,
        audioMeta
      });
    } catch (e) {
      console.error("MP4 Mux Error, fallback to TS:", e);
      return { blob: new Blob(buffers, { type: "video/mp2t" }), ext: "ts" };
    }
  }

  static extractAnnexBNals(u8) {
    const nals = [];
    const len = u8.byteLength;
    let nalStart = -1;
    let i = 0;

    while (i < len - 3) {
      if (u8[i] === 0 && u8[i + 1] === 0) {
        if (u8[i + 2] === 1) {
          if (nalStart >= 0 && i > nalStart) {
            nals.push(u8.subarray(nalStart, i));
          }
          nalStart = i + 3;
          i += 3;
          continue;
        } else if (u8[i + 2] === 0 && u8[i + 3] === 1) {
          if (nalStart >= 0 && i > nalStart) {
            nals.push(u8.subarray(nalStart, i));
          }
          nalStart = i + 4;
          i += 4;
          continue;
        }
      }
      i++;
    }
    if (nalStart >= 0 && nalStart < len) {
      nals.push(u8.subarray(nalStart, len));
    }
    return nals;
  }

  static box(type, ...payloads) {
    let size = 8;
    for (const p of payloads) size += p.byteLength;
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    view.setUint32(0, size);
    out[4] = type.charCodeAt(0);
    out[5] = type.charCodeAt(1);
    out[6] = type.charCodeAt(2);
    out[7] = type.charCodeAt(3);
    let offset = 8;
    for (const p of payloads) {
      out.set(p, offset);
      offset += p.byteLength;
    }
    return out;
  }

  static buildStandardMp4Blob({ videoSamples, audioSamples, spsNal, ppsNal, spsConfig, audioMeta }) {
    const box = DownloadEngine.box;
    const hasVideo = videoSamples.length > 0 && spsNal && ppsNal;
    const hasAudio = audioSamples.length > 0 && audioMeta;

    // 1. Tính toán bảng thời gian và kích thước cho Video Track (timescale = 90000)
    let videoDuration90k = 0;
    let videoSttsEntries = [];
    let videoCttsEntries = [];
    let videoKeyframes = [];
    let videoSizes = new Uint32Array(hasVideo ? videoSamples.length : 0);

    if (hasVideo) {
      const n = videoSamples.length;
      const deltas = new Uint32Array(n);
      const ctos = new Int32Array(n);
      let minCto = 0;

      for (let i = 0; i < n; i++) {
        const cur = videoSamples[i];
        videoSizes[i] = cur.size;
        if (cur.isKeyframe) videoKeyframes.push(i + 1);

        if (i < n - 1) {
          const d = videoSamples[i + 1].dts - cur.dts;
          deltas[i] = d > 0 && d < 450000 ? d : 3000;
        } else {
          deltas[i] = i > 0 ? deltas[i - 1] : 3000;
        }
        videoDuration90k += deltas[i];

        const cto = Math.round(cur.pts - cur.dts);
        ctos[i] = cto;
        if (cto < minCto) minCto = cto;
      }

      if (videoKeyframes.length === 0) videoKeyframes.push(1);

      // Nén RLE cho stts
      let curDelta = deltas[0];
      let count = 1;
      for (let i = 1; i < n; i++) {
        if (deltas[i] === curDelta) {
          count++;
        } else {
          videoSttsEntries.push(count, curDelta);
          curDelta = deltas[i];
          count = 1;
        }
      }
      videoSttsEntries.push(count, curDelta);

      // Nén RLE cho ctts (dịch bù minCto để toàn bộ offset >= 0 chuẩn version 0)
      let curCto = ctos[0] - minCto;
      let ctoCount = 1;
      for (let i = 1; i < n; i++) {
        const val = ctos[i] - minCto;
        if (val === curCto) {
          ctoCount++;
        } else {
          videoCttsEntries.push(ctoCount, curCto);
          curCto = val;
          ctoCount = 1;
        }
      }
      videoCttsEntries.push(ctoCount, curCto);
    }

    // 2. Tính toán cho Audio Track (timescale = samplerate, mỗi frame AAC = 1024 mẫu)
    let audioDurationSr = 0;
    let audioSizes = new Uint32Array(hasAudio ? audioSamples.length : 0);
    if (hasAudio) {
      for (let i = 0; i < audioSamples.length; i++) {
        audioSizes[i] = audioSamples[i].size;
      }
      audioDurationSr = audioSamples.length * 1024;
    }

    const videoDurationMs = hasVideo ? Math.round((videoDuration90k / 90000) * 1000) : 0;
    const audioDurationMs = hasAudio ? Math.round((audioDurationSr / audioMeta.samplerate) * 1000) : 0;
    const movieDurationMs = Math.max(videoDurationMs, audioDurationMs, 1);

    // 3. Sắp xếp đan xen (Interleave) các mẫu Video và Audio theo thời gian thực để trình phát đọc mượt
    const combinedQueue = [];
    if (hasVideo) {
      const baseVDts = videoSamples[0].dts;
      for (let i = 0; i < videoSamples.length; i++) {
        combinedQueue.push({
          type: "v",
          index: i,
          timeSec: (videoSamples[i].dts - baseVDts) / 90000,
          data: videoSamples[i].data,
          size: videoSamples[i].size
        });
      }
    }
    if (hasAudio) {
      const baseADts = audioSamples[0].dts;
      for (let i = 0; i < audioSamples.length; i++) {
        combinedQueue.push({
          type: "a",
          index: i,
          timeSec: (audioSamples[i].dts - baseADts) / 90000,
          data: audioSamples[i].data,
          size: audioSamples[i].size
        });
      }
    }
    combinedQueue.sort((a, b) => a.timeSec - b.timeSec);

    const videoOffsets = new Uint32Array(hasVideo ? videoSamples.length : 0);
    const audioOffsets = new Uint32Array(hasAudio ? audioSamples.length : 0);
    let totalMdatPayloadSize = 0;
    for (const item of combinedQueue) {
      if (item.type === "v") {
        videoOffsets[item.index] = totalMdatPayloadSize;
      } else {
        audioOffsets[item.index] = totalMdatPayloadSize;
      }
      totalMdatPayloadSize += item.size;
    }

    // Hàm dựng trak để tính kích thước moov trước, sau đó điền offset thực tế
    function buildMoov(baseDataOffset) {
      const trakBoxes = [];
      let nextTrackId = 1;

      if (hasVideo) {
        const width = spsConfig?.width || 1920;
        const height = spsConfig?.height || 1080;
        const profileIdc = spsConfig?.profileIdc || spsNal[1] || 100;
        const profileCompat = spsConfig?.profileCompatibility || spsNal[2] || 0;
        const levelIdc = spsConfig?.levelIdc || spsNal[3] || 40;

        const avcC = box("avcC", new Uint8Array([
          1, profileIdc, profileCompat, levelIdc, 0xff,
          0xe1, (spsNal.byteLength >>> 8) & 0xff, spsNal.byteLength & 0xff,
          ...spsNal,
          1, (ppsNal.byteLength >>> 8) & 0xff, ppsNal.byteLength & 0xff,
          ...ppsNal
        ]));

        const avc1Header = new Uint8Array(78);
        const avc1View = new DataView(avc1Header.buffer);
        avc1View.setUint16(6, 1); // data_reference_index
        avc1View.setUint16(24, width);
        avc1View.setUint16(26, height);
        avc1View.setUint32(28, 0x00480000); // 72 dpi
        avc1View.setUint32(32, 0x00480000);
        avc1View.setUint16(40, 1); // frame_count
        avc1View.setUint16(74, 0x0018); // depth = 24
        avc1View.setInt16(76, -1);

        const stsd = box("stsd", new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), box("avc1", avc1Header, avcC));

        const sttsBuf = new Uint8Array(8 + videoSttsEntries.length * 4);
        const sttsView = new DataView(sttsBuf.buffer);
        sttsView.setUint32(4, videoSttsEntries.length / 2);
        for (let i = 0; i < videoSttsEntries.length; i++) {
          sttsView.setUint32(8 + i * 4, videoSttsEntries[i]);
        }
        const stts = box("stts", sttsBuf);

        const cttsBuf = new Uint8Array(8 + videoCttsEntries.length * 4);
        const cttsView = new DataView(cttsBuf.buffer);
        cttsView.setUint32(4, videoCttsEntries.length / 2);
        for (let i = 0; i < videoCttsEntries.length; i++) {
          cttsView.setUint32(8 + i * 4, videoCttsEntries[i]);
        }
        const ctts = box("ctts", cttsBuf);

        const stssBuf = new Uint8Array(8 + videoKeyframes.length * 4);
        const stssView = new DataView(stssBuf.buffer);
        stssView.setUint32(4, videoKeyframes.length);
        for (let i = 0; i < videoKeyframes.length; i++) {
          stssView.setUint32(8 + i * 4, videoKeyframes[i]);
        }
        const stss = box("stss", stssBuf);

        const stsc = box("stsc", new Uint8Array([
          0, 0, 0, 0,
          0, 0, 0, 1,
          0, 0, 0, 1,
          0, 0, 0, 1,
          0, 0, 0, 1
        ]));

        const stszBuf = new Uint8Array(12 + videoSizes.length * 4);
        const stszView = new DataView(stszBuf.buffer);
        stszView.setUint32(8, videoSizes.length);
        for (let i = 0; i < videoSizes.length; i++) {
          stszView.setUint32(12 + i * 4, videoSizes[i]);
        }
        const stsz = box("stsz", stszBuf);

        const stcoBuf = new Uint8Array(8 + videoOffsets.length * 4);
        const stcoView = new DataView(stcoBuf.buffer);
        stcoView.setUint32(4, videoOffsets.length);
        for (let i = 0; i < videoOffsets.length; i++) {
          stcoView.setUint32(8 + i * 4, baseDataOffset + videoOffsets[i]);
        }
        const stco = box("stco", stcoBuf);

        const stbl = box("stbl", stsd, stts, ctts, stss, stsc, stsz, stco);
        const vmhd = box("vmhd", new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]));
        const dinf = box("dinf", box("dref", new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), box("url ", new Uint8Array([0, 0, 0, 1]))));
        const minf = box("minf", vmhd, dinf, stbl);

        const mdhdBuf = new Uint8Array(24);
        const mdhdView = new DataView(mdhdBuf.buffer);
        mdhdView.setUint32(12, 90000);
        mdhdView.setUint32(16, videoDuration90k);
        mdhdView.setUint16(20, 0x55c4);
        const mdhd = box("mdhd", mdhdBuf);

        const hdlr = box("hdlr", new Uint8Array([
          0, 0, 0, 0, 0, 0, 0, 0,
          118, 105, 100, 101, // "vide"
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          86, 105, 100, 101, 111, 72, 97, 110, 100, 108, 101, 114, 0
        ]));

        const mdia = box("mdia", mdhd, hdlr, minf);
        const tkhd = DownloadEngine.buildTkhd({
          trackId: nextTrackId++,
          durationMs: videoDurationMs,
          width,
          height,
          isAudio: false
        });

        trakBoxes.push(box("trak", tkhd, mdia));
      }

      if (hasAudio) {
        const sr = audioMeta.samplerate || 44100;
        const ch = audioMeta.channelcount || 2;
        const aot = audioMeta.audioobjecttype || 2;
        const sfi = audioMeta.samplingfrequencyindex ?? 4;

        const esds = box("esds", new Uint8Array([
          0, 0, 0, 0,
          3, 25, 0, 0, 0,
          4, 17, 64, 21, 0, 6, 0, 0, 0, 218, 192, 0, 0, 218, 192,
          5, 2, (aot << 3) | (sfi >>> 1), ((sfi & 1) << 7) | (ch << 3),
          6, 1, 2
        ]));

        const mp4aHeader = new Uint8Array(28);
        const mp4aView = new DataView(mp4aHeader.buffer);
        mp4aView.setUint16(6, 1);
        mp4aView.setUint16(16, ch);
        mp4aView.setUint16(18, 16);
        mp4aView.setUint16(24, sr);

        const stsd = box("stsd", new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), box("mp4a", mp4aHeader, esds));

        const sttsBuf = new Uint8Array(16);
        const sttsView = new DataView(sttsBuf.buffer);
        sttsView.setUint32(4, 1);
        sttsView.setUint32(8, audioSamples.length);
        sttsView.setUint32(12, 1024);
        const stts = box("stts", sttsBuf);

        const stsc = box("stsc", new Uint8Array([
          0, 0, 0, 0,
          0, 0, 0, 1,
          0, 0, 0, 1,
          0, 0, 0, 1,
          0, 0, 0, 1
        ]));

        const stszBuf = new Uint8Array(12 + audioSizes.length * 4);
        const stszView = new DataView(stszBuf.buffer);
        stszView.setUint32(8, audioSizes.length);
        for (let i = 0; i < audioSizes.length; i++) {
          stszView.setUint32(12 + i * 4, audioSizes[i]);
        }
        const stsz = box("stsz", stszBuf);

        const stcoBuf = new Uint8Array(8 + audioOffsets.length * 4);
        const stcoView = new DataView(stcoBuf.buffer);
        stcoView.setUint32(4, audioOffsets.length);
        for (let i = 0; i < audioOffsets.length; i++) {
          stcoView.setUint32(8 + i * 4, baseDataOffset + audioOffsets[i]);
        }
        const stco = box("stco", stcoBuf);

        const stbl = box("stbl", stsd, stts, stsc, stsz, stco);
        const smhd = box("smhd", new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]));
        const dinf = box("dinf", box("dref", new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), box("url ", new Uint8Array([0, 0, 0, 1]))));
        const minf = box("minf", smhd, dinf, stbl);

        const mdhdBuf = new Uint8Array(24);
        const mdhdView = new DataView(mdhdBuf.buffer);
        mdhdView.setUint32(12, sr);
        mdhdView.setUint32(16, audioDurationSr);
        mdhdView.setUint16(20, 0x55c4);
        const mdhd = box("mdhd", mdhdBuf);

        const hdlr = box("hdlr", new Uint8Array([
          0, 0, 0, 0, 0, 0, 0, 0,
          115, 111, 117, 110, // "soun"
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          83, 111, 117, 110, 100, 72, 97, 110, 100, 108, 101, 114, 0
        ]));

        const mdia = box("mdia", mdhd, hdlr, minf);
        const tkhd = DownloadEngine.buildTkhd({
          trackId: nextTrackId++,
          durationMs: audioDurationMs,
          width: 0,
          height: 0,
          isAudio: true
        });

        trakBoxes.push(box("trak", tkhd, mdia));
      }

      const mvhd = DownloadEngine.buildMvhd(movieDurationMs, nextTrackId);
      return box("moov", mvhd, ...trakBoxes);
    }

    const ftyp = box("ftyp", new Uint8Array([
      105, 115, 111, 109, // "isom"
      0, 0, 2, 0,
      105, 115, 111, 109, // "isom"
      105, 115, 111, 50,  // "iso2"
      97, 118, 99, 49,    // "avc1"
      109, 112, 52, 49    // "mp41"
    ]));

    // Chạy nháp lần 1 để lấy đúng độ dài byte của moov
    const dummyMoov = buildMoov(0);
    const baseDataOffset = ftyp.byteLength + dummyMoov.byteLength + 8; // +8 byte header của mdat
    const finalMoov = buildMoov(baseDataOffset);

    const mdatHeader = new Uint8Array(8);
    const mdatView = new DataView(mdatHeader.buffer);
    mdatView.setUint32(0, totalMdatPayloadSize + 8);
    mdatHeader[4] = 109; // 'm'
    mdatHeader[5] = 100; // 'd'
    mdatHeader[6] = 97;  // 'a'
    mdatHeader[7] = 116; // 't'

    const blobParts = [ftyp, finalMoov, mdatHeader];
    for (const item of combinedQueue) {
      blobParts.push(item.data);
    }

    return {
      blob: new Blob(blobParts, { type: "video/mp4" }),
      ext: "mp4"
    };
  }

  static buildMvhd(durationMs, nextTrackId) {
    const buf = new Uint8Array(100);
    const view = new DataView(buf.buffer);
    view.setUint32(12, 1000); // timescale = 1000 (ms)
    view.setUint32(16, durationMs);
    view.setUint32(20, 0x00010000); // rate = 1.0
    view.setUint16(24, 0x0100);     // volume = 1.0
    view.setUint32(36, 0x00010000); // unity matrix
    view.setUint32(52, 0x00010000);
    view.setUint32(68, 0x40000000);
    view.setUint32(96, nextTrackId);
    return DownloadEngine.box("mvhd", buf);
  }

  static buildTkhd({ trackId, durationMs, width, height, isAudio }) {
    const buf = new Uint8Array(84);
    const view = new DataView(buf.buffer);
    view.setUint32(0, 0x00000003); // flags: Track_enabled | Track_in_movie
    view.setUint32(12, trackId);
    view.setUint32(20, durationMs);
    view.setUint16(36, isAudio ? 0x0100 : 0); // volume = 1.0 cho audio
    view.setUint32(40, 0x00010000); // unity matrix
    view.setUint32(56, 0x00010000);
    view.setUint32(72, 0x40000000);
    view.setUint32(76, width << 16);
    view.setUint32(80, height << 16);
    return DownloadEngine.box("tkhd", buf);
  }
}