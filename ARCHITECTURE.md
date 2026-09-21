# Jev Ad Blocker の設計

[English architecture notes](ARCHITECTURE.en.md)

## 目的

既知の広告配信先を低遅延で止めつつ、サイトごとに異なる `sponsored` 表示や広告ウィジェットを TypeSafe Jev の構造化判定で補完する。Jev が利用できない場合にページを壊さないことを優先する。Node.js/npm には依存しない。

## 実行単位

1. Chrome の Declarative Net Request が `rules.json` の既知ドメインをリクエスト前にブロックする。
2. `content.js` が広告候補の短い本文と DOM 属性だけを集め、最大20件ずつ `background.js` に送る。
3. `background.js` が `chrome.storage.local` から API キーを読み、TypeSafe の `https://api.typesafe.ai/v1/systemone` を直接呼び出す。
4. Service Worker が候補配列を一つの System One リクエストの独立した Noul 質問へ分解する。
5. `noul` の値が拡張設定のしきい値以上なら、`content.js` が要素へ限定的な CSS クラスを付けて非表示にする。

## API キー

ポップアップの入力欄から保存・削除する。`GET_SETTINGS` やコンテンツスクリプトへの通知ではキー本体を渡さず、`hasApiKey` と非秘密のキー世代だけを返す。入力済みのキーは再表示しない。`chrome.storage.local` は `TRUSTED_CONTEXTS` に制限し、コンテンツスクリプトから直接読めないようにする。Jevの有効状態はサイトoriginごとに保存する。

この方式は個人利用向けで、拡張を配布する場合の秘密保持には不十分。公開配布時は API キーをサーバー側へ移し、拡張へ埋め込まない。

## プライバシーと失敗時の挙動

- ページ全体は送信しない。候補の短いテキストと属性を拡張からTypeSafeへ直接送り、URL のクエリ・ハッシュは除去する。
- TypeSafe API の 429/529と通信失敗は回数制限付きバックオフで再試行し、401・キー未設定では自動再試行を停止する。
- キー未設定、401、通信失敗では AI 判定を適用せず、候補を表示したままにする。
- 固定ルールは AI の成否に関係なく継続する。

## 確認

拡張側はビルド不要の Manifest V3 で、Chrome の「パッケージ化されていない拡張機能を読み込む」からフォルダを読み込む。変更後は拡張管理画面で「更新」を押し、対象ページを再読み込みする。
