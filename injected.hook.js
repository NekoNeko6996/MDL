(function() {
  function toAbsoluteUrl(rawUrl) {
    try {
      return new URL(rawUrl, window.location.href).href;
    } catch (_) {
      return rawUrl;
    }
  }

  // --- 1. Chặn bắt từ API fetch() ---
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await originalFetch.apply(this, args);

    try {
      const resource = args[0];
      let url = "";
      if (typeof resource === "string") url = resource;
      else if (resource instanceof Request) url = resource.url;

      const finalUrl = response.url || toAbsoluteUrl(url);
      if (finalUrl && finalUrl.includes(".m3u8")) {
        const clonedRes = response.clone();
        clonedRes.text().then(m3u8Text => {
          if (m3u8Text.includes("#EXTM3U")) {
            window.postMessage({
              source: "X_DOWNLOADER_HOOK",
              blobUrl: finalUrl,
              content: m3u8Text,
              pageUrl: window.location.href,
              pageTitle: document.title
            }, "*");
          }
        }).catch(() => {});
      }
    } catch (_) {}

    return response;
  };

  // --- 2. Chặn bắt từ API XMLHttpRequest (XHR) ---
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    this._interceptedUrl = url;
    return originalOpen.apply(this, [method, url, ...args]);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...args) {
    const url = this._interceptedUrl;

    if (url && typeof url === "string" && url.includes(".m3u8")) {
      this.addEventListener("load", function() {
        try {
          if (this.status >= 200 && this.status < 300) {
            let m3u8Text = "";
            if (!this.responseType || this.responseType === "text") {
              m3u8Text = this.responseText;
            } else if (this.responseType === "arraybuffer" && this.response) {
              m3u8Text = new TextDecoder().decode(this.response);
            }

            if (m3u8Text && m3u8Text.includes("#EXTM3U")) {
              const finalUrl = this.responseURL || toAbsoluteUrl(url);
              window.postMessage({
                source: "X_DOWNLOADER_HOOK",
                blobUrl: finalUrl,
                content: m3u8Text,
                pageUrl: window.location.href,
                pageTitle: document.title
              }, "*");
            }
          }
        } catch (_) {}
      });
    }

    return originalSend.apply(this, args);
  };

  // --- 3. Ghi đè và bắt sự kiện tạo blob file ---
  const origCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function(obj) {
    const blobUrl = origCreateObjectURL.apply(this, arguments);
    if (obj instanceof Blob) {
      obj.text().then(text => {
        if (text.includes("#EXTM3U")) {
          window.postMessage({
            source: "X_DOWNLOADER_HOOK",
            blobUrl: blobUrl,
            content: text,
            pageUrl: window.location.href,
            pageTitle: document.title
          }, "*");
        }
      }).catch(() => {});
    }
    return blobUrl;
  };
})();