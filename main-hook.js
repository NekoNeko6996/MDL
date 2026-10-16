(function() {
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