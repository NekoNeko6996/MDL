/**
 * @typedef {Object} RawMediaItem - Dữ liệu thô từ background.js gửi sang
 * @property {number} tabId        - ID của tab chứa video
 * @property {string} url          - URL trang web hiện tại (window.location.href)
 * @property {string} title        - Tiêu đề trang web (document.title)
 * @property {string} blobUrl      - URL bắt được (blob:..., hoặc https://...m3u8)
 * @property {string} content      - Nội dung văn bản của playlist (#EXTM3U...)
 * @property {number} timestamp    - Thời điểm bắt được luồng
 */

/**
 * @typedef {Object} SegmentItem - Cấu trúc 1 phân đoạn truyền vào DownloadEngine
 * @property {number} index        - Thứ tự phân đoạn (0, 1, 2...)
 * @property {number} duration     - Thời lượng phân đoạn (giây)
 * @property {string} url          - URL tải phân đoạn tuyệt đối (http/https)
 * @property {Object} headers      - Header tùy chỉnh khi fetch (nếu cần)
 * @property {{start: number, end: number, length: number}|null} byteRange - Dùng cho HLS Byte-Range
 */

/**
 * @typedef {Object} StreamVariant - Cấu trúc 1 tùy chọn chất lượng (1080p, 720p...)
 * @property {string} label        - Nhãn hiển thị trên UI (VD: "1080p", "720p", "Auto")
 * @property {string} resolution   - Độ phân giải (VD: "1920x1080", "Auto")
 * @property {number} height       - Chiều cao khung hình (1080, 720, 480... hoặc 0) để tự chọn chất lượng ưu tiên
 * @property {number} bandwidth    - Băng thông để sắp xếp chất lượng từ cao xuống thấp
 * @property {string} sizeText     - Nhãn dung lượng/số phân đoạn trên thumbnail (VD: "228MB" hoặc "150 segs")
 * @property {string} [playlistUrl]- (Tùy chọn) URL nạp trễ nếu trình phát chưa tải playlist con
 * @property {SegmentItem[]} segments - Danh sách các phân đoạn của chất lượng này
 */

/**
 * @typedef {Object} StandardizedStream - Đầu ra chuẩn hóa trả về cho panel.js
 * @property {string} id              - ID định danh duy nhất của video (thường lấy blobUrl chính)
 * @property {string[]} rawBlobUrls   - Mảng chứa TẤT CẢ blobUrl liên quan (Master + các Media con) để xóa sạch sau khi tải
 * @property {number} tabId           - ID của tab
 * @property {string} pluginName      - Tên ngắn hiển thị trên badge (VD: "HLS", "HLS-B", "CUSTOM")
 * @property {string} title           - Tên file video đã làm sạch ký tự đặc biệt
 * @property {string} sourceUrl       - URL trang web gốc (dùng hiển thị tên miền ở mục Complete)
 * @property {StreamVariant[]} variants - Danh sách các độ phân giải của video
 */

export const TemplatePlugin = {
  // 1. Tên hiển thị trên badge của thẻ video (Tối đa 5-6 ký tự để không vỡ khung UI)
  name: "TEMPLATE",

  // 2. Danh sách tên miền áp dụng ("*" nếu dùng cho mọi web, hoặc ["example.com", "sub.domain.org"])
  acceptDomains: ["*"],

  /**
   * Bước 1: Kiểm tra xem dữ liệu thô có thuộc phạm vi xử lý của Plugin này không
   * @param {RawMediaItem} item
   * @param {RawMediaItem[]} rawList
   * @returns {boolean}
   */
  canHandle(item, rawList) {
    if (!item || !item.content || !item.blobUrl) return false;

    // Kiểm tra tên miền trang web (nếu giới hạn domain)
    if (!this.isDomainMatched(item.url)) return false;

    // Điều kiện nhận diện riêng của plugin (VD: kiểm tra định dạng URL hoặc từ khóa trong content)
    const isTargetProtocol = item.blobUrl.startsWith("http") || item.blobUrl.startsWith("blob:");
    const isHlsContent = item.content.includes("#EXTM3U");

    return isTargetProtocol && isHlsContent;
  },

  /**
   * Bước 2: Biến đổi danh sách RawMediaItem đã lọc thành danh sách StandardizedStream
   * @param {RawMediaItem[]} matchedItems
   * @param {RawMediaItem[]} rawList
   * @returns {StandardizedStream[]}
   */
  process(matchedItems, rawList) {
    const itemMap = new Map();
    const masters = [];
    const mediaPlaylists = [];

    for (const item of matchedItems) {
      itemMap.set(item.blobUrl, item);
      itemMap.set(item.blobUrl.split("?")[0], item);

      if (item.content.includes("#EXT-X-STREAM-INF")) {
        masters.push(item);
      } else if (item.content.includes("#EXTINF")) {
        mediaPlaylists.push(item);
      }
    }

    const usedMediaUrls = new Set();
    const seenSignatures = new Set();
    const results = [];

    // Lấy tiêu đề mới nhất của tab
    const latestTitle = matchedItems[matchedItems.length - 1]?.title || "Video";

    // A. Xử lý các Master Playlist (chứa nhiều độ phân giải)
    for (const master of masters) {
      const childBlobUrls = [];
      const variants = this.parseMaster(master.content, master.blobUrl, itemMap, usedMediaUrls, childBlobUrls);

      if (variants.length > 0) {
        const signature = variants[0]?.segments?.[0]?.url || master.blobUrl;
        if (!seenSignatures.has(signature)) {
          seenSignatures.add(signature);
          results.push({
            id: master.blobUrl,
            rawBlobUrls: [master.blobUrl, ...childBlobUrls],
            tabId: master.tabId,
            pluginName: this.name,
            title: this.sanitizeTitle(latestTitle || master.title),
            sourceUrl: master.url,
            variants
          });
        }
      }
    }

    // B. Xử lý các Media Playlist đơn lẻ (không nằm trong Master Playlist nào)
    for (const media of mediaPlaylists) {
      const cleanUrl = media.blobUrl.split("?")[0];
      if (usedMediaUrls.has(media.blobUrl) || usedMediaUrls.has(cleanUrl)) continue;

      const { segments, totalBytes } = this.parseSegments(media.content, media.blobUrl);
      if (segments.length > 0) {
        const signature = segments[0]?.url || media.blobUrl;
        if (!seenSignatures.has(signature)) {
          seenSignatures.add(signature);
          const height = this.extractHeightFromUrl(media.blobUrl);
          const label = height ? `${height}p` : "Auto";

          results.push({
            id: media.blobUrl,
            rawBlobUrls: [media.blobUrl],
            tabId: media.tabId,
            pluginName: this.name,
            title: this.sanitizeTitle(latestTitle || media.title),
            sourceUrl: media.url,
            variants: [
              {
                label,
                resolution: label,
                height,
                bandwidth: height * 1000,
                sizeText: totalBytes > 0 ? `${Math.round(totalBytes / 1048576)}MB` : `${segments.length} segs`,
                segments
              }
            ]
          });
        }
      }
    }

    return results;
  },

  /**
   * Phân tích Master Playlist (#EXT-X-STREAM-INF)
   */
  parseMaster(masterText, masterUrl, itemMap, usedMediaUrls, childBlobUrls = []) {
    const lines = masterText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const variants = [];

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("#EXT-X-STREAM-INF:")) {
        const infoLine = lines[i];
        const nextLine = lines[i + 1];
        if (!nextLine || nextLine.startsWith("#")) continue;

        const childUrl = this.resolveUrl(nextLine, masterUrl);
        const cleanChildUrl = childUrl.split("?")[0];

        usedMediaUrls.add(childUrl);
        usedMediaUrls.add(cleanChildUrl);
        childBlobUrls.push(childUrl);

        const resMatch = infoLine.match(/RESOLUTION=(\d+x(\d+))/i);
        const bwMatch = infoLine.match(/BANDWIDTH=(\d+)/i);
        const height = resMatch ? parseInt(resMatch[2], 10) : this.extractHeightFromUrl(nextLine);
        const resolution = resMatch ? resMatch[1] : (height ? `${height}p` : "Auto");
        const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : (height * 1000);

        const childItem = itemMap.get(childUrl) || itemMap.get(cleanChildUrl);
        if (childItem) {
          if (!childBlobUrls.includes(childItem.blobUrl)) {
            childBlobUrls.push(childItem.blobUrl);
          }
          const { segments, totalBytes } = this.parseSegments(childItem.content, childItem.blobUrl);
          if (segments.length > 0) {
            variants.push({
              label: height ? `${height}p` : resolution,
              resolution,
              height,
              bandwidth,
              sizeText: totalBytes > 0 ? `${Math.round(totalBytes / 1048576)}MB` : `${segments.length} segs`,
              segments
            });
          }
        }
      }
    }

    return variants.sort((a, b) => b.bandwidth - a.bandwidth);
  },

  /**
   * Phân tích Media Playlist (#EXTINF) thành danh sách phân đoạn
   */
  parseSegments(mediaText, playlistUrl) {
    const lines = mediaText.split(/\r?\n/);
    const segments = [];
    let currentByteRange = null;
    let currentDuration = 0;
    let totalBytes = 0;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line.startsWith("#EXTINF:")) {
        currentDuration = parseFloat(line.split(":")[1]) || 0;
      } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
        const [length, offset] = line.split(":")[1].split("@").map(Number);
        currentByteRange = { start: offset, end: offset + length - 1, length };
        totalBytes += length;
      } else if (!line.startsWith("#")) {
        segments.push({
          index: segments.length,
          duration: currentDuration,
          url: this.resolveUrl(line, playlistUrl),
          headers: {},
          byteRange: currentByteRange
        });
        currentByteRange = null;
        currentDuration = 0;
      }
    }

    return { segments, totalBytes };
  },

  // --- CÁC HÀM TIỆN ÍCH DÙNG CHUNG ---

  isDomainMatched(pageUrl) {
    if (!this.acceptDomains || this.acceptDomains.includes("*")) return true;
    try {
      const hostname = new URL(pageUrl).hostname.toLowerCase();
      return this.acceptDomains.some(d => hostname === d.toLowerCase() || hostname.endsWith(`.${d.toLowerCase()}`));
    } catch (_) {
      return false;
    }
  },

  resolveUrl(targetPath, baseUrl) {
    const cleanTarget = (targetPath || "").trim();
    if (!cleanTarget) return "";
    if (/^(https?:|blob:)/i.test(cleanTarget)) return this.cleanRedirectUrl(cleanTarget);

    try {
      return this.cleanRedirectUrl(new URL(cleanTarget, baseUrl).href);
    } catch (_) {
      const baseClean = (baseUrl || "").split("?")[0];
      const slashIdx = baseClean.lastIndexOf("/");
      const baseDir = slashIdx !== -1 ? baseClean.slice(0, slashIdx + 1) : baseClean + "/";
      return this.cleanRedirectUrl(baseDir + cleanTarget.replace(/^\/+/, ""));
    }
  },

  extractHeightFromUrl(url) {
    const match = (url || "").match(/[-_/](2160|1440|1080|720|480|360|240|144)p?\b/i);
    return match ? parseInt(match[1], 10) : 0;
  },

  cleanRedirectUrl(rawUrl) {
    try {
      const urlObj = new URL(rawUrl);
      const refParam = urlObj.searchParams.get("ref") || urlObj.searchParams.get("url");
      if (refParam) return decodeURIComponent(refParam);
    } catch (_) {}
    return rawUrl;
  },

  sanitizeTitle(rawTitle) {
    return (rawTitle || "Video")
      .replace(/\.(mp4|ts|mkv|webm|m3u8|avi|mov)$/i, "")
      .replace(/[\\/:*?"<>|]/g, " - ")
      .replace(/\s+/g, " ")
      .trim();
  }
};