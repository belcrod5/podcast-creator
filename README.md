
# Podcast Creator
テキスト（JSON）からYouTube動画を作成できる無料アプリです。生成AIが書いた台本をそのまま動画化できるため、AIツールとの相性が抜群です。

## できること（最新バージョン）
- テキスト読み上げ
- 字幕の自動生成（SRT）
- キャラクターアニメーション動画（口パク用動画の合成）
- セクション表示
- 動画の差し込み
- 動画/画像の背景挿入
- YouTube へ自動アップロード
- チャプター自動生成（要 Codex）
- 複数チャンネル対応のプリセット
- 再生速度（音声/動画）変更
- 通常動画 / ショート動画対応
- 英語版対応（任意セットアップ）

## 開発の経緯（ざっくり）
Google の NotebookLM（ノートブックLM）で「英語のポッドキャストを自動生成できる」機能が出たのを見て、「日本語版が出るまで待てない」と思い、自分用に作り始めたのがこのプロジェクトです。
- v0.1: テキストから音声を書き出すだけの最小構成。台本はAIに作ってもらう運用。
- v0.2: “掛け合い”が欲しくなり、2話者で対話形式の音声を生成できるように。
- v0.3: 声だけでは物足りず、キャラクター動画を差し込んで口パク・アニメーションに対応。
- 現在: 背景/セクション/字幕/動画合成/YouTube連携などを拡張して今の形になりました。


## 使い方（基本）
機能は多いですが、やることはシンプルです。

- このアプリの「ポッドキャスト作成ルール（プロンプト）」をLLMに渡す
- キャラクターの性格・口調などの設定を加える
- 話したいテーマ等を別ファイルで添付して台本を生成させる
- 生成されたテキストをアプリにコピー&ペーストする

## LLMの所感（個人メモ）
- Gemini は全体的に強く、特に「らしさ」や構成が作りやすい印象
  - 笑いのセンスは Gemini 3.0 Pro より Gemini 2.5 Pro の方が好みだが、当たり外れ（ガチャ感）は強い
- Grok は（Gemini 2.5 登場前は）そこそこ良かったが、当時は長文生成が苦手だった
- ChatGPT（4〜5.2）や Claude は、この用途ではあまり良い結果にならなかった
  - 普段使いは ChatGPT

約1年間使って感じたのは、AIの回答を「読む」のと「番組として聞く」のでは体験がまったく違う、ということです。普段はAIがテキストで答えてくれたものを読んだり、音声にしてもAIと自分の1対1で会話することが多いのですが、このポッドキャスト形式にすると、おとぼけキャラが答えてくれたりして、同じ内容でもまるで別の性格・人格になったように感じられます。驚きや新しい発見が多く、この体験をぜひ味わってほしいです。

## 免責事項 / 利用上の注意
- 本ソフトウェアは個人利用・商用利用を問わず利用できます。YouTube 等での配信・投稿に利用しても問題ありません。
- 本ソフトウェアは現状のまま提供されます。動作保証はありません。
- 本ソフトウェアの導入・利用により発生した、データ損失/設定破損/機器故障/その他いかなる損害についても、作者は責任を負いません。自己責任で利用してください。
- 生成物（音声/動画/字幕/サムネイル等）およびアップロード先（YouTube等）に関する利用規約・各種法令（著作権/肖像権/商標等）の遵守は利用者の責任です。
- AivisSpeech / ImageMagick / FFmpeg / 各AIサービス等、外部ツール・サービスの利用規約/ライセンスも各自で確認してください。
- 本ソフトウェアの利用にあたり、利用者が使用する素材（画像/音源/フォント等）や外部アプリ/サービスの利用規約・ライセンス・著作権について、作者は責任を負いません。各自で確認してください。

## クレジット（任意）
クレジット表記は必須ではありませんが、入れていただけると「ディーゴ・ロドリゲス」と「不破 玄馬」が喜びます。

- オカルト集団クリエイティブ教（@オカルト集団クリエイティブ教）
  - YouTube: [オカルト集団クリエイティブ教](https://www.youtube.com/channel/UCxQqVt4unn_FlGcJ7A-oKOQ)

---

# 起動するための設定
このアプリは現状 macOS のみ対応です。

このアプリは AivisSpeech が必要です。
- インストール先: `/Applications/AivisSpeech.app`
- 事前準備: 合成音声モデルを先にインストールしておく必要があります（手順は AivisSpeech のドキュメントを参照してください）
- API: `http://localhost:10101`（アプリ起動時に自動で起動を試みます）

このアプリは ImageMagick（`magick` / `convert`）が必要です。macOS では Homebrew を使って入れてください。
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install imagemagick
```

このアプリは FFmpeg / ffprobe が必要です。macOS では Homebrew で入れてください。
```bash
brew install ffmpeg
```


# インストール

## アプリのダウンロード
[podcastcreator.zip](https://github.com/belcrod5/podcast-creator/releases/latest)
ダウンロードしたファイルを **Applications** フォルダ配下に配置します。

## サンプルアセットのダウンロード
[Sample.zip](https://github.com/belcrod5/podcast-creator/releases/download/sample-1.0.0/Sample.zip)
サンプルアセットの圧縮ファイルを、お好きな場所に展開してください。

## アプリの起動
起動後、「作業ディレクトリの指定」が表示されたら、先ほど展開したサンプルディレクトリを選択します。

### 作業ディレクトリについて（重要）
- 素材や設定は「作業ディレクトリ」側に置きます。
- 作業ディレクトリ構成（例）
  - `config/`: 設定（YouTubeの `credentials.json` / `youtube-token*.json` など）
  - 素材置き場（作業ディレクトリ直下）
    - `data/`: プリセット/サンプルなどのJSON
    - `backgrounds/`: BGM(.mp3) / イントロ背景動画(.mp4/.mov/.mkv/.avi)
    - `speaker-videos/`: スピーカー動画（例: `<speakerId>.mp4`, `<speakerId>_<mood>.mp4`）
    - `se/`: SE素材
    - `fonts/`: フォント（任意。なければシステムフォントにフォールバック）
  - `/.podcast-creator/`: セーブデータ・内部キャッシュ
- 作業ディレクトリは、アプリ内の **「設定」→「変更…」** からいつでも切り替えできます。

## CLIで動画生成（ヘッドレス）
UIを起動せず、JSON入力で動画生成〜YouTubeアップロードまで実行できます。

### 実行方法
**`.app` から実行（推奨）**
```
/Applications/Podcast\ Creator.app/Contents/MacOS/Podcast\ Creator \
  --podcast /path/to/podcast.json \
  --workdir /path/to/workdir
```

**Node で実行（開発向け）**
```
node electron/cli/podcast-runner.js --podcast /path/to/podcast.json --workdir /path/to/workdir
```

**直前のセーブデータから再実行**
```
/Applications/Podcast\ Creator.app/Contents/MacOS/Podcast\ Creator \
  --resume latest \
  --workdir /path/to/workdir
```
または特定ファイル:
```
node electron/cli/podcast-runner.js \
  --resume /path/to/workdir/.podcast-creator/saves/<save-id>.podcast-save.json \
  --workdir /path/to/workdir
```

### podcast.json 例
```
{
  "preset": "preset1",
  "script": [
    { "text": "こんにちは", "id": "speaker_001" },
    { "insert_video": "videos/clip.mp4", "startTime": "00:00:05", "endTime": "00:00:10" }
  ],
  "youtube": {
    "title": "Episode 1",
    "description": "本文",
    "tags": ["tag1", "tag2"],
    "category": "22",
    "thumbnailPath": "assets/thumbs/ep1.jpg"
  },
  "insertVideoMapping": "videos/output.mp4.json"
}
```

### 仕様の要点
- `preset` / `script` / `youtube` は必須。
- `youtube.thumbnailPath` は **任意**（未指定でもOK）。
- `preset` は `data/podcastcreator-preset.json` の **ID** を指定。
- `script` の話者IDは `preset.lang` に応じて検証されます（無効IDはエラー）。
- `fixedDescription` は `preset.fixedDescription` → `youtube.fixedDescription` の順で `youtube.description` に追記。
- `insertVideoMapping` は任意。未指定時は `videos/output.mp4.json` を探し、無ければ警告のみでスキップ。
- CLIは `processing-complete` まで待機し、成功時は exit code 0 / 失敗時は 1。
- GUI/CLIどちらの実行でも、実行内容は `<workdir>/.podcast-creator/saves/` にセーブされます。
- `--resume latest` で最新セーブを再実行できます。

※ UIと同じ生成パイプラインを使うため、AivisSpeech / ImageMagick / FFmpeg のセットアップはGUIと同様に必要です。


## フォント（任意・おすすめ）

`fonts/` にフォント（.ttf）を置くと、字幕・見出しの字形が安定して読みやすくなり、太字やデザイン文字も効くので **動画内テキストの見栄えがリッチ** になります。

### 1) Google Fonts からフォントをダウンロード

以下の2つを入れる想定です。

* `NotoSansJP-Black.ttf`（太めの日本語用）
* `ReggaeOne-Regular.ttf`（タイトル/アクセント用）

手順（どちらも同じ）：

1. Google Fonts でフォントを開く
2. 右上の **「Get font」→「Download all」**（または **「Download family」**）で zip をダウンロード
3. zip を解凍し、フォントファイル（.ttf）を取り出す

※ `Noto Sans JP` は zip 内に `static/` フォルダがあり、そこに `NotoSansJP-Black.ttf` などが入っています。
※ `Reggae One` のファイル名は `ReggaeOne-Regular.ttf` です。

### 2) 作業ディレクトリに配置

作業ディレクトリに `fonts/` を作って、以下のように置きます。

* note: `fonts/` が無い場合は作成してください

```
<作業ディレクトリ>/
  fonts/
    NotoSansJP-Black.ttf
    ReggaeOne-Regular.ttf
```
配置後、アプリを再起動（または作業ディレクトリを再選択）すると反映されます。



# サンプルでやってみましょう
まずはサンプルをペーストして動画を作成してみましょう。
（AivisSpeechで「にせ」「亜空マオ」のダウンロードしておく必要があります。※音声の利用は自己責任でお願いします）
- 以下のJSONをコピー
- Podcast Creatorを起動
  - JSONをペースト
  - キューに追加
  - 開始
しばらく待つとファイルが完成して自動的にFinderに表示されます
```json
  {
  "script": [
    {
      "section": "オープニング",
      "se": "sample_se.mp3"
    },
    {"id": "1937616896", "text": "皆さん、こんにちは！ "},
    {"id": "532977856", "text": "よろしくお願いいたします！"},
    {"id": "1937616896", "text": "コールアウト機能テスト ", "callout": "コールアウトテスト"},
    {"id": "532977856", "text": "心の声テスト{{心の声です}} "},
    {"id": "1937616896", "text": "さようなら！"}
  ],
  "youtube": {
    "title": "サンプルポッドキャスト",
    "description": "これはサンプルポッドキャストです\nここにYoutubeの説明が入ります",
    "tags": "SpaceX, Mars, Tesla Autopilot, テック, 経済, ポッドキャスト",
    "category": "25"
  }
}
```

- id は音声合成モデルの idです。idの調べ方は Podcast Creator「話者一覧」から確認できます
- 動画挿入は {"insert_video": "{ファイルパス}", "startTime": "01:00", "endTime": "02:00"}
- 会話の途中に画像や動画の背景を追加するのはJSONペーストした後の会話の横にある「ペースト」に画像URLを貼り付けるか、ファイルをドラッグ＆ドロップします


より詳しいサンプル以下を参照してください
- [サンプル解説](./samples/サンプル解説.md)


# Youtube自動アップロード
## GCP 側の設定（credentials.json の作成）
1) Google Cloud Console でプロジェクト作成
2) APIs & Services → Library で「YouTube Data API v3」を有効化 :contentReference[oaicite:1]{index=1}
3) OAuth 同意画面（OAuth consent screen / Branding）を設定
   - 公開前のローカル利用なら「Testing」にして、自分のGoogleアカウントをテストユーザーに追加
4) APIs & Services → Credentials → Create credentials → OAuth client ID
   - ローカル実行（CLI/デスクトップ用途）: 「Desktop app」推奨（JSON のトップキーが `installed` になる）
   - Webアプリ/ローカルサーバ: 「Web application」＋ redirect URI に例: `http://localhost:8080` を登録 :contentReference[oaicite:2]{index=2}
5) 作成した OAuth クライアントの JSON をダウンロードし、
   `<作業ディレクトリ>/config/youtube/credentials.json` に配置（必要ならファイル名を credentials.json にリネーム） :contentReference[oaicite:3]{index=3}
   - トークン（`youtube-token*.json`）も同じディレクトリに保存されます

## （任意）YouTubeチャプター自動生成
YouTubeへアップロードする場合、字幕(SRT)からチャプターを生成して説明文に追記できます。
この機能を使う場合は `git` と `codex` コマンドが必要です（なくてもアップロード自体は動作します）。



# 開発者向け
Node.js が必要です。

## ローカル設定ファイル
- YouTube:
  - 認証情報: `<作業ディレクトリ>/config/youtube/credentials.json`
  - トークン: `<作業ディレクトリ>/config/youtube/youtube-token*.json`

## （任意）英語TTS（Coqui TTS）
英語話者を使う場合は `tools/tts-en/` の Python 環境（`.venv`）が必要です。
```bash
cd tools/tts-en
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```
モデルDL先: `~/Library/Application Support/tts/`


## 起動（ホットリロード付き）
```bash
npm run dev
```

## ビルド（配布用）
```bash
npm run package:mac
```
※ `package:mac` は `sips` / `iconutil` を使って icns を生成します（macOSのみ）

## ディレクトリ構成
- `electron/`: Electron（main / preload / tts-service 等）
- `src/`: React（renderer）
