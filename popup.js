const enabledInput = document.querySelector("#enabled");
const thresholdInput = document.querySelector("#threshold");
const thresholdValue = document.querySelector("#thresholdValue");
const serviceStatus = document.querySelector("#serviceStatus");
const serviceDot = document.querySelector("#serviceDot");
const pageStats = document.querySelector("#pageStats");
const pageName = document.querySelector("#pageName");
const errorText = document.querySelector("#error");
const apiKeyInput = document.querySelector("#apiKey");
const keyState = document.querySelector("#keyState");
const saveKeyButton = document.querySelector("#saveKey");
const clearKeyButton = document.querySelector("#clearKey");

function showError(message) {
  errorText.textContent = message || "";
}

function renderSettings(settings) {
  enabledInput.checked = settings.enabled;
  thresholdInput.value = Math.round(settings.threshold * 100);
  thresholdValue.textContent = `${thresholdInput.value}%`;
  keyState.textContent = settings.hasApiKey ? "設定済み" : "未設定";
  apiKeyInput.value = "";
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function refresh() {
  showError("");
  const settingsResponse = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
  if (settingsResponse?.settings) renderSettings(settingsResponse.settings);

  const status = await chrome.runtime.sendMessage({ type: "GET_SERVICE_STATUS" });
  serviceDot.className = `status-dot ${status?.keyConfigured ? "online" : "offline"}`;
  serviceStatus.textContent = status?.keyConfigured ? "キー設定済み" : "キー未設定";

  const tab = await activeTab();
  pageName.textContent = tab?.url ? new URL(tab.url).hostname : "このページ";
  if (!tab?.id || !/^https?:/.test(tab.url || "")) {
    pageStats.textContent = "対象外";
    return;
  }
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_STATS" });
    pageStats.textContent = response?.stats
      ? `${response.stats.hidden}件を非表示`
      : "読み込み中";
  } catch {
    pageStats.textContent = "再読み込みで有効";
  }
}

async function save() {
  const response = await chrome.runtime.sendMessage({
    type: "SET_SETTINGS",
    settings: {
      enabled: enabledInput.checked,
      threshold: Number(thresholdInput.value) / 100,
    },
  });
  if (response?.error) showError(response.error);
}

async function saveKey() {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    showError("保存する API キーを入力してください");
    return;
  }
  const response = await chrome.runtime.sendMessage({
    type: "SET_SETTINGS",
    settings: { apiKey, enabled: enabledInput.checked, threshold: Number(thresholdInput.value) / 100 },
  });
  if (response?.error) showError(response.error);
  else await refresh();
}

async function clearKey() {
  const response = await chrome.runtime.sendMessage({
    type: "SET_SETTINGS",
    settings: { apiKey: "", enabled: enabledInput.checked, threshold: Number(thresholdInput.value) / 100 },
  });
  if (response?.error) showError(response.error);
  else await refresh();
}

thresholdInput.addEventListener("input", () => {
  thresholdValue.textContent = `${thresholdInput.value}%`;
});
thresholdInput.addEventListener("change", save);
enabledInput.addEventListener("change", save);
saveKeyButton.addEventListener("click", () => saveKey().catch((error) => showError(error.message)));
clearKeyButton.addEventListener("click", () => clearKey().catch((error) => showError(error.message)));
refresh().catch((error) => showError(error.message));
