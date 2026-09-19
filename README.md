# Jev Ad Blocker

[English documentation](README.en.md)

Chrome Manifest V3 の広告ブロッカーです。既知の広告・トラッキングドメインは `declarativeNetRequest` の固定ルールで止め、DOM 上で判断が必要な候補だけを TypeSafe の `jev-latest` に問い合わせます。

## 構成

- `manifest.json` / `rules.json`: Chrome 拡張と固定のネットワークルール
- `content.js`: 広告候補の収集・非表示・MutationObserver
- `background.js`: 拡張の Service Worker。TypeSafe API を直接呼び出す
- `popup.*`: 有効/無効、Jev しきい値、API キー設定、状態表示

Node.js、npm、ローカルサーバーは必要ありません。API キーはポップアップから入力し、`chrome.storage.local` に保存します。入力済みのキーは画面へ再表示しません。

## インストール

1. Chrome で `chrome://extensions` を開き、「デベロッパーモード」を有効にします。
2. 「パッケージ化されていない拡張機能を読み込む」を選び、このフォルダ（`jev-adblocker`）を指定します。
3. ツールバーの Jev Ad Blocker を開き、TypeSafe API キーを入力して「キーを保存」を押します。
4. 対象ページを再読み込みします。

API キーはこの Chrome プロファイルの拡張ストレージに保存され、ページ全体は送信されません。候補要素の短い属性（タグ、クラス、ラベル、短いテキスト、クエリ文字列を除いた URL）だけが TypeSafe に送信されます。

## 判定の流れ

候補を最大20件ずつ一つの System One リクエストへまとめ、候補ごとに独立した Noul 質問を作ります。返った `noul`（広告である確率）が初期しきい値 0.78 以上なら要素を非表示にします。しきい値はポップアップから 50〜99% に変更できます。API が未設定・失敗したときは候補を隠さず、固定ドメインルールだけを使います。

## 注意

この構成は個人利用・ローカル利用向けです。API キーを拡張ストレージに置くため、同じ Chrome プロファイルを操作できるユーザーや開発者ツールからキーを取得できます。Chrome Web Store で公開する場合は、キーを拡張へ入れず、認証付きのサーバーを用意してください。
