# PolyPage — Web Translator Extension

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | **日本語**

[![CI](https://github.com/Skymly/PolyPage/actions/workflows/ci.yml/badge.svg)](https://github.com/Skymly/PolyPage/actions/workflows/ci.yml)
[![GitHub Release](https://img.shields.io/github/v/release/Skymly/PolyPage?label=Release)](https://github.com/Skymly/PolyPage/releases)

Chrome・Edge・Firefox 向けの Manifest V3 バイリンガル翻訳ブラウザ拡張機能（TypeScript + 任意の C#/.NET ローカルゲートウェイ）。

ご自身の **LLM / 翻訳 API / ローカルモデル** を接続し、Web ページ、PDF、画像、動画字幕、字幕なし動画／音声を翻訳できます：

- 原文 / 訳文 / 二言語対訳 / **段落内インライン対訳** など 6 種類の Web 表示モード；
- **バイリンガル PDF リーダー**：拡張機能内リーダーページ（ローカル pdf.js）、ページ単位テキストクラスタリング、ページ単位遅延翻訳、ドキュメントフィンガープリントキャッシュ（再オープン時 API 呼び出しゼロ）、スキャンページへの有効な OCR エンジンでの文字認識；
- **画像内テキスト翻訳（OCR）**：右クリックメニュー / ホバーボタンから起動；マルチモーダル視覚モデルによる一段階翻訳、または **`tesseract-wasm` ローカル認識後のテキストパイプライン実行**；Shadow DOM 結果パネル；
- **動画字幕翻訳**：`<track>` 字幕を引き継ぎ、独自の二言語字幕レイヤーを描画；`subtitleSelectors` サイトルールによりカスタム描画字幕サイト（YouTube など）に対応；
- **字幕なし動画 / 音声 ASR**：ユーザーがクリックした後、現在の再生位置から有限ウィンドウを取り込んでインメモリ cue に文字起こしし、同じ字幕レイヤーで翻訳と復元を実行（既定では全体の自動文字起こしを行いません）；
- **選択テキスト翻訳 + 読み上げ**、`Alt+Q` による直前選択の再翻訳、**不良訳文マーク用フィードバックログ**（CSV/JSON エクスポート）；
- **ページ言語の自動検出**（ローカル・依存ゼロ・12 言語対応）：`auto` ソース言語補完 + 同一言語の自動翻訳ガード；
- **翻訳再開**：バックグラウンドタスク表を永続化（IndexedDB）し、Service Worker 再起動後にタブ単位で進行中タスクを復元（キャッシュべき等）；
- **Shadow DOM / iframe（同一オリジン＋クロスオリジン）/ サイトルール / 仮想リストビューポート翻訳** に対応；
- **DeepL / Azure Translator / Google Translate / Ollama / Whisper ゲートウェイ** のプリセットとフェイルオーバーチェーン；
- **ローカル .NET ゲートウェイ（Native Messaging Host）**：任意依存、プロトコル v2 で画像 / 文字起こし / チャンク転送に対応；
- 用語集、バイリンガルエクスポート、翻訳キャッシュ、バッチ統合、タイムアウト/リトライ、エラー分類、ログ機能。

> 現在の仕様は `PolyPage-4.2.md` と `docs/VALIDATION-4.2.md` に準拠します。完了済みの 1.0–4.1 の計画と検証記録は `docs/history/`、Firefox の差異は `docs/FIREFOX-MV3.md`、ストア申請資料は `docs/store/` を参照してください。

<details>
<summary>リリースハイライト（4.0 – 4.2）</summary>

- **4.2**（`PolyPage-4.2.md`）：`<think>` / qwen3 断片の統一除去（空結果は失敗扱いとしてキャッシュ/TM 非書き込み）、隔離プロファイル + Marionette による Firefox `host-status`・native-host 翻訳検証、実装有無に応じたストリーミング cue 制御、スクロール時のオーバーレイ再計算、PDF テーブルフィクスチャ。設定 `schemaVersion: 6`、プロトコル `v: 6`、ゲートウェイ `4.2.1`（`ProtocolVersion = 2`）。
- **4.1**（`docs/history/PolyPage-4.1.md`）：既定オフの独立 IndexedDB 文単位 TM（5000 件リングバッファ）、Options からの `tessdata_fast` OCR 言語パック（`jpn`/`kor`/`fra`/`deu`）ダウンロード、Firefox `connectNative` ping・翻訳プローブ、PDF 単段組み/二段組み/テーブルプリセット（`schemaVersion: 5`）。
- **4.0**（`docs/history/PolyPage-4.0.md`）：ユーザー起動の字幕なし動画/音声キャプチャ（既定 90 秒ウィンドウ）およびゲートウェイ Whisper 連携、マルチモーダル `translate.image` / `transcribe` / `binary.chunk` プロトコル v2、ローカル同梱 `tesseract-wasm`（`eng` + `chi_sim`）、`dist-firefox/` MVP（`schemaVersion: 4`）。

</details>

## ディレクトリ構成

```text
├── public/
│   ├── icons/                  # ビルドスクリプトが生成するアイコン
│   └── manifest.json           # MV3 マニフェスト 4.2.1（任意の webNavigation、マイクなし）
├── src/
│   ├── background/             # service-worker + nativePort（キュー/フェイルオーバー/OCR/ASR/再開）
│   ├── content/                # Web 翻訳 + 字幕レイヤー + 選択翻訳 + 画像ボタン + ASR 収集
│   ├── asr/                    # ★ 文字起こしセグメント分割（segments 指定 / プレーンテキスト均等分割）
│   ├── viewer/                 # バイリンガル PDF リーダー（スキャンページ OCR 対応）
│   ├── ocr/                    # OcrEngine + llm-vision + tesseract-wasm + 結果パネル
│   ├── popup/                  # 6 モード、PDF/字幕/ASR エントリポイント
│   ├── options/                # 一般/サービス/用語集/サイトルール/PDF/画像/字幕/ASR/ゲートウェイ/フィードバック…
│   ├── providers/              # 任意の translateStream / translateImage / transcribe
│   ├── storage/                # settings schema v6 + マイグレーション + cache + feedback + taskTable
│   ├── messaging/messages.ts   # プロトコル v6（完全型付け、旧メッセージ互換）
│   ├── shared/                 # types/constants/binaryChunk/languageDetect/…
│   └── styles/
├── vendor/                     # pdf.js + tesseract.js + tessdata（ビルド時 SHA-256 検証）
├── native-host/                # C#/.NET ゲートウェイ 4.2.1 / プロトコル v2（Ollama / HTTP / Whisper）
├── scripts/
│   ├── build.mjs               # Chrome/Edge dist/ + Firefox dist-firefox/
│   ├── manifest-firefox.mjs    # gecko.id + background.scripts イベントページ
│   ├── smoke-test.mjs          # ヘッドレス Edge E2E スモーク（`npm run smoke` の出力を参照）
│   ├── gateway-contract-test.mjs
│   ├── gateway-ollama-check.mjs
│   └── load-edge-ollama.mjs    # headed Edge + ローカル Ollama 手動結合テスト
├── tests/                      # vitest 単体テスト（`npm run test` の出力を参照）
└── docs/                       # VALIDATION-4.2、history/、FIREFOX-MV3、store/
```

## 開発

Node.js 24 を推奨します（サポート範囲は `package.json` の `engines` を参照）。完全なゲートウェイ検証の実行には Windows、.NET 10 SDK、および .NET 8 ランタイムが必要です（ゲートウェイテストの対象は `net8.0`）。

```bash
npm ci
npm run build        # dist/ と dist-firefox/ を出力
npm run typecheck    # tsc --noEmit（strict）
npm run test         # vitest（コマンド出力を参照）
npm run smoke        # ヘッドレス Edge E2E スモーク（要ビルド；ゲートウェイの登録・解除を含む）
npm run verify       # typecheck + test + build + ゲートウェイ xUnit
npm run test:contract # 現コミットのゲートウェイ stdio 契約テスト
npm run verify:all   # verify + stdio 契約 + Edge smoke（Firefox は除く）

# ゲートウェイ
dotnet build native-host/PolyPage.slnx
dotnet test  native-host/PolyPage.slnx                     # コマンド出力を参照
```

拡張機能の読み込み：

- Chrome / Edge：`chrome://extensions`（Edge は `edge://extensions`）→ デベロッパーモード → **「パッケージ化されていない拡張機能を読み込む」** から `dist/` を選択。
- Firefox：`about:debugging` → この Firefox → **「一時的なアドオンを読み込む」** → `dist-firefox/manifest.json` を選択。機能の制限は `docs/FIREFOX-MV3.md` を参照。

> 公式 Chrome のヘッドレスモードは `--load-extension` を無視するため、スモークテストには Edge を使用します。  
> ローカルの Ollama へ直接接続する場合は `OLLAMA_ORIGINS=*`（または `chrome-extension://*` / `moz-extension://*`）を設定したうえでトレイから終了して Ollama を再起動してください。設定しない場合、拡張機能 Origin からのリクエストは HTTP 403 になります。

## 翻訳サービスの設定

設定画面 → **「翻訳サービス」** → **「サービスを追加」** でプリセットを選ぶとエンドポイントが自動入力されます。モデル一覧の取得に対応したサービスでは API Key を入力して **「モデル一覧を取得」** を押し、モデルを選択して保存します。モデル ID の手入力やカスタム OpenAI 互換エンドポイントの追加も可能です。複数の Provider を併用し、使用中のサービス選択や**フェイルオーバーチェーン**を設定できます。

- **openai-compatible**：`POST {baseUrl}/chat/completions`。SSE ストリーミング、MiniMax Token Plan（`api.minimax.chat` / MiniMax-M3 視覚）、**画像翻訳（`image_url`）**、**`/audio/transcriptions` 文字起こし**に対応；ローカルエンドポイントでは API Key 不要。
- **OpenCode Go**：契約済みワークスペースの個人 API Key を使用します。クォータには 5 時間・週間・月間の残量パーセンテージとリセット時刻が表示され、即時照会やブラウザ稼働中 15 分ごとの自動更新に対応しています。OpenCode Go は公式には主にコーディングクライアント向けであり、翻訳リクエストの可否は接続テストで確認してください。[OpenCode Go 公式説明](https://opencode.ai/docs/console/go/#where-can-i-use-it)
- **deepl / azure-translator / google-translate**：各公式エンドポイントと認証方式を使用。
- **custom-http**：Body テンプレート + レスポンスパスを指定。
- **native-host**：ローカル .NET ゲートウェイ経由で Ollama / HTTP / Whisper へルーティング。プロトコル 1 の旧ゲートウェイでは視覚・ASR 入口が無効化され、例外は投げません。

任意のオプション機能に対応していない Provider では、代替ルートを勝手に使わず、該当 UI 入口をグレーアウトして理由を表示します。

Prompt テンプレート変数：`{{sourceLanguage}} {{targetLanguage}} {{text}} {{texts}} {{domain}} {{glossary}}`。

## エントリポイント

- **PDF**：Popup **「バイリンガルリーダーを開く」**（PDF 検出時に表示）/ 右クリック **「PolyPage でバイリンガルリーダーを開く」** / リンク右クリック；設定で「PDF リンク訪問時に自動で開く」を有効化可能（`webNavigation` 権限が必要）。スキャンページの案内横にある **「このページを認識」** から現在の OCR エンジンで文字認識できます。
- **画像**：画像右クリック **「画像内テキストを翻訳」**、または大きな画像の右上ホバー時 **「画像翻訳」** ボタン。`llm-vision` には視覚対応 Provider が必要；`tesseract-wasm` を使えばテキスト専用モデルでも文字認識後に翻訳可能です。
- **字幕**：`<track>` 付き動画ページで Popup の **「字幕翻訳」** スイッチをオン；もう一度押すと元の字幕へ戻ります。
- **字幕なしメディア**：Popup / 右クリック **「文字起こしして翻訳」**；既定では現在位置から有限ウィンドウのみを取り込み、全体の文字起こしには二次確認が必要です。閉じるとインメモリ cue は破棄されます。マイク権限は要求しません。
- **選択翻訳**：テキスト選択時にフローティングボタンを表示；パネルは読み上げ（`Alt+クリック` で原文読み上げ）、不良訳文マーク、コピーに対応；`Alt+Q` で直前の選択を再実行します。
- **フィードバック**：バイリンガルブロック / 字幕レイヤー / PDF ブロックにホバーして **「不良訳文をマーク」**；Options → **「フィードバックログ」** からエクスポートできます。

## アーキテクチャの要点

- **統一バックグラウンドパイプライン**：Web ページ、PDF、画像 OCR、字幕 cue、ASR 成果物はすべて同一のキュー / バッチ / キャッシュ / フェイルオーバー / エラー分類パイプラインを再利用します。コンテンツスクリプトとビューアーページは API へ一切直接アクセスしません。
- **ユーザー起動優先**：動画全体の自動文字起こしは禁止；画像・スキャンページはユーザー操作にのみ応答します。PDF リーダー起動後のページ単位遅延翻訳はビューポートと同時実行数で制限されます。
- **オリジナルを破壊しない**：PDF ソースファイル、動画ソース、字幕ファイルを改変せず、SRT/VTT への書き戻しも行いません。Web 翻訳の復元はテキスト／マークアップ構造レベルの可逆復元（訳文の装飾と `data-wt-id` の除去）であり、バイト単位の DOM 完全一致ではありません；`inline` モードは `cloneNode` で原文を保持するため、復元時にイベントリスナーやフレームワークバインディングは再接続されません。
- **メッセージプロトコル v6**（`src/messaging/messages.ts`）：旧メッセージも引き続き処理可能です。
- **翻訳再開**：タスク表が進行中の Web / PDF タスクを記録します；ASR は 3.0 の再開表には入らず、タブを閉じると破棄されます。
- **機密情報**：API Key はバックグラウンドまたはローカルゲートウェイのみに保存し、必須権限の追加やマイク権限の要求は行いません。

## 検証

- 通常 CI は Windows 上で `npm ci`、`npm run verify`、`npm run test:contract` を実行します。
- リリース前に GitHub Actions 上で [Browser validation](.github/workflows/browser-validation.yml) を手動実行します。両ジョブがリリース対象コミットで動作することを確認してください：Edge は完全なスモークテストを実行し、Firefox は拡張機能を一時読み込みして同一コミットからビルドされたゲートウェイ経由でローカルスタブ翻訳を完了します。両ジョブとも独立したホストランナー上で動作し、実 Provider、キー、Whisper 重みは不要です。
- ローカルで `npm run smoke` を実行するとテストゲートウェイが一時的に登録・解除されます；完全な Windows ブラウザ検証は上記のホストランナーを優先します。
- 過去のリリース検証と既知のギャップは [4.2 クローズ記録](docs/VALIDATION-4.2.md) を参照してください。

## 既知の制限

- PDF の二段組み / テーブルクラスタリングは依然としてヒューリスティックであり、完璧なレイアウト維持は保証しません；
- 現在 `transcribeStream` を実装した Provider がないため、ASR は文字起こし完了後に一括で字幕を注入します；閉じるとインメモリ cue は破棄され、SRT/VTT へはエクスポートしません；
- DRM または `captureStream` 不可のメディアはエラーを返してファイル全体のダウンロードを拒否します；DRM によって入口を事前に無効化せず、`tabCapture` やマイク権限も要求しません；
- `subtitleSelectors` はルール駆動のためサイト改修時に追従が必要になります（組み込み YouTube ルールはリリースに合わせて更新）；
- tesseract は既定で `eng` + `chi_sim` のみ同梱します；追加言語パックは Options からダウンロード可能です；
- 「訳文のみモード」では段落全体がプレーンテキストに置換されます（対訳／インラインモードではマークアップ構造を維持）；
- closed Shadow DOM の内部へはアクセスできません（ブラウザの制限）；
- Firefox は一時読み込みに対応し、Native Host 不可時はフォールバックします。Safari、モバイル、AMO ストア公開は 4.2 の対象外です。

## 4.3 候補ロードマップ

4.2 のリリース検証を通過した後に下記順序で進めます。以下はすべて今後の実装候補であり、4.2 の提供コミットメントではありません。

| 順序 | 対象 | 受入条件 |
|---|---|---|
| 1 | 実 Whisper 結合テスト | 固定短尺音声、ユーザー導入済みの重み、Windows ゲートウェイを使用；バックエンド・モデルバージョン・コマンドを記録し、実文字起こしでタイムスタンプ・バイリンガル cue・終了後クリーンアップを検証。重みがない場合は未検証と明記し、スタブで代替しない。 |
| 2 | `<audio>` 単体字幕バー | 既存の cue スケジューラを再利用；再生・シーク・終了・ソース切り替えをカバーし、既存の動画字幕にリグレッションがないことを確認。 |
| 3 | SRT エクスポート | ユーザーが明示的に起動した現在の cue のみエクスポート；時刻順・Unicode・書式を検証し、元メディアや元字幕を改変しない。 |
| 4 | PDF 複雑レイアウト | 先に実テーブルと二段組みフィクスチャを整備；セル跨ぎの段落混線を防ぎつつ行単位フォールバックを維持。 |

ストリーミング ASR は実際のバックエンドが `transcribeStream` を提供してから着手し、ユーザー起動・マイク権限不要・拡張機能への Whisper 重み非同梱の制約を維持します。
