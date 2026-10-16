// Bộ đệm lưu media riêng biệt cho từng tab: { [tabId]: Array<RawMedia> }
const tabMediaMap = {};

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// Khi người dùng chuyển sang tab khác -> báo cho Side Panel đổi danh sách hiển thị
chrome.tabs.onActivated.addListener(({ tabId }) => {
  notifySidePanel(tabId);
});

// Khi tab tải lại trang hoặc cập nhật tiêu đề mới
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    // Xóa cache cũ của tab khi điều hướng sang URL mới
    tabMediaMap[tabId] = [];
    notifySidePanel(tabId);
  } else if (changeInfo.title && tabMediaMap[tabId]) {
    // Cập nhật lại tiêu đề tab mới nhất cho các luồng đã bắt được
    tabMediaMap[tabId].forEach(item => {
      item.title = changeInfo.title;
    });
    notifySidePanel(tabId);
  }
});

// Giải phóng bộ đệm khi đóng tab
chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabMediaMap[tabId];
});

function notifySidePanel(tabId) {
  chrome.runtime.sendMessage({
    type: "TAB_MEDIA_UPDATED",
    tabId,
    data: tabMediaMap[tabId] || []
  }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "NEW_RAW_MEDIA") {
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

    // Nếu dữ liệu thuộc về tab đang mở hiện tại thì cập nhật lên Side Panel
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].id === tabId) {
        notifySidePanel(tabId);
      }
    });
  } else if (message.type === "GET_ACTIVE_TAB_MEDIA") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTabId = tabs[0] ? tabs[0].id : null;
      sendResponse({
        tabId: activeTabId,
        data: activeTabId ? (tabMediaMap[activeTabId] || []) : []
      });
    });
    return true; // Giữ kênh message mở cho bất đồng bộ
  } else if (message.type === "CLEAR_ACTIVE_TAB_MEDIA") {
    const tabId = message.tabId;
    if (tabId && tabMediaMap[tabId]) {
      tabMediaMap[tabId] = [];
    }
    sendResponse({ ok: true });
  } else if (message.type === "REMOVE_RAW_ITEM") {
    const { tabId, blobUrl } = message;
    if (tabId && tabMediaMap[tabId]) {
      tabMediaMap[tabId] = tabMediaMap[tabId].filter(item => item.blobUrl !== blobUrl);
      sendResponse(tabMediaMap[tabId]);
    } else {
      sendResponse([]);
    }
  }
});