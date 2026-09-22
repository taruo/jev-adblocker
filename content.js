(() => {
  "use strict";

  const BATCH_SIZE = 20;
  const SCAN_DELAY_MS = 800;
  const INITIAL_SCAN_DELAY_MS = 1200;
  const MIN_SCAN_INTERVAL_MS = 1500;
  const RETRY_DELAYS_MS = [10000, 30000, 60000];
  const RETRY_COOLDOWN_MS = 60000;
  const CANDIDATE_SELECTORS = [
    "[data-ad]",
    "[data-advertisement]",
    "[data-sponsored]",
    "[aria-label*='advert' i]",
    "[aria-label*='sponsor' i]",
    "[id^='ad' i]",
    "[id*='-ad-' i]",
    "[id*='_ad_' i]",
    "[id^='sponsor' i]",
    "[id*='-sponsor' i]",
    "[id^='promo' i]",
    "[id*='-promo' i]",
    "[class^='ad-' i]",
    "[class^='ad_' i]",
    "[class~='ad']",
    "[class~='ads']",
    "[class*=' ad-' i]",
    "[class*=' ad_' i]",
    "[class^='sponsor' i]",
    "[class*=' sponsor-' i]",
    "[class^='promo' i]",
    "[class*=' promo-' i]",
    "iframe",
    "aside",
  ].join(",");
  const MAX_TRACKED_ELEMENTS = 200;
  const MAX_PENDING_CANDIDATES = 300;
  const MAX_PENDING_ROOTS = 64;
  const AD_HINT = /(^|[-_\s])(ad|ads|advert|advertisement|sponsor|sponsored|promoted|promo|promotion|promotional|doubleclick|taboola|outbrain|criteo)([-_\s]|$)/i;
  const stateByElement = new WeakMap();
  let ownClassValues = new WeakMap();
  const trackedElements = new Set();
  const scoresToReapply = new Set();
  const scanRoots = new Set();
  const candidateBacklog = new Set();
  const pendingById = new Map();
  let settings = { enabled: true, threshold: 0.78, hasApiKey: false };
  let scanTimer = null;
  let reapplyTimer = null;
  let retryTimer = null;
  let retryBlockedUntil = 0;
  let retryAttempt = 0;
  let scanInFlight = false;
  let requestEpoch = 0;
  let nextId = 0;
  let lastScanAt = 0;
  let lastReapplyAt = 0;
  let observing = false;
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
      .map((value) => normalize(value, 180).replace(/([a-z])([A-Z])/g, "$1 $2"))
      .join(" ");
    return (
      element.hasAttribute("data-ad") ||
      element.hasAttribute("data-advertisement") ||
      element.hasAttribute("data-sponsored") ||
      AD_HINT.test(attributes)
    );
  }

  function recordFor(element) {
    return stateByElement.get(element);
  }

  function classWithoutMarker(element) {
    return typeof element.className === "string"
      ? element.className.replace(/(^|\s)jev-adblocker-hidden(?=\s|$)/g, " ")
      : "";
  }

  function dimensions(element, record) {
    // Our CSS marker also survives a site's className replacement.
    if (isHidden(element) && record?.width) {
      return { width: record.width, height: record.height };
    }
    const rect = element.getBoundingClientRect();
    if (rect.width >= 12 && rect.height >= 12) {
      return { width: Math.round(rect.width), height: Math.round(rect.height) };
    }
    return { width: Math.round(rect.width), height: Math.round(rect.height) };
  }

  function fingerprint(element, record = recordFor(element)) {
    const size = dimensions(element, record);
    return [
      element.tagName.toLowerCase(),
      normalize(element.id, 100),
      normalize(classWithoutMarker(element), 180),
      normalize(element.getAttribute("role"), 80),
      normalize(element.getAttribute("aria-label"), 160),
      normalize(element.getAttribute("data-testid"), 100),
      normalize(element.getAttribute("data-ad"), 40),
      normalize(element.getAttribute("data-advertisement"), 40),
      normalize(element.getAttribute("data-sponsored"), 40),
      normalize(element.textContent, 220),
      safeUrl(element.getAttribute("href") || element.closest("a")?.href),
      safeUrl(element.getAttribute("src")),
      size.width,
      size.height,
    ].join("\u001f");
  }

  function isEligible(element, record) {
    if (!(element instanceof Element)) return false;
    if (element === document.documentElement || element === document.body) return false;
    if (element.hasAttribute("data-jev-adblocker-ignore")) return false;
    if (isHidden(element) && record) return true;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width >= 12 && rect.height >= 12;
  }

  function isHidden(element) {
    return element.classList.contains("jev-adblocker-hidden") ||
      element.getAttribute("data-jev-adblocker-hidden") === "true";
  }

  function setMarkerClass(element, hidden) {
    if (element.classList.contains("jev-adblocker-hidden") === hidden) return;
    if (hidden) element.classList.add("jev-adblocker-hidden");
    else element.classList.remove("jev-adblocker-hidden");
    if (observing) ownClassValues.set(element, element.getAttribute("class"));
  }

  function unhide(element) {
    const wasHidden = isHidden(element);
    // Even removing an absent token can emit a class mutation. Never write a no-op.
    setMarkerClass(element, false);
    if (element.hasAttribute("data-jev-adblocker-hidden")) {
      element.removeAttribute("data-jev-adblocker-hidden");
    }
    if (wasHidden) stats.hidden = Math.max(0, stats.hidden - 1);
  }

  function applyScore(element, record) {
    if (
      !settings.enabled ||
      !settings.hasApiKey ||
      !Number.isFinite(record.score) ||
      record.score < settings.threshold
    ) {
      unhide(element);
      return;
    }
    const wasHidden = isHidden(element);
    setMarkerClass(element, true);
    if (element.getAttribute("data-jev-adblocker-hidden") !== "true") {
      element.setAttribute("data-jev-adblocker-hidden", "true");
    }
    if (!wasHidden) stats.hidden += 1;
  }

  function restoreAll() {
    for (const element of trackedElements) {
      if (!element.isConnected) {
        if (isHidden(element)) stats.hidden = Math.max(0, stats.hidden - 1);
        trackedElements.delete(element);
        continue;
      }
      unhide(element);
    }
    document.querySelectorAll("[data-jev-adblocker-hidden]").forEach(unhide);
  }

  function pruneTracked() {
    for (const element of trackedElements) {
      if (element.isConnected) continue;
      if (isHidden(element)) stats.hidden = Math.max(0, stats.hidden - 1);
      trackedElements.delete(element);
      scoresToReapply.delete(element);
      const record = recordFor(element);
      if (record?.id) pendingById.delete(record.id);
    }
  }

  function enqueueScanRoot(node) {
    const root = node?.nodeType === 1 || node?.nodeType === 11
      ? node
      : node?.parentElement;
    if (!root || typeof root.querySelectorAll !== "function") return false;
    if (scanRoots.has(root)) return false;
    for (const queuedRoot of scanRoots) {
      if (typeof queuedRoot.contains === "function" && queuedRoot.contains(root)) return false;
      if (typeof root.contains === "function" && root.contains(queuedRoot)) scanRoots.delete(queuedRoot);
    }
    if (scanRoots.size >= MAX_PENDING_ROOTS) return false;
    scanRoots.add(root);
    return true;
  }

  function addCandidatesFromRoot(root) {
    if (!root?.isConnected || candidateBacklog.size >= MAX_PENDING_CANDIDATES) return;
    if (root?.nodeType === 1 && typeof root.matches === "function" && root.matches(CANDIDATE_SELECTORS)) {
      candidateBacklog.add(root);
    }
    if (candidateBacklog.size >= MAX_PENDING_CANDIDATES || typeof root?.querySelectorAll !== "function") return;
    for (const element of root.querySelectorAll(CANDIDATE_SELECTORS)) {
      if (candidateBacklog.size >= MAX_PENDING_CANDIDATES) break;
      candidateBacklog.add(element);
    }
  }

  function describe(element, record, id) {
    const size = dimensions(element, record);
    return {
      id,
      tag: element.tagName.toLowerCase(),
      id_attr: normalize(element.id, 100),
      class_attr: normalize(classWithoutMarker(element), 180),
      role: normalize(element.getAttribute("role"), 80),
      aria_label: normalize(element.getAttribute("aria-label"), 160),
      test_id: normalize(element.getAttribute("data-testid"), 100),
      text: normalize(element.textContent, 220),
      href: safeUrl(element.getAttribute("href") || element.closest("a")?.href),
      src: safeUrl(element.getAttribute("src")),
      width: String(size.width),
      height: String(size.height),
      hint: hasAdHint(element) ? "explicit-ad-hint" : "layout-candidate",
    };
  }

  function metaContent(selector, maxLength) {
    const meta = document.querySelector(selector);
    return normalize(meta?.getAttribute("content"), maxLength);
  }

  function describePage() {
    const main = document.querySelector("article, [role='main'], main") || document.body;
    const headings = [...document.querySelectorAll("h1, h2, h3")]
      .slice(0, 8)
      .map((heading) => normalize(heading.textContent, 140))
      .filter(Boolean);
    const paragraphs = main
      ? [...main.querySelectorAll("p")]
          .slice(0, 12)
          .map((paragraph) => normalize(paragraph.textContent, 240))
          .filter(Boolean)
      : [];
    const mainText = normalize(
      paragraphs.join(" ") || main?.textContent,
      1600,
    );
    return {
      title: normalize(document.title, 180),
      description: metaContent("meta[name='description']", 320),
      section: metaContent("meta[property='article:section'], meta[name='section']", 120),
      headings,
      main_text: mainText,
    };
  }

  function queueCandidate(element) {
    if (!trackedElements.has(element) && trackedElements.size >= MAX_TRACKED_ELEMENTS) return null;
    trackedElements.add(element);
    let record = recordFor(element);
    const currentFingerprint = fingerprint(element, record);
    if (record?.fingerprint === currentFingerprint && (record.status === "queued" || record.status === "judged")) {
      return null;
    }
    if (record?.fingerprint !== currentFingerprint && isHidden(element)) {
      unhide(element);
      record = recordFor(element);
    }
    const refreshedFingerprint = fingerprint(element, record);
    record = {
      status: "queued",
      fingerprint: refreshedFingerprint,
      score: null,
      width: dimensions(element, record).width,
      height: dimensions(element, record).height,
      id: `candidate_${nextId++}`,
    };
    stateByElement.set(element, record);
    pendingById.set(record.id, { element, record, fingerprint: refreshedFingerprint, epoch: requestEpoch });
    return describe(element, record, record.id);
  }

  function collectCandidates() {
    if (!settings.enabled || !settings.hasApiKey) return [];
    pruneTracked();
    for (const root of scanRoots) {
      if (candidateBacklog.size >= MAX_PENDING_CANDIDATES) break;
      scanRoots.delete(root);
      addCandidatesFromRoot(root);
    }
    const items = [];
    for (const element of candidateBacklog) {
      candidateBacklog.delete(element);
      const record = recordFor(element);
      if (!isEligible(element, record)) continue;
      if (!hasAdHint(element) && element.tagName !== "IFRAME" && element.tagName !== "ASIDE") continue;
      const item = queueCandidate(element);
      if (item) items.push(item);
      if (items.length >= BATCH_SIZE) break;
    }
    return items;
  }

  function releaseBatch(items) {
    for (const item of items) {
      const pending = pendingById.get(item.id);
      if (!pending) continue;
      pendingById.delete(item.id);
      if (recordFor(pending.element) === pending.record) {
        pending.record.status = "idle";
        pending.record.id = null;
      }
    }
  }

  function discardPending() {
    for (const pending of pendingById.values()) {
      if (pending.element?.isConnected) enqueueScanRoot(pending.element);
    }
    releaseBatch([...pendingById.values()].map((pending) => ({ id: pending.record.id })));
  }

  function clearRetryState() {
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
    retryBlockedUntil = 0;
    retryAttempt = 0;
  }

  function scheduleRetry(error) {
    if (!error?.retryable) {
      retryBlockedUntil = Number.POSITIVE_INFINITY;
      return;
    }
    let delay;
    if (retryAttempt >= RETRY_DELAYS_MS.length) {
      delay = RETRY_COOLDOWN_MS;
      retryAttempt = 0;
    } else {
      delay = RETRY_DELAYS_MS[retryAttempt];
      retryAttempt += 1;
    }
    retryBlockedUntil = Date.now() + delay;
    if (retryTimer !== null) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      retryBlockedUntil = 0;
      scheduleScan();
    }, delay);
  }

  function scheduleScan(delay = SCAN_DELAY_MS) {
    if (!settings.enabled || !settings.hasApiKey || scanInFlight || scanTimer !== null || retryTimer !== null) return;
    if (retryBlockedUntil === Number.POSITIVE_INFINITY) return;
    if (retryBlockedUntil > Date.now()) {
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        retryBlockedUntil = 0;
        scheduleScan();
      }, retryBlockedUntil - Date.now());
      return;
    }
    const rateLimitDelay = Math.max(0, lastScanAt + MIN_SCAN_INTERVAL_MS - Date.now());
    delay = Math.max(delay, rateLimitDelay);
    scanTimer = window.setTimeout(() => {
      scanTimer = null;
      scan();
    }, delay);
  }

  function scheduleScoreReapply() {
    if (!settings.enabled || !settings.hasApiKey || reapplyTimer !== null || !scoresToReapply.size) return;
    // Cached display updates must still work while an API request is pending or blocked.
    const delay = Math.max(SCAN_DELAY_MS, lastReapplyAt + MIN_SCAN_INTERVAL_MS - Date.now());
    reapplyTimer = window.setTimeout(() => {
      reapplyTimer = null;
      lastReapplyAt = Date.now();
      reapplyCachedScores();
      if (hasWork()) scheduleScan();
    }, delay);
  }

  async function classifyBatch(items) {
    if (!items.length || scanInFlight || !settings.enabled) return;
    scanInFlight = true;
    const batchEpoch = requestEpoch;
    let shouldScheduleFollowUp = false;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "CLASSIFY",
        page: { origin: location.origin, ...describePage() },
        items,
      });
      if (!response?.ok) {
        const error = new Error(response?.error || "classifier unavailable");
        error.code = response?.code;
        error.retryable = response?.retryable === true;
        throw error;
      }
      if (!settings.enabled || batchEpoch !== requestEpoch) {
        releaseBatch(items);
        shouldScheduleFollowUp = settings.enabled;
        return;
      }
      for (const result of response.results || []) {
        const pending = pendingById.get(result.id);
        if (!pending) continue;
        pendingById.delete(result.id);
        const currentFingerprint = fingerprint(pending.element, pending.record);
        if (
          !pending.element.isConnected ||
          pending.epoch !== batchEpoch ||
          pending.record.fingerprint !== currentFingerprint
        ) {
          pending.record.status = "idle";
          pending.record.id = null;
          if (pending.element.isConnected) enqueueScanRoot(pending.element);
          continue;
        }
        pending.record.status = "judged";
        pending.record.id = null;
        pending.record.score = typeof result.score === "number" && Number.isFinite(result.score) ? result.score : null;
        applyScore(pending.element, pending.record);
        stats.checked += 1;
      }
      releaseBatch(items);
      clearRetryState();
      shouldScheduleFollowUp = true;
    } catch (error) {
      if (!settings.enabled || batchEpoch !== requestEpoch) {
        releaseBatch(items);
        shouldScheduleFollowUp = settings.enabled;
        return;
      }
      if (typeof error?.retryable !== "boolean") {
        error = Object.assign(new Error(error?.message || "classifier unavailable"), {
          code: error?.code || "runtime",
          retryable: true,
        });
      }
      stats.serviceErrors += 1;
      if (error?.retryable) {
        for (const item of items) {
          const pending = pendingById.get(item.id);
          if (pending?.element?.isConnected) enqueueScanRoot(pending.element);
        }
      }
      releaseBatch(items);
      if (error?.code === "disabled") return;
      scheduleRetry(error);
    } finally {
      scanInFlight = false;
      if (shouldScheduleFollowUp && hasWork()) scheduleScan();
    }
  }

  function scan() {
    if (!settings.enabled || !settings.hasApiKey || scanInFlight) return;
    lastScanAt = Date.now();
    const items = collectCandidates();
    if (items.length) classifyBatch(items);
    else if (hasWork()) scheduleScan();
  }

  function hasWork() {
    return scanRoots.size || candidateBacklog.size;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "SETTINGS_CHANGED") {
      const previous = settings;
      settings = { ...settings, ...message.settings };
      const enabledChanged = previous.enabled !== settings.enabled;
      const keyStateChanged =
        previous.hasApiKey !== settings.hasApiKey ||
        previous.apiKeyVersion !== settings.apiKeyVersion;
      if (enabledChanged || keyStateChanged) {
        requestEpoch += 1;
        discardPending();
        clearRetryState();
      }
      syncObserver();
      if (!settings.enabled || !settings.hasApiKey) {
        restoreAll();
      } else {
        for (const element of trackedElements) {
          const record = recordFor(element);
          if (element.isConnected && record?.status === "judged") scoresToReapply.add(element);
        }
        scheduleScoreReapply();
        scheduleScan();
      }
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "GET_PAGE_STATS") {
      sendResponse({ stats, settings });
      return false;
    }
    return false;
  });

  function reapplyCachedScores() {
    if (!settings.enabled || !settings.hasApiKey) return;
    for (const element of scoresToReapply) {
      scoresToReapply.delete(element);
      const record = recordFor(element);
      if (!element.isConnected || record?.status !== "judged") continue;
      if (record.fingerprint === fingerprint(element, record)) {
        applyScore(element, record);
      } else {
        unhide(element);
        record.status = "idle";
        record.score = null;
        enqueueScanRoot(element);
      }
    }
  }

  const observer = new MutationObserver((mutations) => {
    if (!settings.enabled || !settings.hasApiKey) return;
    // Only enqueue work here. DOM writes and layout reads must yield to the timer.
    const ownClassTargets = new Set();
    for (const mutation of mutations) {
      if (mutation.type !== "attributes" || mutation.attributeName !== "class") continue;
      const target = mutation.target;
      if (!ownClassValues.has(target)) continue;
      if (ownClassValues.get(target) === target.getAttribute("class")) ownClassTargets.add(target);
      // Consume this batch, not future site changes back to the same class value.
      ownClassValues.delete(target);
    }
    let shouldScheduleScan = false;
    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        for (const node of mutation.addedNodes || []) {
          shouldScheduleScan = enqueueScanRoot(node) || shouldScheduleScan;
        }
        continue;
      }
      if (mutation.type === "characterData") {
        shouldScheduleScan = enqueueScanRoot(mutation.target) || shouldScheduleScan;
        continue;
      }
      if (mutation.type === "attributes") {
        const target = mutation.target;
        if (mutation.attributeName === "class") {
          if (ownClassTargets.has(target)) continue;
          if (recordFor(target)?.status === "judged") scoresToReapply.add(target);
        }
        shouldScheduleScan = enqueueScanRoot(target) || shouldScheduleScan;
      }
    }
    scheduleScoreReapply();
    if (shouldScheduleScan || hasWork()) scheduleScan();
  });

  function syncObserver() {
    if (settings.enabled && settings.hasApiKey) {
      if (observing) return;
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["id", "class", "role", "aria-label", "data-testid", "data-ad", "data-advertisement", "data-sponsored", "href", "src"],
      });
      observing = true;
      enqueueScanRoot(document.body || document.documentElement);
    } else {
      observer.disconnect();
      observing = false;
      if (scanTimer !== null) window.clearTimeout(scanTimer);
      if (reapplyTimer !== null) window.clearTimeout(reapplyTimer);
      scanTimer = null;
      reapplyTimer = null;
      ownClassValues = new WeakMap();
      scanRoots.clear();
      candidateBacklog.clear();
      scoresToReapply.clear();
    }
  }

  chrome.runtime
    .sendMessage({ type: "GET_SETTINGS", origin: location.origin })
    .then((response) => {
      if (response?.settings) settings = response.settings;
      syncObserver();
      if (settings.enabled) {
        const jitter = Math.floor(Math.random() * 800);
        scheduleScan(INITIAL_SCAN_DELAY_MS + jitter);
      }
    })
    .catch(() => undefined);
})();
