(async () => {
  "use strict";
  const params = new URLSearchParams(location.search);
  if (!params.has("fixture")) {
    const cases = [
      "baseline-low", "low", "high", "null-score", "low-class-change",
      "high-class-rewrite", "class-roundtrip", "content-replaced", "off-on",
      "key-removed", "threshold", "threshold-after-auth-error",
      "stale-success", "stale-error", "no-key",
    ];
    const results = [];
    for (const name of cases) {
      const frame = document.createElement("iframe");
      const completed = new Promise(resolve => {
        const listener = event => {
          if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
          window.removeEventListener("message", listener);
          resolve(event.data);
        };
        window.addEventListener("message", listener);
      });
      frame.src = "/?fixture=1&case=" + encodeURIComponent(name);
      document.body.append(frame);
      const result = await completed;
      results.push(result);
      document.getElementById("result").textContent = JSON.stringify(results, null, 2);
      await fetch("/result", { method: "POST", body: JSON.stringify(result) });
      frame.remove();
    }
    const failures = results.filter(result => !result.passed).length;
    document.title = `Jev observer regression: ${failures ? "FAIL" : "PASS"} (${results.length - failures}/${results.length})`;
    document.querySelector("h1").textContent = document.title;
    return;
  }

  document.body.innerHTML = '<h1>Sports article</h1><p>Match report.</p><aside id="ad_candidate" class="sidebar" style="width:320px;height:80px">Related match reports</aside>';
  const candidate = document.getElementById("ad_candidate");
  const name = params.get("case");
  const NativeObserver = window.MutationObserver;
  const nativeRect = Element.prototype.getBoundingClientRect;
  const metrics = {
    case: name, userAgent: navigator.userAgent,
    observerCallbacks: 0, classMutations: 0, geometryReads: 0,
    geometryReadsInObserver: 0, classifierCalls: 0,
    stopLimitHit: false, timerRanBeforeCutoff: false, failures: [],
  };
  let observer, firstCallbackAt, listener, inObserver = false, finished = false;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = (condition, message) => { if (!condition) metrics.failures.push(message); };
  const hidden = element => element.getAttribute("data-jev-adblocker-hidden") === "true";
  const sendSettings = settings => listener({ type: "SETTINGS_CHANGED", settings }, {}, () => {});
  const pageStats = () => {
    let stats;
    listener({ type: "GET_PAGE_STATS" }, {}, response => { stats = { ...response.stats }; });
    return stats;
  };
  async function waitUntil(condition, message, timeout = 7000) {
    const deadline = performance.now() + timeout;
    while (!condition() && performance.now() < deadline && !metrics.stopLimitHit) await pause(30);
    check(condition(), message);
    await pause(60);
  }
  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    metrics.finalClass = candidate.className;
    metrics.hidden = hidden(candidate);
    metrics.stats = listener ? pageStats() : null;
    observer?.disconnect();
    if (listener) sendSettings({ enabled: false });
    metrics.passed = metrics.failures.length === 0;
    parent.postMessage(metrics, location.origin);
  }
  const watchdog = setTimeout(() => { check(false, "fixture timed out"); finish(); }, 25000);
  Element.prototype.getBoundingClientRect = function () {
    metrics.geometryReads++;
    if (inObserver) metrics.geometryReadsInObserver++;
    return nativeRect.call(this);
  };
  window.MutationObserver = class {
    constructor(callback) {
      this.native = new NativeObserver(records => {
        firstCallbackAt ??= performance.now();
        metrics.observerCallbacks++;
        metrics.classMutations += records.filter(record => record.attributeName === "class").length;
        if (metrics.observerCallbacks >= 200) {
          metrics.stopLimitHit = true;
          metrics.loopMilliseconds = +(performance.now() - firstCallbackAt).toFixed(2);
          this.disconnect();
          return;
        }
        inObserver = true;
        try { callback(records, this); } finally { inObserver = false; }
      });
      observer = this;
    }
    observe(...args) { this.native.observe(...args); }
    disconnect() { this.native.disconnect(); }
    takeRecords() { return this.native.takeRecords(); }
  };
  function scoreFor(call) {
    if (name === "null-score") return null;
    if (name.startsWith("threshold")) return 0.8;
    if (["baseline-low", "low", "low-class-change", "stale-success", "stale-error"].includes(name)) return 0.1;
    if (["content-replaced", "class-roundtrip"].includes(name) && call > 1) return 0.1;
    return 0.95;
  }
  window.chrome = {
    runtime: {
      onMessage: { addListener(callback) { listener = callback; } },
      async sendMessage(message) {
        if (message.type === "GET_SETTINGS") {
          return { settings: { enabled: true, hasApiKey: name !== "no-key", threshold: 0.78, apiKeyVersion: 1 } };
        }
        if (message.type !== "CLASSIFY") return;
        const call = ++metrics.classifierCalls;
        // A microtask feedback loop prevents this ordinary task from running.
        setTimeout(() => { metrics.timerRanBeforeCutoff = !metrics.stopLimitHit; }, 0);
        if (name.startsWith("stale-") && call === 1) {
          sendSettings({ enabled: false });
          sendSettings({ enabled: true });
          await pause(60);
          if (name === "stale-error") return { ok: false, code: "invalid-key", retryable: false };
          return { ok: true, results: message.items.map(item => ({ id: item.id, score: 0.95 })) };
        }
        if (name === "threshold-after-auth-error" && call === 2) {
          return { ok: false, code: "invalid-key", retryable: false };
        }
        return { ok: true, results: message.items.map(item => ({ id: item.id, score: scoreFor(call) })) };
      },
    },
  };
  try {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "/content.css";
    document.head.append(css);
    await new Promise((resolve, reject) => { css.onload = resolve; css.onerror = reject; });
    const script = document.createElement("script");
    script.src = "/content.js?baseline=" + (name === "baseline-low" ? "1" : "0");
    document.body.append(script);
    await new Promise((resolve, reject) => { script.onload = resolve; script.onerror = reject; });

    if (name === "no-key") {
      for (let i = 0; i < 20; i++) candidate.className = "sidebar state-" + i;
      await pause(2200);
      check(metrics.observerCallbacks === 0 && metrics.classifierCalls === 0, "no-key mode must not observe or classify");
      finish();
      return;
    }
    await waitUntil(() => metrics.classifierCalls >= 1, "initial classification missing");
    if (name === "baseline-low") {
      check(metrics.stopLimitHit && metrics.observerCallbacks === 200, "positive control must reproduce the old loop");
      check(!metrics.timerRanBeforeCutoff, "old loop should starve the task queue until cutoff");
      finish();
      return;
    }
    if (["low", "null-score"].includes(name)) check(!hidden(candidate), "low or unknown score must remain visible");
    if (name === "high") check(hidden(candidate), "high score must hide");
    if (name === "low-class-change") {
      candidate.className = "sidebar updated-by-site";
      await waitUntil(() => metrics.classifierCalls === 2, "external class change must be reclassified");
      check(!hidden(candidate), "low score class change must remain visible");
    }
    if (name === "high-class-rewrite") {
      candidate.className = "sidebar";
      await waitUntil(() => candidate.classList.contains("jev-adblocker-hidden"), "site class rewrite must restore hidden marker");
      check(hidden(candidate) && metrics.classifierCalls === 1, "unchanged cached ad should not request another score");
      check(pageStats().hidden === 1, "restoring one marker must not inflate hidden count");
    }
    if (name === "class-roundtrip") {
      for (const [index, className] of ["sidebar variant", "sidebar other", "sidebar variant"].entries()) {
        candidate.className = className;
        await waitUntil(() => metrics.classifierCalls === index + 2, "later external class value must not be mistaken for an old own mutation");
      }
      check(!hidden(candidate), "replacement low-score content should remain visible");
    }
    if (name === "content-replaced") {
      candidate.textContent = "Normal editorial match report";
      candidate.className = "sidebar replacement";
      await waitUntil(() => metrics.classifierCalls === 2, "reused element must be reclassified");
      check(!hidden(candidate), "stale high score must not hide replacement content");
    }
    if (["off-on", "key-removed"].includes(name)) {
      sendSettings(name === "off-on" ? { enabled: false } : { hasApiKey: false, apiKeyVersion: 2 });
      check(!hidden(candidate), "disabling must restore immediately");
      const callbacks = metrics.observerCallbacks;
      for (let i = 0; i < 20; i++) candidate.className = "sidebar state-" + i;
      candidate.className = "sidebar";
      const added = candidate.cloneNode(true);
      added.id = "ad_added_while_disabled";
      document.body.append(added);
      await pause(150);
      check(metrics.observerCallbacks === callbacks, "disabled mode must disconnect the observer");
      sendSettings({ enabled: true, hasApiKey: true, apiKeyVersion: 3 });
      await waitUntil(() => hidden(candidate) && hidden(added), "enabling must cover cached and newly added elements");
      check(metrics.classifierCalls === 2, "re-enabling should classify the new element only");
    }
    if (name.startsWith("threshold")) {
      if (name === "threshold-after-auth-error") {
        const added = document.createElement("aside");
        added.id = "ad_auth_error";
        added.style.cssText = "width:320px;height:80px";
        added.textContent = "Another candidate";
        document.body.append(added);
        await waitUntil(() => pageStats().serviceErrors === 1, "second request should produce a non-retryable error");
      }
      sendSettings({ threshold: 0.9 });
      await waitUntil(() => !hidden(candidate), "raising threshold must restore cached element even after auth failure");
      sendSettings({ threshold: 0.75 });
      await waitUntil(() => hidden(candidate), "lowering threshold must reapply cached score");
      check(metrics.classifierCalls === (name === "threshold" ? 1 : 2), "threshold updates must not retry the API");
    }
    if (name.startsWith("stale-")) {
      await waitUntil(() => metrics.classifierCalls === 2, "stale response must not stall the new settings generation");
      check(!hidden(candidate) && pageStats().serviceErrors === 0, "stale high score or auth error must be ignored");
    }
    await pause(150);
    check(!metrics.stopLimitHit, "fixed source must not enter observer loop");
    check(metrics.geometryReadsInObserver === 0, "observer must not read layout synchronously");
    check(metrics.timerRanBeforeCutoff, "ordinary tasks must remain runnable");
    if (["low", "null-score"].includes(name)) check(metrics.observerCallbacks === 0, "visible decisions must not write class attributes");
    finish();
  } catch (error) {
    check(false, String(error?.stack || error));
    finish();
  }
})();
