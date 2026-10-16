# Hướng Dẫn Phát Triển Plugin Cho MDL Extension

Tài liệu này quy định chuẩn giao tiếp, cấu trúc dữ liệu và mẫu khung (template) để viết thêm các plugin bắt và tải video mới cho **MDL**.

---

## 1. Luồng Hoạt Động (Data Flow)

```text
[Trang Web (MAIN World)]
   │  injected.hook.js (Chặn fetch, XHR, URL.createObjectURL)
   ▼
[Content Script (ISOLATED World)]
   │  content.js (Lắng nghe window.postMessage -> gửi NEW_RAW_MEDIA)
   ▼
[Background Service Worker]
   │  background.js (Lưu vào tabMediaMap[tabId] -> bắn TAB_MEDIA_UPDATED)
   ▼
[Side Panel UI & Plugin Manager]
   │  panel.js -> pluginManager.normalizeAll(rawList)
   │  Lọc qua plugin.canHandle(item) -> biến đổi bằng plugin.process(matchedItems)
   ▼
[Download Engine]
   │  download-engine.js (Tải đa luồng, xử lý 429, giới hạn tốc độ, đóng gói MP4/TS)
```

---

## 2. Quy Chuẩn Giao Tiếp Của Plugin (Plugin Interface)

Mọi plugin đăng ký vào `PluginManager` bắt buộc phải là một Object có tối thiểu 3 thành phần:

| Thuộc tính / Hàm | Kiểu | Bắt buộc | Mô tả |
| :--- | :--- | :---: | :--- |
| `name` | `string` | Có | Tên hiển thị trên badge của thẻ video (nên dài 3–6 ký tự, VD: `"HLS"`, `"HLS-B"`). |
| `canHandle(item, rawList)` | `function` | Có | Trả về `true` nếu plugin nhận xử lý gói dữ liệu thô `item`. |
| `process(matchedItems, rawList)` | `function` | Có | Nhận mảng các `item` đã lọc từ `canHandle` và trả về mảng `StandardizedStream[]`. |

---

## 3. Cấu Trúc Dữ Liệu Chuẩn (Data Schemas)

### 3.1. Đầu vào: `RawMediaItem` (Nhận từ `background.js`)
```javascript
{
  tabId: 123456,                        // ID của tab chứa video
  url: "[https://example.com/watch/1](https://example.com/watch/1)",   // URL trang web hiện tại
  title: "Tên phim tập 1",              // Tiêu đề của tab
  blobUrl: "https://cdn.../hls.m3u8",   // URL của luồng bắt được (http/https hoặc blob:)
  content: "#EXTM3U\n...",              // Nội dung văn bản của playlist
  timestamp: 1760630000000              // Thời điểm bắt được
}
```

### 3.2. Đầu ra: `StandardizedStream` (Trả về từ `plugin.process()`)
```javascript
{
  id: "https://cdn.../hls.m3u8",        // ID định danh duy nhất của video (thường là URL Master/Media chính)
  rawBlobUrls: [                        // QUAN TRỌNG: Chứa tất cả URL liên quan (Master + các Media con)
    "https://cdn.../hls.m3u8",          // Dùng để xóa sạch toàn bộ luồng con khỏi bộ nhớ khi tải xong hoặc bấm X
    "https://cdn.../hls-720p.m3u8",
    "https://cdn.../hls-480p.m3u8"
  ],
  tabId: 123456,
  pluginName: "HLS-B",                  // Nhãn hiển thị trên thẻ video
  title: "Tên phim tập 1",              // Tên file đã loại bỏ ký tự cấm của hệ điều hành
  sourceUrl: "[https://example.com/](https://example.com/)...", // URL trang web gốc (hiển thị domain ở mục Complete)
  variants: [                           // Danh sách các độ phân giải (sắp xếp từ cao xuống thấp)
    {
      label: "720p",                    // Nhãn hiển thị ở dropdown và thumbnail
      resolution: "1280x720",           // Độ phân giải
      height: 720,                      // Chiều cao khung hình (số nguyên) để tự khớp với Setting chất lượng
      bandwidth: 2500000,               // Dùng để sort chất lượng từ cao xuống thấp
      sizeText: "126MB",                // Hiển thị góc dưới thumbnail (VD: "126MB" hoặc "150 segs")
      playlistUrl: "https://...",       // (Tùy chọn) URL playlist con nếu cần nạp trễ (lazy-fetch) khi bấm tải
      segments: [                       // Danh sách phân đoạn truyền cho DownloadEngine
        {
          index: 0,
          duration: 10.0,
          url: "https://cdn.../seg-0.ts",
          headers: {},
          byteRange: null               // Hoặc { start: 0, end: 102399, length: 102400 } nếu dùng Byte-Range
        }
      ]
    }
  ]
}
```

---

## 4. Template Chuẩn (`plugins/template.plugin.js`)

Sao chép file mẫu dưới đây khi tạo một plugin mới:

```javascript
export const TemplatePlugin = {
  // 1. Tên hiển thị trên badge (tối đa 5-6 ký tự)
  name: "CUSTOM",

  // 2. Tên miền áp dụng ("*" cho mọi trang, hoặc ["domain1.com", "domain2.org"])
  acceptDomains: ["*"],

  // Bước 1: Lọc gói dữ liệu thô thuộc về plugin này
  canHandle(item, rawList) {
    if (!item || !item.content || !item.blobUrl) return false;
    if (!this.isDomainMatched(item.url)) return false;

    const isTargetUrl = item.blobUrl.startsWith("http") || item.blobUrl.startsWith("blob:");
    const isHlsPlaylist = item.content.includes("#EXTM3U");

    return isTargetUrl && isHlsPlaylist;
  },

  // Bước 2: Chuẩn hóa dữ liệu thành danh sách StandardizedStream
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
    const latestTitle = matchedItems[matchedItems.length - 1]?.title || "Video";

    // A. Xử lý Master Playlist (đa chất lượng)
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

    // B. Xử lý Media Playlist đơn lẻ
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

  // --- CÁC HÀM TIỆN ÍCH ---
  isDomainMatched(pageUrl) {
    if (!this.acceptDomains || this.acceptDomains.includes("*")) return true;
    try {
      const hostname = new URL(pageUrl).hostname.toLowerCase();
      return this.