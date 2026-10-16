import { PluginManager } from "./core/plugin-manager.js";
import { DownloadEngine } from "./core/download-engine.js";

// import plugin
import { HaitenHlsPlugin } from "./plugins/haiten-hls.plugin.js";
import { BasicHLSPlugin } from "./plugins/basichls.plugin.js"

// đăng ký plugin
const pluginManager = new PluginManager();
pluginManager.register(HaitenHlsPlugin);
pluginManager.register(BasicHLSPlugin);

let currentTabId = null;
let standardizedList = [];   // Chỉ chứa video của Tab đang mở
let downloadQueue = [];      // Hàng chờ tải (không bị mất khi chuyển tab)
let activeDownloadsCount = 0;
let sessionCompleted = [];   // Lịch sử đã tải trong phiên
let customTitles = {};       // Tên video tùy chỉnh theo stream.id
let savedDirHandle = null;

const defaultSettings = {
  forceTs: false,
  notify: true,
  saveAs: true,
  maxVideos: 2,
  concurrency: 8,
  segmentDelay: 0,
  maxSpeed: 0,
  prefQuality: "highest",
  subdir: ""
};

let appSettings = { ...defaultSettings };

// --- ĐỊNH DẠNG THỜI GIAN ---
function formatDuration(ms) {
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = Math.round(totalSec % 60);
  return `${mins}m ${secs < 10 ? "0" : ""}${secs}s`;
}

function formatTimestamp(dateObj) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(dateObj.getHours())}:${pad(dateObj.getMinutes())}:${pad(dateObj.getSeconds())} ${pad(dateObj.getDate())}/${pad(dateObj.getMonth() + 1)}`;
}

// --- INDEXED-DB LƯU DIRECTORY HANDLE ---
function openHandleDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("XDownloaderDirDB", 1);
    req.onupgradeneeded = (e) => e.target.result.createObjectStore("handles");
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function saveDirHandle(handle) {
  const db = await openHandleDB();
  const tx = db.transaction("handles", "readwrite");
  tx.objectStore("handles").put(handle, "defaultDir");
}

async function loadDirHandle() {
  try {
    const db = await openHandleDB();
    return await new Promise((resolve) => {
      const tx = db.transaction("handles", "readonly");
      const req = tx.objectStore("handles").get("defaultDir");
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (_) {
    return null;
  }
}

async function clearDirHandle() {
  const db = await openHandleDB();
  const tx = db.transaction("handles", "readwrite");
  tx.objectStore("handles").delete("defaultDir");
}

// --- KHỞI TẠO ---
document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  await loadSessionCompleted();
  savedDirHandle = await loadDirHandle();
  updateDirStatusUI();

  bindNavigationAndSettings();
  fetchActiveTabMedia();

  // Lắng nghe khi người dùng chuyển tab trực tiếp từ Side Panel
  chrome.tabs.onActivated.addListener(() => {
    fetchActiveTabMedia();
  });

  // Lắng nghe dữ liệu từ background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "TAB_ACTIVATED") {
      currentTabId = message.tabId;
      updateFromRaw(message.data || []);
    } else if (message.type === "TAB_MEDIA_UPDATED") {
      if (message.tabId === currentTabId) {
        updateFromRaw(message.data || []);
      }
    }
  });

  // Cập nhật bộ đếm giây trực tiếp cho các video đang tải trong Queue
  setInterval(() => {
    downloadQueue.forEach((task) => {
      if (task.status === "downloading" && task.startedAt) {
        const el = document.getElementById(`q-timer-${task.queueId}`);
        if (el) el.innerText = `⏱ ${formatDuration(getTaskElapsedMs(task))}`;
      }
    });
  }, 500);
});

async function loadSettings() {
  const res = await chrome.storage.local.get("xDownloaderSettings");
  if (res.xDownloaderSettings) {
    appSettings = { ...defaultSettings, ...res.xDownloaderSettings };
  }
  document.getElementById("setForceTs").checked = appSettings.forceTs;
  document.getElementById("setNotify").checked = appSettings.notify;
  document.getElementById("setSaveAs").checked = appSettings.saveAs;
  document.getElementById("setMaxVideos").value = appSettings.maxVideos;
  document.getElementById("setConcurrency").value = appSettings.concurrency;
  document.getElementById("setSegmentDelay").value = appSettings.segmentDelay;
  document.getElementById("setMaxSpeed").value = appSettings.maxSpeed;
  document.getElementById("setSubdir").value = appSettings.subdir;

  const radio = document.querySelector(`input[name="prefQuality"][value="${appSettings.prefQuality}"]`);
  if (radio) radio.checked = true;
}

function saveSettings() {
  appSettings.forceTs = document.getElementById("setForceTs").checked;
  appSettings.notify = document.getElementById("setNotify").checked;
  appSettings.saveAs = document.getElementById("setSaveAs").checked;
  appSettings.maxVideos = Math.max(1, parseInt(document.getElementById("setMaxVideos").value, 10) || 2);
  appSettings.concurrency = Math.max(1, parseInt(document.getElementById("setConcurrency").value, 10) || 8);
  appSettings.segmentDelay = Math.max(0, parseInt(document.getElementById("setSegmentDelay").value, 10) || 0);
  appSettings.maxSpeed = Math.max(0, parseFloat(document.getElementById("setMaxSpeed").value) || 0);
  appSettings.subdir = document.getElementById("setSubdir").value.trim();

  const checkedRadio = document.querySelector('input[name="prefQuality"]:checked');
  if (checkedRadio) appSettings.prefQuality = checkedRadio.value;

  chrome.storage.local.set({ xDownloaderSettings: appSettings });
  renderStreams();
  processQueue();
}

async function loadSessionCompleted() {
  const res = await chrome.storage.session.get("completedDownloads");
  sessionCompleted = res.completedDownloads || [];
  renderCompletedList();
}

async function saveSessionCompleted() {
  await chrome.storage.session.set({ completedDownloads: sessionCompleted });
  renderCompletedList();
}

function updateDirStatusUI() {
  const el = document.getElementById("customDirStatus");
  if (savedDirHandle) {
    el.innerText = `Đường dẫn trực tiếp: "${savedDirHandle.name}"`;
  } else {
    el.innerText = "Đường dẫn trực tiếp: Dùng mặc định trình duyệt";
  }
}

function bindNavigationAndSettings() {
  const mainView = document.getElementById("mainView");
  const settingsView = document.getElementById("settingsView");
  const toggleSettingsBtn = document.getElementById("toggleSettingsBtn");

  toggleSettingsBtn.addEventListener("click", () => {
    const isShowingSettings = !settingsView.classList.contains("hidden");
    settingsView.classList.toggle("hidden", isShowingSettings);
    mainView.classList.toggle("hidden", !isShowingSettings);
    toggleSettingsBtn.classList.toggle("active", !isShowingSettings);
  });

  document.getElementById("backToMainBtn").addEventListener("click", () => {
    settingsView.classList.add("hidden");
    mainView.classList.remove("hidden");
    toggleSettingsBtn.classList.remove("active");
  });

  ["setForceTs", "setNotify", "setSaveAs", "setMaxVideos", "setConcurrency", "setSegmentDelay", "setMaxSpeed", "setSubdir"].forEach(id => {
    document.getElementById(id).addEventListener("change", saveSettings);
  });

  document.querySelectorAll('input[name="prefQuality"]').forEach(r => {
    r.addEventListener("change", saveSettings);
  });

  document.getElementById("pickCustomDirBtn").addEventListener("click", async () => {
    try {
      const handle = await window.showDirectoryPicker({ mode: "readwrite" });
      savedDirHandle = handle;
      await saveDirHandle(handle);
      updateDirStatusUI();
    } catch (_) {}
  });

  document.getElementById("clearCustomDirBtn").addEventListener("click", async () => {
    savedDirHandle = null;
    await clearDirHandle();
    updateDirStatusUI();
  });

  document.getElementById("openChromeDlSettingsBtn").addEventListener("click", () => {
    chrome.tabs.create({ url: "chrome://settings/downloads" });
  });

  document.getElementById("openFolderBtn").addEventListener("click", () => {
    chrome.downloads.showDefaultFolder();
  });

  document.getElementById("clearAllMediaBtn").addEventListener("click", () => {
    if (!currentTabId) return;
    chrome.runtime.sendMessage({ type: "CLEAR_ACTIVE_TAB_MEDIA", tabId: currentTabId }, () => {
      standardizedList = [];
      renderStreams();
    });
  });

  document.getElementById("toggleCompleteBtn").addEventListener("click", (e) => {
    const listEl = document.getElementById("completeList");
    const isHidden = listEl.classList.toggle("hidden");
    e.target.innerText = isHidden ? "show all" : "hide";
  });

  document.getElementById("clearCompleteBtn").addEventListener("click", async () => {
    sessionCompleted = [];
    await saveSessionCompleted();
  });

  document.getElementById("pauseAllBtn").addEventListener("click", pauseAllTasks);
  document.getElementById("resumeAllBtn").addEventListener("click", resumeAllTasks);
  document.getElementById("cancelAllBtn").addEventListener("click", cancelAllTasks);
}

function fetchActiveTabMedia() {
  chrome.runtime.sendMessage({ type: "GET_ACTIVE_TAB_MEDIA" }, (res) => {
    if (res) {
      currentTabId = res.tabId;
      updateFromRaw(res.data || []);
    }
  });
}

function updateFromRaw(rawList) {
  standardizedList = pluginManager.normalizeAll(rawList);
  renderStreams();
}

function pickPreferredVariantIndex(variants) {
  if (!variants || variants.length === 0) return 0;
  if (appSettings.prefQuality === "highest") return 0;
  const targetH = parseInt(appSettings.prefQuality, 10);
  let bestIdx = 0;
  let minDiff = Infinity;
  variants.forEach((v, idx) => {
    if (v.height) {
      const diff = Math.abs(v.height - targetH);
      if (diff < minDiff) {
        minDiff = diff;
        bestIdx = idx;
      }
    }
  });
  return bestIdx;
}

// --- HIỂN THỊ DANH SÁCH VIDEO CỦA TAB HIỆN TẠI ---
function renderStreams() {
  const container = document.getElementById("mediaContainer");
  const visibleStreams = (standardizedList || []).filter(
    stream => !downloadQueue.some(task => !task.isRedownload && task.stream.id === stream.id)
  );

  if (visibleStreams.length === 0) {
    container.innerHTML = `<div style="text-align:center; color:#909296; margin: 24px 0; font-size:12px;">No videos found in this tab.</div>`;
    return;
  }

  container.innerHTML = "";
  const defaultFmt = appSettings.forceTs ? "ts" : "mp4";

  visibleStreams.forEach((stream, sIdx) => {
    const prefVIdx = pickPreferredVariantIndex(stream.variants);
    const activeVariant = stream.variants[prefVIdx] || stream.variants[0];
    const displayTitle = customTitles[stream.id] || stream.title || "Video";

    const qualityOptions = stream.variants
      .map((v, idx) => `<option value="${idx}" ${idx === prefVIdx ? "selected" : ""}>${v.label}</option>`)
      .join("");

    const card = document.createElement("div");
    card.className = "media-card";
    card.innerHTML = `
      <div class="thumb-box">
        <span id="res-label-${sIdx}">${activeVariant.label}</span>
        <span class="size-badge" id="size-badge-${sIdx}">${activeVariant.sizeText}</span>
      </div>
      <div class="card-body">
        <div>
          <div class="title-row">
            <div class="title-wrap">
              <span class="proto-badge">${stream.pluginName}</span>
              <span id="title-text-${sIdx}">${displayTitle}</span>.<span id="ext-label-${sIdx}">${defaultFmt}</span>
            </div>
            <button class="btn-close" id="remove-${sIdx}" title="Remove from tab.">&times;</button>
          </div>
          <div class="edit-row" id="edit-row-${sIdx}">
            <button class="btn-icon-inline" id="edit-btn-${sIdx}" title="Rename file">✎</button>
          </div>
        </div>

        <div class="action-row">
          <div class="select-group">
            <select class="dark-select" id="fmt-${sIdx}" title="Format">
              <option value="mp4" ${defaultFmt === "mp4" ? "selected" : ""}>MP4</option>
              <option value="ts" ${defaultFmt === "ts" ? "selected" : ""}>TS</option>
            </select>
            <select class="dark-select" id="var-${sIdx}" title="Resolution">
              ${qualityOptions}
            </select>
          </div>
          <button class="btn-download-pill" id="dl-btn-${sIdx}">
            <span>Download</span>
          </button>
        </div>
      </div>
    `;
    container.appendChild(card);

    const fmtSelect = card.querySelector(`#fmt-${sIdx}`);
    const varSelect = card.querySelector(`#var-${sIdx}`);
    const extLabel = card.querySelector(`#ext-label-${sIdx}`);
    const resLabel = card.querySelector(`#res-label-${sIdx}`);
    const sizeBadge = card.querySelector(`#size-badge-${sIdx}`);

    fmtSelect.addEventListener("change", () => {
      extLabel.innerText = fmtSelect.value;
    });

    varSelect.addEventListener("change", () => {
      const v = stream.variants[parseInt(varSelect.value, 10)];
      if (v) {
        resLabel.innerText = v.label;
        sizeBadge.innerText = v.sizeText;
      }
    });

    card.querySelector(`#edit-btn-${sIdx}`).addEventListener("click", () => {
      const editRow = card.querySelector(`#edit-row-${sIdx}`);
      const currentName = customTitles[stream.id] || stream.title;
      editRow.innerHTML = `<input type="text" class="rename-input" id="rename-inp-${sIdx}" value="${currentName}">`;
      const inp = editRow.querySelector(`#rename-inp-${sIdx}`);
      inp.focus();
      inp.select();

      const commitRename = () => {
        const cleaned = inp.value
          .replace(/\.(mp4|ts|mkv|webm|m3u8)$/i, "")
          .replace(/[\\/:*?"<>|]/g, " - ")
          .trim() || stream.title;
        customTitles[stream.id] = cleaned;
        card.querySelector(`#title-text-${sIdx}`).innerText = cleaned;
        editRow.innerHTML = `<button class="btn-icon-inline" id="edit-btn-${sIdx}" title="Rename file">✎</button>`;
        editRow.querySelector(`#edit-btn-${sIdx}`).addEventListener("click", () => renderStreams());
      };

      inp.addEventListener("blur", commitRename);
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") commitRename();
      });
    });

    card.querySelector(`#remove-${sIdx}`).addEventListener("click", () => {
      chrome.runtime.sendMessage({
        type: "REMOVE_RAW_ITEM",
        tabId: currentTabId,
        blobUrl: stream.id,
        blobUrls: stream.rawBlobUrls || [stream.id]
      }, (updatedRaw) => {
        updateFromRaw(updatedRaw || []);
      });
    });

    card.querySelector(`#dl-btn-${sIdx}`).addEventListener("click", () => {
      const vIdx = parseInt(varSelect.value, 10);
      const targetFormat = fmtSelect.value;
      const finalTitle = customTitles[stream.id] || stream.title || "Video";

      enqueueDownload({
        stream,
        variant: stream.variants[vIdx],
        targetFormat,
        title: finalTitle,
        isRedownload: false,
        historyId: null
      });
    });
  });
}

// --- QUẢN LÝ HÀNG CHỜ TẢI (QUEUE) CỐ ĐỊNH KHI CHUYỂN TAB ---
function getTaskElapsedMs(task) {
  let total = task.elapsedMs || 0;
  if (task.status === "downloading" && task.startedAt) {
    total += Date.now() - task.startedAt;
  }
  return total;
}

function enqueueDownload({ stream, variant, targetFormat, title, isRedownload = false, historyId = null }) {
  const queueId = "q_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
  downloadQueue.push({
    queueId,
    stream,
    variant,
    targetFormat,
    title,
    isRedownload,
    historyId,
    status: "queued", // "queued" | "downloading" | "paused" | "cancelled"
    progress: 0,
    doneSegs: 0,
    totalSegs: variant.segments.length,
    buffers: new Array(variant.segments.length),
    elapsedMs: 0,
    startedAt: null,
    isRunning: false,
    abortController: null
  });

  renderStreams();
  renderQueue();
  processQueue();
}

function pauseTask(task) {
  if (!task || task.status === "paused" || task.status === "cancelled") return;
  if (task.status === "downloading" && task.startedAt) {
    task.elapsedMs = (task.elapsedMs || 0) + (Date.now() - task.startedAt);
    task.startedAt = null;
  }
  task.status = "paused";
  if (task.abortController) {
    task.abortController.abort();
  }
  renderQueue();
}

function resumeTask(task) {
  if (!task || task.status !== "paused") return;
  task.status = "queued";
  renderQueue();
  processQueue();
}

async function cancelTask(task) {
  if (!task) return;
  task.status = "cancelled";
  if (task.abortController) {
    task.abortController.abort();
  }
  task.buffers = null;
  downloadQueue = downloadQueue.filter(t => t.queueId !== task.queueId);

  if (task.isRedownload && task.historyId) {
    const existing = sessionCompleted.find(item => item.id === task.historyId);
    if (existing) {
      existing.inQueue = false;
      await saveSessionCompleted();
    }
  }

  renderQueue();
  renderStreams();
  processQueue();
}

function pauseAllTasks() {
  // Đổi trạng thái các task đang chờ sang paused trước để không tự động nhảy vào chạy khi task đang tải dừng
  downloadQueue.forEach(t => {
    if (t.status === "queued") t.status = "paused";
  });
  downloadQueue.forEach(t => {
    if (t.status === "downloading") pauseTask(t);
  });
  renderQueue();
}

function resumeAllTasks() {
  downloadQueue.forEach(t => {
    if (t.status === "paused") t.status = "queued";
  });
  renderQueue();
  processQueue();
}

async function cancelAllTasks() {
  let hasRedownload = false;
  downloadQueue.forEach(task => {
    task.status = "cancelled";
    if (task.abortController) {
      task.abortController.abort();
    }
    task.buffers = null;
    if (task.isRedownload && task.historyId) {
      const existing = sessionCompleted.find(item => item.id === task.historyId);
      if (existing) {
        existing.inQueue = false;
        hasRedownload = true;
      }
    }
  });

  downloadQueue = [];
  if (hasRedownload) {
    await saveSessionCompleted();
  }
  renderQueue();
  renderStreams();
}

function renderQueue() {
  const section = document.getElementById("queueSection");
  const listEl = document.getElementById("queueList");

  if (downloadQueue.length === 0) {
    section.classList.add("hidden");
    listEl.innerHTML = "";
    return;
  }

  section.classList.remove("hidden");
  listEl.innerHTML = "";

  // Cập nhật trạng thái nút hàng loạt
  const hasActiveOrQueued = downloadQueue.some(t => t.status === "downloading" || t.status === "queued");
  const hasPaused = downloadQueue.some(t => t.status === "paused");
  const pauseAllBtn = document.getElementById("pauseAllBtn");
  const resumeAllBtn = document.getElementById("resumeAllBtn");
  if (pauseAllBtn) pauseAllBtn.disabled = !hasActiveOrQueued;
  if (resumeAllBtn) resumeAllBtn.disabled = !hasPaused;

  downloadQueue.forEach((task) => {
    const isDl = task.status === "downloading";
    const isPaused = task.status === "paused";

    let statusLabel = "in queue...";
    if (isDl) {
      statusLabel = `Đang tải: ${task.doneSegs}/${task.totalSegs} (${task.progress}%)`;
    } else if (isPaused) {
      statusLabel = `Đã dừng: ${task.doneSegs}/${task.totalSegs} (${task.progress}%)`;
    }

    const elapsedText = `⏱ ${formatDuration(getTaskElapsedMs(task))}`;
    const badgeText = isPaused ? "PAUSED" : (task.isRedownload ? "RE-DL" : "QUEUE");

    const card = document.createElement("div");
    card.className = "media-card in-queue";
    card.id = `q-card-${task.queueId}`;
    card.innerHTML = `
      <div class="thumb-box">
        <span>${task.variant.label}</span>
        <span class="size-badge">${task.variant.sizeText}</span>
      </div>
      <div class="card-body">
        <div class="title-row">
          <div class="title-wrap">
            <span class="queue-badge ${isPaused ? "paused" : ""}">${badgeText}</span>
            <span>${task.title}.${task.targetFormat}</span>
          </div>
          <div class="queue-item-actions">
            <button class="btn-q-action toggle-btn" title="${isPaused ? "Tiếp tục tải" : "Tạm dừng"}">
              ${isPaused ? "▶" : "⏸"}
            </button>
            <button class="btn-q-action cancel cancel-btn" title="Hủy tải">✕</button>
          </div>
        </div>
        <div>
          <div class="queue-status-row">
            <span id="q-status-${task.queueId}">${statusLabel}</span>
            <span id="q-timer-${task.queueId}">${elapsedText}</span>
          </div>
          <div class="progress-track">
            <div class="progress-bar-fill ${isPaused ? "paused" : ""}" id="q-fill-${task.queueId}" style="width: ${task.progress}%;"></div>
          </div>
        </div>
      </div>
    `;
    listEl.appendChild(card);

    card.querySelector(".toggle-btn").addEventListener("click", () => {
      if (task.status === "paused") {
        resumeTask(task);
      } else {
        pauseTask(task);
      }
    });

    card.querySelector(".cancel-btn").addEventListener("click", () => {
      cancelTask(task);
    });
  });
}

function processQueue() {
  while (activeDownloadsCount < appSettings.maxVideos) {
    const nextTask = downloadQueue.find(t => t.status === "queued" && !t.isRunning);
    if (!nextTask) break;

    nextTask.status = "downloading";
    nextTask.isRunning = true;
    nextTask.startedAt = Date.now();
    nextTask.abortController = new AbortController();
    activeDownloadsCount++;
    renderQueue();

    runQueueTask(nextTask).finally(() => {
      nextTask.isRunning = false;
      activeDownloadsCount = Math.max(0, activeDownloadsCount - 1);

      // Chỉ xóa khỏi hàng chờ nếu đã hoàn tất, bị hủy hoặc lỗi (giữ lại nếu đang tạm dừng hoặc vừa bấm tiếp tục)
      if (nextTask.status !== "paused" && nextTask.status !== "queued") {
        downloadQueue = downloadQueue.filter(t => t.queueId !== nextTask.queueId);
      }
      renderQueue();
      renderStreams();
      processQueue();
    });
  }
}

async function runQueueTask(task) {
  try {
    // Nếu chọn độ phân giải từ Master Playlist mà trình phát chưa tải file .m3u8 con -> nạp ngay
    if ((!task.variant.segments || task.variant.segments.length === 0) && task.variant.playlistUrl) {
      const res = await fetch(task.variant.playlistUrl, { signal: task.abortController.signal });
      if (!res.ok) throw new Error(`Không thể tải playlist: HTTP ${res.status}`);
      const m3u8Text = await res.text();
      const { segments, totalBytes } = BasicHLSPlugin.parseSegments(m3u8Text, task.variant.playlistUrl);
      task.variant.segments = segments;
      task.variant.sizeText = totalBytes > 0 ? `${Math.round(totalBytes / 1048576)}MB` : `${segments.length} segs`;
      task.totalSegs = segments.length;
      task.buffers = new Array(segments.length);
    }

    const { blob, ext } = await DownloadEngine.downloadAndBuild({
      segments: task.variant.segments,
      concurrency: appSettings.concurrency,
      segmentDelay: appSettings.segmentDelay,
      maxSpeed: appSettings.maxSpeed,
      targetFormat: task.targetFormat,
      existingBuffers: task.buffers,
      signal: task.abortController.signal,
      onProgress: (done, total) => {
        task.doneSegs = done;
        task.totalSegs = total;
        task.progress = Math.round((done / total) * 100);

        const fillEl = document.getElementById(`q-fill-${task.queueId}`);
        const statusEl = document.getElementById(`q-status-${task.queueId}`);
        if (fillEl) fillEl.style.width = `${task.progress}%`;
        if (statusEl) statusEl.innerText = `Đang tải: ${done}/${total} (${task.progress}%)`;
      },
      onStatus: (msg) => {
        const statusEl = document.getElementById(`q-status-${task.queueId}`);
        if (statusEl) statusEl.innerText = msg;
      }
    });

    const durationMs = getTaskElapsedMs(task);
    const durationText = formatDuration(durationMs);
    const completedAt = formatTimestamp(new Date());
    const fullFileName = `${task.title}.${ext}`;
    let chromeDownloadId = null;

    // Giải phóng bộ đệm phân đoạn sau khi đã đóng gói xong Blob
    task.buffers = null;

    if (savedDirHandle && appSettings.saveAs && window.showSaveFilePicker) {
      const perm = await savedDirHandle.requestPermission({ mode: "readwrite" });
      if (perm === "granted") {
        const fileHandle = await window.showSaveFilePicker({
          suggestedName: fullFileName,
          startIn: savedDirHandle,
          types: [{
            description: ext.toUpperCase() + " Video",
            accept: { [ext === "mp4" ? "video/mp4" : "video/mp2t"]: [`.${ext}`] }
          }]
        });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
      } else {
        chromeDownloadId = await saveViaChromeDownloads(blob, fullFileName);
      }
    } else {
      chromeDownloadId = await saveViaChromeDownloads(blob, fullFileName);
    }

    const hostname = task.stream.sourceUrl ? new URL(task.stream.sourceUrl).hostname : "local";

    if (task.isRedownload) {
      const existing = sessionCompleted.find(item => item.id === task.historyId);
      if (existing) {
        existing.inQueue = false;
        existing.downloadId = chromeDownloadId || existing.downloadId;
        existing.durationText = durationText;
        existing.completedAt = completedAt;
      }
    } else {
      chrome.runtime.sendMessage({
        type: "REMOVE_RAW_ITEM",
        tabId: task.stream.tabId || currentTabId,
        blobUrl: task.stream.id,
        blobUrls: task.stream.rawBlobUrls || [task.stream.id]
      }, (updatedRaw) => {
        if ((task.stream.tabId || currentTabId) === currentTabId) {
          standardizedList = pluginManager.normalizeAll(updatedRaw || []);
          renderStreams();
        }
      });

      sessionCompleted.unshift({
        id: Date.now() + Math.random(),
        title: task.title,
        ext,
        fullFileName,
        hostname,
        downloadId: chromeDownloadId,
        targetFormat: task.targetFormat,
        durationText,
        completedAt,
        inQueue: false,
        stream: task.stream,
        variant: task.variant
      });
    }

    await saveSessionCompleted();

    if (appSettings.notify) {
      chrome.notifications.create({
        type: "basic",
        iconUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        title: "Download completed",
        message: `${fullFileName} (${durationText})`
      });
    }
  } catch (err) {
    // Nếu do người dùng bấm Pause hoặc Cancel thì thoát êm, không báo lỗi
    if (task.status === "paused" || task.status === "queued" || task.status === "cancelled" || err.name === "AbortError") {
      return;
    }

    console.error("Download Error:", err);
    task.buffers = null;
    if (task.isRedownload && task.historyId) {
      const existing = sessionCompleted.find(item => item.id === task.historyId);
      if (existing) {
        existing.inQueue = false;
        await saveSessionCompleted();
      }
    }
  }
}

function saveViaChromeDownloads(blob, fullFileName) {
  return new Promise((resolve, reject) => {
    const blobUrl = URL.createObjectURL(blob);
    let sub = appSettings.subdir.replace(/^[\\/]+|[\\/]+$/g, "");
    const finalPath = sub ? `${sub}/${fullFileName}` : fullFileName;

    chrome.downloads.download({
      url: blobUrl,
      filename: finalPath,
      saveAs: appSettings.saveAs
    }, (downloadId) => {
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(downloadId);
      }
    });
  });
}

// --- HIỂN THỊ LỊCH SỬ COMPLETE & TẢI LẠI ---
function renderCompletedList() {
  const section = document.getElementById("completeSection");
  const listEl = document.getElementById("completeList");

  const visibleItems = sessionCompleted.filter(item => !item.inQueue);

  if (visibleItems.length === 0) {
    section.classList.add("hidden");
    listEl.innerHTML = "";
    return;
  }

  section.classList.remove("hidden");
  listEl.innerHTML = "";

  visibleItems.forEach((item) => {
    const div = document.createElement("div");
    div.className = "complete-card";
    div.innerHTML = `
      <div class="title-wrap">${item.fullFileName}</div>
      <div class="meta-time-row">
        <span>⏱ DL time: <b>${item.durationText || "--"}</b></span>
        <span>⏱ At: <b>${item.completedAt || "--"}</b></span>
      </div>
      <div class="complete-actions">
        <span class="domain-tag" title="${item.hostname}">🌐 ${item.hostname}</span>
        <div class="action-btn-group">
          <button class="round-icon-btn btn-redl" title="Add to reload queue">↻</button>
          <button class="round-icon-btn btn-del" title="Remove from history">🗑</button>
          <div class="green-split-pill">
            <button class="btn-play" title="View video">▶ Play</button>
            <button class="btn-folder" title="Show from folder">🗀</button>
          </div>
        </div>
      </div>
    `;
    listEl.appendChild(div);

    // Nhấn tải lại -> Nhảy từ lịch sử lên hàng chờ (Queue) và không tạo thêm bản ghi lịch sử mới
    div.querySelector(".btn-redl").addEventListener("click", async () => {
      item.inQueue = true;
      await saveSessionCompleted();

      enqueueDownload({
        stream: item.stream,
        variant: item.variant,
        targetFormat: item.targetFormat,
        title: item.title,
        isRedownload: true,
        historyId: item.id
      });
    });

    div.querySelector(".btn-del").addEventListener("click", async () => {
      sessionCompleted = sessionCompleted.filter(x => x.id !== item.id);
      await saveSessionCompleted();
    });

    div.querySelector(".btn-play").addEventListener("click", () => {
      if (item.downloadId) {
        chrome.downloads.open(item.downloadId);
      } else {
        chrome.downloads.showDefaultFolder();
      }
    });

    div.querySelector(".btn-folder").addEventListener("click", () => {
      if (item.downloadId) {
        chrome.downloads.show(item.downloadId);
      } else {
        chrome.downloads.showDefaultFolder();
      }
    });
  });
}