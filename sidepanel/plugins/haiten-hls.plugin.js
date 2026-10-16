export const HaitenHlsPlugin = {
  name: "HLS",

  canHandle(item) {
    return item.content && item.content.includes("#EXTM3U");
  },

  process(matchedItems) {
    const blobMap = new Map();
    const masters = [];
    const mediaPlaylists = [];

    for (const item of matchedItems) {
      blobMap.set(item.blobUrl, item);
      if (item.content.includes("#EXT-X-STREAM-INF")) {
        masters.push(item);
      } else if (item.content.includes("#EXTINF")) {
        mediaPlaylists.push(item);
      }
    }

    const usedMediaBlobs = new Set();
    const results = [];

    // Lấy tiêu đề mới nhất của tab (tránh tiêu đề tạm lúc trang chưa tải xong)
    const latestTitle = matchedItems[matchedItems.length - 1]?.title || "Video";

    for (const master of masters) {
      const variants = this.parseMaster(master.content, blobMap, usedMediaBlobs);
      if (variants.length > 0) {
        results.push({
          id: master.blobUrl,
          tabId: master.tabId,
          pluginName: this.name,
          title: this.sanitizeTitle(latestTitle || master.title),
          sourceUrl: master.url,
          variants
        });
      }
    }

    for (const media of mediaPlaylists) {
      if (!usedMediaBlobs.has(media.blobUrl)) {
        const { segments, totalBytes } = this.parseSegments(media.content);
        if (segments.length > 0) {
          results.push({
            id: media.blobUrl,
            tabId: media.tabId,
            pluginName: this.name,
            title: this.sanitizeTitle(latestTitle || media.title),
            sourceUrl: media.url,
            variants: [
              {
                label: "Auto",
                resolution: "Auto",
                height: 0,
                bandwidth: 0,
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

  parseMaster(masterText, blobMap, usedMediaBlobs) {
    const lines = masterText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const variants = [];

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("#EXT-X-STREAM-INF:")) {
        const infoLine = lines[i];
        const nextLine = lines[i + 1];
        if (!nextLine || nextLine.startsWith("#")) continue;

        const resMatch = infoLine.match(/RESOLUTION=(\d+x(\d+))/);
        const bwMatch = infoLine.match(/BANDWIDTH=(\d+)/);
        const resolution = resMatch ? resMatch[1] : "Auto";
        const height = resMatch ? parseInt(resMatch[2], 10) : 0;
        const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;

        const childBlob = blobMap.get(nextLine);
        if (childBlob) {
          usedMediaBlobs.add(nextLine);
          const { segments, totalBytes } = this.parseSegments(childBlob.content);
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
    return variants.sort((a, b) => b.bandwidth - a.bandwidth);
  },

  parseSegments(mediaText) {
    const lines = mediaText.split(/\r?\n/);
    const segments = [];
    let currentByteRange = null;
    let currentDuration = 0;
    let totalBytes = 0;

    for (let rawLine of lines) {
      const line = rawLine.trim();
      if (line.startsWith("#EXTINF:")) {
        currentDuration = parseFloat(line.split(":")[1]) || 0;
      } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
        const [length, offset] = line.split(":")[1].split("@").map(Number);
        currentByteRange = { start: offset, end: offset + length - 1, length };
        totalBytes += length;
      } else if (line.startsWith("http")) {
        segments.push({
          index: segments.length,
          duration: currentDuration,
          url: this.cleanRedirectUrl(line),
          headers: {},
          byteRange: currentByteRange
        });
        currentByteRange = null;
        currentDuration = 0;
      }
    }
    return { segments, totalBytes };
  },

  cleanRedirectUrl(rawUrl) {
    try {
      const urlObj = new URL(rawUrl);
      const refParam = urlObj.searchParams.get("ref");
      if (refParam) return decodeURIComponent(refParam);
    } catch (_) {}
    return rawUrl.replace(/^https?:\/\/[^/]+\/redirector\/v1\?ref=/, "");
  },

  sanitizeTitle(rawTitle) {
    return (rawTitle || "Video")
      .replace(/\.(mp4|ts|mkv|webm|m3u8|avi|mov)$/i, "") // Cắt đuôi file nếu có sẵn trong title
      .replace(/[\\/:*?"<>|]/g, " - ")
      .replace(/\s+/g, " ")
      .trim();
  }
};