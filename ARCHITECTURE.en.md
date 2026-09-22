# Jev Ad Blocker Architecture

[日本語の設計書](ARCHITECTURE.md)

## Goal

Block well-known advertising endpoints with low latency while using TypeSafe Jev to interpret site-specific `sponsored` labels and ad widgets in the context of the current page. The decision is whether a candidate should be hidden as advertising on this page, not whether a hard-coded site ID matches. If Jev is unavailable, the extension should keep the page usable and fall back to deterministic rules.

## Runtime components

1. Chrome's Declarative Net Request engine blocks known domains from `rules.json` before requests are made.
2. `content.js` collects short text and DOM attributes for visible candidates, plus a bounded page-context summary (title, description, section, leading headings, and a short main-text excerpt), and sends at most 20 candidates at a time to `background.js`. It avoids broad substring scans, processes only added or changed DOM subtrees, and applies bounded debouncing and work limits.
3. `background.js` reads the API key from `chrome.storage.local` and calls `https://api.typesafe.ai/v1/systemone` directly from the extension Service Worker. Classification requests from multiple tabs are concurrency-limited and queued with a finite bound.
4. The Service Worker puts the page context and candidates into one System One request and builds one independent Noul question per candidate asking whether it should be hidden as advertising on this page.
5. If a candidate's `noul` probability reaches the configured threshold, `content.js` applies a scoped CSS class to hide that element.

## API-key handling

The popup can save or delete the key. `GET_SETTINGS` and settings broadcasts never contain the key itself; they expose only `hasApiKey` and a non-secret key version. The input is cleared after a refresh and the stored key is never rendered back into the popup. `chrome.storage.local` is restricted to `TRUSTED_CONTEXTS` so content scripts cannot read it directly. Jev enablement is stored per site origin.

This is suitable for personal use, not for protecting a secret in a publicly distributed extension. A production or Chrome Web Store deployment should put the key behind an authenticated server.

## Privacy and failure behavior

- The full page is never sent. Short candidate text and attributes plus a bounded page-context summary are sent directly from the extension to TypeSafe, and URL query strings and fragments are removed.
- Network, 429, and 529 responses use bounded backoff. Missing-key and 401 responses stop automatic retries.
- Missing keys, 401 responses, and network failures leave semantic candidates visible.
- Static domain rules continue to work regardless of the AI request outcome.

## Verification and updates

The extension is a build-free Manifest V3 project. Load the folder through Chrome's **Load unpacked** flow. After changing files, click **Reload** on `chrome://extensions` and reload the target page.
