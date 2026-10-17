# MDL - Media Download Extension

**MDL** là tiện ích mở rộng trình duyệt (Chrome Extension Manifest V3) hoạt động trên thanh bên (Side Panel), chuyên dụng để dò tìm, phân tích và tải xuống các luồng video HLS (`#EXTM3U` / `.m3u8`) với kiến trúc hỗ trợ mở rộng thông qua hệ thống Plugin.

---

## Tính năng chính

* **Bắt luồng Media tự động (`MAIN` & `ISOLATED` World):**
  * Chặn bắt danh sách phát `#EXTM3U` trực tiếp từ `window.fetch`, `XMLHttpRequest` và `URL.createObjectURL` (Blob URL) ngay tại thời điểm `document_start`.
  * Quản lý danh sách video độc lập cho từng Tab, tự động cập nhật giao diện khi chuyển Tab hoặc tải lại trang.
* **Kiến trúc đa Plugin linh hoạt:**
  * **HaitenHlsPlugin (`HLS`):** Xử lý các luồng HLS tạo qua `blob:` URL, hỗ trợ phân đoạn `#EXT-X-BYTERANGE` và tự động lọc bỏ header ảnh ngụy trang (`.png`).
  * **BasicHLSPlugin (`HLS-B`):** Xử lý các luồng HLS tiêu chuẩn qua giao thức `http/https` với đường dẫn phân đoạn `.ts` tương đối hoặc tuyệt đối, tự động gom nhóm các độ phân giải (`1080p`, `720p`, `480p`, `360p`...).
* **Tải đa luồng & Kiểm soát hàng chờ (Download Queue):**
  * Tải đồng thời nhiều video và chia luồng tải phân đoạn (segment workers).
  * Hỗ trợ **Tạm dừng (Pause)**, **Tiếp tục (Resume)** và **Hủy (Cancel)** cho từng video hoặc thao tác hàng loạt (`Pause All`, `Resume All`, `Cancel All`) mà không làm mất các phân đoạn đã tải trong bộ nhớ đệm.
* **Chống giới hạn tốc độ (Anti Rate-Limit / HTTP 429):**
  * Cơ chế Global Cooldown và Exponential Backoff tự động tạm dừng chờ và thử lại khi máy chủ trả về lỗi `429 Too Many Requests`.
  * Cho phép tùy chỉnh thời gian trễ giữa các phân đoạn (`Delay between segments - ms`) và giới hạn băng thông tải tối đa (`Max speed - MB/s`).
* **Đóng gói MP4 & TS trực tiếp trên trình duyệt:**
  * Tích hợp `mux.js` cùng bộ đóng gói Standard MP4 (`ftyp + moov + mdat`) giúp xuất file `.mp4` hoàn chỉnh có đầy đủ âm thanh, hình ảnh và bảng chỉ mục thời gian (`stts`, `ctts`, `stss`, `stsz`, `stco`) để tua video mượt mà.
  * Hỗ trợ tùy chọn lưu trực tiếp định dạng gốc `.ts`.
* **Quản lý File & Lịch sử phiên:**
  * Đổi tên file trực tiếp trước khi tải, tự động làm sạch các ký tự không hợp lệ.
  * Lưu trữ thư mục tải mặc định qua `IndexedDB` (`FileSystemDirectoryHandle`) hoặc cấu hình thư mục con (`Subdirectory`).
  * Theo dõi lịch sử tải xuống trong phiên (`Complete`), hỗ trợ mở nhanh video, mở thư mục chứa file hoặc đẩy lại vào hàng chờ tải lại (`RE-DL`).

---

## Cấu trúc thư mục

```text
MDL/
├── manifest.json                 # Cấu hình Chrome Extension (Manifest V3)
├── background.js                 # Service Worker quản lý bộ đệm media theo từng Tab
├── content.js                    # Content Script (ISOLATED) cầu nối nhận dữ liệu từ trang web
├── injected.hook.js              # Script (MAIN) chặn bắt fetch, XHR và URL.createObjectURL
└── sidepanel/
    ├── index.html                # Giao diện người dùng trên Side Panel
    ├── panel.js                  # Logic điều khiển UI, hàng chờ tải, cài đặt và lịch sử
    ├── mux.min.js                # Thư viện hỗ trợ phân tích luồng MPEG-TS / H.264 / AAC
    ├── core/
    │   ├── download-engine.js    # Bộ tải đa luồng, giới hạn tốc độ, xử lý 429 và đóng gói MP4/TS
    │   └── plugin-manager.js     # Bộ đăng ký và chuẩn hóa dữ liệu từ các Plugin
    └── plugins/
        ├── haiten-hls.plugin.js  # Plugin xử lý luồng Blob HLS & Byte-Range
        ├── basichls.plugin.js    # Plugin xử lý luồng HTTP/HTTPS M3U8 tiêu chuẩn
        └── template.plugin.js    # Khung mẫu phát triển Plugin mới
```

---

## Cài đặt

1. Tải hoặc clone mã nguồn dự án về máy.
2. Mở trình duyệt Chrome / Edge / Brave và truy cập `chrome://extensions/`.
3. Bật chế độ **Developer mode** (Chế độ dành cho nhà phát triển) ở góc trên bên phải.
4. Nhấn **Load unpacked** (Tải tiện ích đã giải nén) và chọn thư mục gốc của dự án `MDL`.
5. Nhấn vào biểu tượng **MDL** trên thanh công cụ trình duyệt để mở Side Panel.

---

## Cấu hình (Settings)

Trong giao diện Side Panel, nhấn vào biểu tượng bánh răng (`⚙`) ở góc dưới bên trái để thiết lập:

| Tùy chọn | Mặc định | Mô tả |
| :--- | :---: | :--- |
| **Download as TS instead of MP4** | `Tắt` | Tải xuống định dạng `.ts` mặc định thay vì đóng gói sang `.mp4`. |
| **Show notification** | `Bật` | Hiển thị thông báo hệ thống khi tải xong video. |
| **Show Save File dialog** | `Bật` | Mở hộp thoại chọn nơi lưu file trước khi ghi xuống ổ cứng. |
| **Max simultaneous video downloads** | `2` | Số lượng video tối đa được tải cùng lúc trong hàng chờ. |
| **Max segment threads per video** | `8` | Số luồng tải phân đoạn song song cho mỗi video (1 - 32). |
| **Delay between segments (ms)** | `0` | Độ trễ (mili-giây) giữa các request tải phân đoạn để tránh lỗi `HTTP 429`. |
| **Max speed (MB/s)** | `0` | Giới hạn tốc độ tải xuống tối đa (`0` = Không giới hạn). |
| **Preferred video quality** | `Highest` | Độ phân giải ưu tiên tự động chọn (`Highest`, `1080p`, `720p`, `480p`). |
| **Download Directory / Subdirectory** | Trống | Chọn thư mục lưu mặc định hoặc chỉ định thư mục con trong `Downloads`. |

---

## Mở rộng Plugin mới

1. Tạo file plugin mới trong thư mục `sidepanel/plugins/` dựa trên mẫu `template.plugin.js`.
2. Đảm bảo plugin cung cấp đầy đủ thuộc tính `name` và hai phương thức `canHandle(item, rawList)`, `process(matchedItems, rawList)`.
3. Mở `sidepanel/panel.js`, import và đăng ký plugin với `PluginManager`:

```javascript
import { MyCustomPlugin } from "./plugins/my-custom.plugin.js";

pluginManager.register(MyCustomPlugin);
```