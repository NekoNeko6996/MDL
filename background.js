// Bộ đệm lưu media riêng biệt cho từng tab: { [tabId]: Array<RawMedia> }
const tabMediaMap = {};
const tabUrlMap = {};

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// Khi người dùng chuyển sang tab khác -> báo cho Side Panel đổi tab hiển thị
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.runtime.sendMessage({
    type: "TAB_ACTIVATED",
    tabId,
    data: tabMediaMap[tabId] || []
  }).catch(() => {});
});

// Khi tab điều hướng SPA hoặc cập nhật tiêu đề mới
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    const cleanUrl = changeInfo.url.split("#")[0];
    if (tabUrlMap[tabId] && tabUrlMap[tabId] !== cleanUrl) {
      tabMediaMap[tabId] = [];
      if (tab && tab.active) {
        notifySidePanel(tabId);
      }
    }
    tabUrlMap[tabId] = cleanUrl;
  }

  if (changeInfo.title && tabMediaMap[tabId] && tabMediaMap[tabId].length > 0) {
    tabMediaMap[tabId].forEach(item => {
      item.title = changeInfo.title;
    });
    if (tab && tab.active) {
      notifySidePanel(tabId);
    }
  }
});

// Giải phóng bộ đệm khi đóng tab
chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabMediaMap[tabId];
  delete tabUrlMap[tabId];
});

function notifySidePanel(tabId) {
  chrome.runtime.sendMessage({
    type: "TAB_MEDIA_UPDATED",
    tabId,
    data: tabMediaMap[tabId] || []
  }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "RESET_TAB_MEDIA") {
    const tabId = sender.tab ? sender.tab.id : null;
    if (tabId && sender.frameId === 0) {
      tabMediaMap[tabId] = [];
      if (sender.tab.url) {
        tabUrlMap[tabId] = sender.tab.url.split("#")[0];
      }
      if (sender.tab.active) {
        notifySidePanel(tabId);
      }
    }
  } else if (message.type === "NEW_RAW_MEDIA") {
    const tabId = sender.tab ? sender.tab.id : null;
    if (!tabId) return;

    if (!tabMediaMap[tabId]) {
      tabMediaMap[tabId] = [];
    }

    // Chống trùng lặp blobUrl trong cùng 1 tab
    const exists = tabMediaMap[tabId].some(item => item.blobUrl === message.payload.blobUrl);
    if (!exists) {
      const tabTitle = (sender.tab && sender.tab.title) || message.payload.pageTitle || "Video";
      tabMediaMap[tabId].push({
        tabId,
        url: sender.tab ? sender.tab.url : message.payload.pageUrl,
        title: tabTitle,
        blobUrl: message.payload.blobUrl,
        content: message.payload.content,
        timestamp: Date.now()
      });
    }

    // Chỉ cập nhật lên Side Panel nếu dữ liệu thuộc về tab đang active
    if (sender.tab && sender.tab.active) {
      notifySidePanel(tabId);
    }
  } else if (message.type === "GET_ACTIVE_TAB_MEDIA") {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      const activeTabId = tabs[0] ? tabs[0].id : null;
      sendResponse({
        tabId: activeTabId,
        data: activeTabId ? (tabMediaMap[activeTabId] || []) : []
      });
    });
    return true;
  } else if (message.type === "CLEAR_ACTIVE_TAB_MEDIA") {
    const tabId = message.tabId;
    if (tabId && tabMediaMap[tabId]) {
      tabMediaMap[tabId] = [];
    }
    sendResponse({ ok: true });
  } else if (message.type === "REMOVE_RAW_ITEM") {
    const { tabId, blobUrl, blobUrls } = message;
    if (tabId && tabMediaMap[tabId]) {
      const urlsToRemove = new Set(Array.isArray(blobUrls) ? blobUrls : (blobUrl ? [blobUrl] : []));
      tabMediaMap[tabId] = tabMediaMap[tabId].filter(item => !urlsToRemove.has(item.blobUrl));
      sendResponse(tabMediaMap[tabId]);
    } else {
      sendResponse([]);
    }
  }
});