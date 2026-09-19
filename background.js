const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_SETTINGS = {
  enabled: true,
  threshold: 0.78,
  apiKey: "",
};

function clampThreshold(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_SETTINGS.threshold;
  return Math.min(0.99, Math.max(0.5, number));
}

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return {
    enabled: stored.enabled !== false,
    threshold: clampThreshold(stored.threshold),
    apiKey: typeof stored.apiKey === "string" ? stored.apiKey.trim() : "",
  };
}

function publicSettings(settings) {
  return {
    enabled: settings.enabled,
    threshold: settings.threshold,
    hasApiKey: Boolean(settings.apiKey),
  };
}

async function updateBadge(settings) {
  await chrome.action.setBadgeText({ text: settings.enabled ? "ON" : "OFF" });
  await chrome.action.setBadgeBackgroundColor({
    color: settings.enabled ? "#0f766e" : "#64748b",
  });
}

async function broadcastSettings(settings) {
  const tabs = await chrome.tabs.query({});
  const message = { type: "SETTINGS_CHANGED", settings: publicSettings(settings) };
  await Promise.all(
    tabs
      .filter((tab) => tab.id && /^https?:/.test(tab.url || ""))
      .map(async (tab) => {
        try {
          await chrome.tabs.sendMessage(tab.id, message);
        } catch {
          // A page without an injected content script is expected here.
        }
      }),
  );
}

async function saveSettings(input) {
  const current = await getSettings();
  const hasNewKey = Object.prototype.hasOwnProperty.call(input || {}, "apiKey");
  const settings = {
    enabled: input?.enabled !== false,
    threshold: clampThreshold(input?.threshold),
    apiKey: hasNewKey ? String(input.apiKey || "").trim() : current.apiKey,
  };
  await chrome.storage.local.set(settings);
  await updateBadge(settings);
  await broadcastSettings(settings);
  return publicSettings(settings);
}

function text(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function sanitizeCandidate(candidate, index) {
  return {
    id: text(candidate?.id, 80) || `candidate_${index}`,
    tag: text(candidate?.tag, 20),
    id_attr: text(candidate?.id_attr, 100),
    class_attr: text(candidate?.class_attr, 180),
    role: text(candidate?.role, 80),
    aria_label: text(candidate?.aria_label, 160),
    test_id: text(candidate?.test_id, 100),
    text: text(candidate?.text, 220),
    href: text(candidate?.href, 300),
    src: text(candidate?.src, 300),
    width: text(candidate?.width, 12),
    height: text(candidate?.height, 12),
    hint: text(candidate?.hint, 40),
  };
}

function makeQuestions(items) {
  return Object.fromEntries(
    items.map((_, index) => [
      `candidate_${index}`,
      {
        type: "noul",
        instructions:
          `Is \`candidates[${index}]\` likely advertising, sponsored, promotional, or third-party tracking content that a user would reasonably want hidden? Treat ordinary navigation, article content, comments, and normal site UI as not advertising unless the candidate provides strong evidence of an ad or promotion.`,
        criteria: {
          true: "Clearly an ad, sponsored placement, promotional widget, or tracking/advertising element.",
          false: "Ordinary page content or UI, with no meaningful evidence of advertising or tracking.",
        },
      },
    ]),
  );
}

async function classify(items, page) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error("TypeSafe API キーが設定されていません");

  const candidates = (Array.isArray(items) ? items : [])
    .slice(0, 20)
    .map(sanitizeCandidate);
  if (!candidates.length) return { model: "jev-latest", results: [] };

  const requestBody = {
    model: "jev-latest",
    state: {
      page: { origin: text(page?.origin, 200) },
      candidates,
    },
    questions: makeQuestions(candidates),
  };

  let response;
  let payload;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await fetch(TYPESAFE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      cache: "no-store",
    });
    payload = await response.json().catch(() => ({}));
    if (response.status !== 429 && response.status !== 529) break;
    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  }

  if (!response.ok) {
    if (response.status === 401) throw new Error("TypeSafe API キーが無効です");
    if (response.status === 429 || response.status === 529) {
      throw new Error("TypeSafe API が混雑しています。後で再試行します");
    }
    throw new Error(`TypeSafe API エラー (HTTP ${response.status})`);
  }

  const results = candidates.map((candidate, index) => {
    const answer = payload?.answers?.[`candidate_${index}`];
    const score =
      typeof answer?.noul === "number"
        ? Math.min(1, Math.max(0, answer.noul))
        : null;
    return { id: candidate.id, score };
  });
  return { model: "jev-latest", results };
}

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  await chrome.storage.local.set(settings);
  await updateBadge(settings);
});

chrome.runtime.onStartup.addListener(async () => {
  await updateBadge(await getSettings());
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_SETTINGS") {
    getSettings().then((settings) => sendResponse({ settings: publicSettings(settings) }));
    return true;
  }

  if (message?.type === "SET_SETTINGS") {
    saveSettings(message.settings)
      .then((settings) => sendResponse({ settings }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message?.type === "GET_SERVICE_STATUS") {
    getSettings().then((settings) =>
      sendResponse({ online: Boolean(settings.apiKey), keyConfigured: Boolean(settings.apiKey) }),
    );
    return true;
  }

  if (message?.type === "CLASSIFY") {
    classify(message.items, message.page)
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((error) =>
        sendResponse({ ok: false, error: error.message || "TypeSafe API unavailable" }),
      );
    return true;
  }

  return false;
});

getSettings().then(updateBadge).catch(() => undefined);
