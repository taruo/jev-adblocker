# Jev Ad Blocker

[日本語のドキュメント](README.md)

A Chrome Manifest V3 ad blocker that combines deterministic network rules with TypeSafe's `jev-latest` model. Known advertising and tracking domains are blocked before the request is made; DOM candidates that need semantic interpretation are evaluated by Jev.

## What is included

- `manifest.json` / `rules.json`: the Chrome extension manifest and static network rules
- `content.js`: collects candidate elements, hides judged ads, and watches dynamic page changes
- `background.js`: the extension Service Worker that calls the TypeSafe API directly
- `popup.*`: enable/disable control, Jev threshold, API-key settings, and status display

The extension has no Node.js, npm, or local-server dependency. Enter the TypeSafe API key in the popup; it is stored in `chrome.storage.local`. The key is never displayed again after saving.

## Installation

1. Open `chrome://extensions` in Chrome and enable **Developer mode**.
2. Click **Load unpacked** and select this folder (`jev-adblocker`).
3. Open the Jev Ad Blocker toolbar popup, enter your TypeSafe API key, and click **キーを保存** (Save key).
4. Reload the page you want to browse.

The API key stays in this Chrome profile's extension storage. The extension does not send the full page: it sends only short candidate attributes such as the tag, classes, labels, a short text snippet, and a URL with its query string removed.

## How classification works

The extension batches up to 20 candidates into one System One request and asks one independent Noul question per candidate. When the returned `noul` value (the probability that the candidate is advertising) reaches the default threshold of `0.78`, the candidate is hidden. The threshold can be adjusted from 50% to 99% in the popup.

If the key is missing or the TypeSafe request fails, the extension leaves semantic candidates visible and continues using the deterministic domain blocklist. This fail-open behavior avoids hiding ordinary page content when the AI service is unavailable.

## Privacy and security note

This direct-from-extension configuration is intended for personal or local use. An API key stored in extension storage can be accessed by someone who can inspect or modify the same Chrome profile or extension. Do not publish a key in this repository. For Chrome Web Store distribution, move the key behind an authenticated server instead of shipping it with the extension.

## Project notes

See [ARCHITECTURE.en.md](ARCHITECTURE.en.md) for the component boundaries, request flow, and failure behavior. The TypeSafe API contract is documented at <https://docs.typesafe.ai/api>.
