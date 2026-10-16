if (window === window.top) {
  chrome.runtime.sendMessage({ type: "RESET_TAB_MEDIA" }).catch(() => {});
}

window.addEventListener("message", (event) => {
  if (event.source === window && event.data && event.data.source === "X_DOWNLOADER_HOOK") {
    chrome.runtime.sendMessage({
      type: "NEW_RAW_MEDIA",
      payload: event.data
    }).catch(() => {});
  }
});