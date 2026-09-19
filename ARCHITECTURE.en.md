# Jev Ad Blocker Architecture

[日本語の設計書](ARCHITECTURE.md)

## Goal

Block well-known advertising endpoints with low latency while using TypeSafe Jev to interpret site-specific `sponsored` labels and ad widgets. If Jev is unavailable, the extension should keep the page usable and fall back to deterministic rules.

## Runtime components

1. Chrome's Declarative Net Request engine blocks known domains from `rules.json` before requests are made.
2. `content.js` collects only DOM attributes for visible candidates and sends at most 20 candidates at a time to `background.js`.
3. `background.js` reads the API key from `chrome.storage.local` and calls `https://api.typesafe.ai/v1/systemone` directly from the extension Service Worker.
4. The Service Worker builds one independent Noul question per candidate in a single System One request.
5. If a candidate's `noul` probability reaches the configured threshold, `content.js` applies a scoped CSS class to hide that element.

## API-key handling

The popup can save or delete the key. `GET_SETTINGS` and settings broadcasts never contain the key itself; they expose only `hasApiKey`. The input is cleared after a refresh and the stored key is never rendered back into the popup.

This is suitable for personal use, not for protecting a secret in a publicly distributed extension. A production or Chrome Web Store deployment should put the key behind an authenticated server.

## Privacy and failure behavior

- The full page is never sent. Candidate text and attributes are truncated, and URL query strings and fragments are removed.
- TypeSafe 429 and 529 responses are retried with a short exponential backoff.
- Missing keys, 401 responses, and network failures leave semantic candidates visible.
- Static domain rules continue to work regardless of the AI request outcome.

## Verification and updates

The extension is a build-free Manifest V3 project. Load the folder through Chrome's **Load unpacked** flow. After changing files, click **Reload** on `chrome://extensions` and reload the target page.
