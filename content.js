(() => {
  "use strict";

  const CANDIDATE_SELECTORS = [
    "[data-ad]",
    "[data-advertisement]",
    "[data-sponsored]",
    "[aria-label*='advert' i]",
    "[aria-label*='sponsor' i]",
    "[id*='ad' i]",
    "[class*='ad' i]",
    "[id*='sponsor' i]",
    "[class*='sponsor' i]",
    "[id*='promo' i]",
    "[class*='promo' i]",
    "iframe",
    "aside",
  ].join(",");
  const AD_HINT = /(^|[-_\s])(ad|ads|advert|advertisement|sponsor|sponsored|promoted|promo|doubleclick|taboola|outbrain|criteo)([-_\s]|$)/i;
  const stateByElement = new WeakMap();
  let settings = { enabled: true, threshold: 0.78 };
  let scanTimer = null;
  let scanInFlight = false;
  let nextId = 0;
  const idToElement = new Map();
  const stats = { checked: 0, hidden: 0, serviceErrors: 0 };

  function normalize(value, maxLength) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLength);
  }

  function safeUrl(value) {
    if (!value) return "";
    try {
      const url = new URL(value, location.href);
      if (url.protocol !== "http:" && url.protocol !== "https:") return "";
      return `${url.origin}${url.pathname}`.slice(0, 300);
    } catch {
      return "";
    }
  }

  function hasAdHint(element) {
    const attributes = [
      element.id,
      element.className,
      element.getAttribute("role"),
      element.getAttribute("aria-label"),
      element.getAttribute("data-testid"),
    ]
      .map((value) => normalize(value, 180))
      .join(" ");
    return (
      element.hasAttribute("data-ad") ||
      element.hasAttribute("data-advertisement") ||
      element.hasAttribute("data-sponsored") ||
      AD_HINT.test(attributes)
    );
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    if (element === document.documentElement || element === document.body) return false;
    if (element.hasAttribute("data-jev-adblocker-ignore")) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width >= 12 && rect.height >= 12;
  }

  function describe(element) {
    const rect = element.getBoundingClientRect();
    const id = `candidate_${nextId++}`;
    idToElement.set(id, element);
    return {
      id,
      tag: element.tagName.toLowerCase(),
      id_attr: normalize(element.id, 100),
      class_attr: normalize(typeof element.className === "string" ? element.className : "", 180),
      role: normalize(element.getAttribute("role"), 80),
      aria_label: normalize(element.getAttribute("aria-label"), 160),
      test_id: normalize(element.getAttribute("data-testid"), 100),
      text: normalize(element.textContent, 220),
      href: safeUrl(element.getAttribute("href") || element.closest("a")?.href),
      src: safeUrl(element.getAttribute("src")),
      width: String(Math.round(rect.width)),
      height: String(Math.round(rect.height)),
      hint: hasAdHint(element) ? "explicit-ad-hint" : "layout-candidate",
    };
  }

  function hide(element) {
    if (element.classList.contains("jev-adblocker-hidden")) return;
    element.classList.add("jev-adblocker-hidden");
    element.setAttribute("data-jev-adblocker-hidden", "true");
    stats.hidden += 1;
  }

  function restore() {
    document.querySelectorAll("[data-jev-adblocker-hidden]").forEach((element) => {
      element.classList.remove("jev-adblocker-hidden");
      element.removeAttribute("data-jev-adblocker-hidden");
    });
  }

  function collectCandidates() {
    const items = [];
    for (const element of document.querySelectorAll(CANDIDATE_SELECTORS)) {
      if (items.length >= 20) break;
      if (!isVisible(element) || !hasAdHint(element) && element.tagName !== "IFRAME" && element.tagName !== "ASIDE") {
        continue;
      }
      if (stateByElement.has(element)) continue;
      stateByElement.set(element, "queued");
      items.push(describe(element));
    }
    return items;
  }

  async function classifyBatch(items) {
    if (!items.length || scanInFlight || !settings.enabled) return;
    scanInFlight = true;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "CLASSIFY",
        page: { origin: location.origin },
        items,
      });
      if (!response?.ok) throw new Error(response?.error || "classifier unavailable");
      for (const result of response.results || []) {
        const element = idToElement.get(result.id);
        idToElement.delete(result.id);
        if (!element || !element.isConnected) continue;
        stateByElement.set(element, "judged");
        stats.checked += 1;
        const score = Number(result.score);
        if (Number.isFinite(score) && score >= settings.threshold) hide(element);
      }
      for (const item of items) {
        const element = idToElement.get(item.id);
        if (element) {
          idToElement.delete(item.id);
          stateByElement.delete(element);
        }
      }
    } catch {
      stats.serviceErrors += 1;
      for (const item of items) {
        const element = idToElement.get(item.id);
        if (element) stateByElement.delete(element);
        idToElement.delete(item.id);
      }
      window.setTimeout(scheduleScan, 10000);
    } finally {
      scanInFlight = false;
      scheduleScan();
    }
  }

  function scan() {
    scanTimer = null;
    if (!settings.enabled || scanInFlight) return;
    classifyBatch(collectCandidates());
  }

  function scheduleScan() {
    if (scanTimer !== null) return;
    scanTimer = window.setTimeout(scan, 350);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "SETTINGS_CHANGED") {
      settings = message.settings || settings;
      if (!settings.enabled) restore();
      else scheduleScan();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "GET_PAGE_STATS") {
      sendResponse({ stats, settings });
      return false;
    }
    return false;
  });

  const observer = new MutationObserver(() => scheduleScan());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  chrome.runtime
    .sendMessage({ type: "GET_SETTINGS" })
    .then((response) => {
      if (response?.settings) settings = response.settings;
      if (settings.enabled) scheduleScan();
    })
    .catch(() => undefined);
})();
