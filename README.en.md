# Jev Ad Blocker

[日本語のドキュメント](README.md)

A Chrome Manifest V3 ad blocker that combines deterministic network rules with TypeSafe's `jev-latest` model. Known advertising and tracking domains are blocked before the request is made; DOM candidates that need semantic interpretation are evaluated by Jev.

## What is included

- `manifest.json` / `rules.json`: the Chrome extension manifest and static network rules
- `content.js`: collects candidate elements, hides judged ads, and watches dynamic page changes
- `background.js`: the extension Service Worker that calls the TypeSafe API directly
- `popup.*`: enable/disable control, Jev threshold, API-key settings, and status display

The extension has no Node.js, npm, or local-server dependency. Enter the TypeSafe API key in the popup; it is stored in `chrome.storage.local`. The key is never displayed again after saving. Jev enablement is stored per site origin.

## Installation

1. Open `chrome://extensions` in Chrome and enable **Developer mode**.
2. Click **Load unpacked** and select this folder (`jev-adblocker`).
3. Open the Jev Ad Blocker toolbar popup, enter your TypeSafe API key, and click **キーを保存** (Save key).
4. Reload the page you want to browse.

The API key stays in this Chrome profile's extension storage. The extension does not send the full page: it sends short candidate text and attributes such as the tag, classes, labels, and a URL with its query string removed, plus a small page-context summary (title, description, section, leading headings, and a short excerpt from the main text) directly from the extension to TypeSafe.

## How classification works

The extension batches up to 20 candidates into one System One request and asks one independent Noul question per candidate. Each question sees the page subject, headings, and excerpt together with the candidate's attributes and text, and asks whether that candidate should be hidden as advertising on this page. When the returned `noul` value (the probability that it is an ad worth hiding in this context) reaches the default threshold of `0.78`, the candidate is hidden. The threshold can be adjusted from 50% to 99% in the popup. There are no site-specific hard-coded exclusions for native widgets such as job listings. DOM scanning is limited to changed subtrees with bounded candidate counts and debounce intervals, and TypeSafe requests are concurrency-limited across tabs.

401 and missing-key errors stop automatic retries. Network, 429, and 529 errors use bounded backoff. If the key is missing or the TypeSafe request fails, the extension leaves semantic candidates visible and continues using the deterministic domain blocklist. This fail-open behavior avoids hiding ordinary page content when the AI service is unavailable.

## Privacy and security note

This direct-from-extension configuration is intended for personal or local use. An API key stored in extension storage can be accessed by someone who can inspect or modify the same Chrome profile or extension. Do not publish a key in this repository. For Chrome Web Store distribution, move the key behind an authenticated server instead of shipping it with the extension.

## Responsiveness fix (0.3.2)

Fixed a MutationObserver feedback loop that could freeze Chrome when a low-scoring element was left visible. Marker writes are now idempotent, and the observer only queues work instead of reading layout or updating visibility. DOM observation stops when Jev is disabled for the site or no API key is configured. Cached decisions still respond to threshold changes while API retries are blocked.

After updating the files, click **Reload** for the extension on `chrome://extensions`, then reload the affected pages as well. Existing tabs retain the old content script until the page is reloaded.

The local regression suite uses real browser DOM and MutationObserver behavior, with mocked extension messages and no TypeSafe requests. With Node.js and Git available, run `node diagnostics/serve-observer-repro.cjs` and open `http://127.0.0.1:8765` in a separate browser without this extension. The historical positive-control case deliberately reaches a 200-callback safety cutoff; fixed-source cases must not. Results appear on the page and are saved to `diagnostics/observer-regression-results.jsonl` (ignored by Git). Stop the server with Ctrl+C. Node.js is only a development-test dependency, not an extension requirement.

## Project notes

See [ARCHITECTURE.en.md](ARCHITECTURE.en.md) for the component boundaries, request flow, and failure behavior. The TypeSafe API contract is documented at <https://docs.typesafe.ai/api>.
