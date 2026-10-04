# discord-maint-mcp

Claude Code などの MCP クライアントから、**許可した Discord チャンネルを読む・投稿する**ためのローカル stdio サーバーです。Discord REST API を利用します。

開発中のbotの返事を読んだり、成果物を添付したりするために作りました。単独でも使えます。[communitd](https://github.com/jiro-prog/communitd) と組み合わせると、botのメンションからローカルエージェントに仕事を依頼できます。

## ツール

| ツール | 内容 |
| --- | --- |
| `list_channels` | テキストチャンネル名と、設定上の許可の有無 |
| `list_threads` | 指定した許可チャンネル内のアクティブなスレッド |
| `read_messages` | 許可チャンネルまたは配下スレッドの直近のメッセージ（最大50件、古い順） |
| `post_message` | 本文（最大2000字）とファイル（最大10個）の投稿 |

メッセージの削除・編集、サーバー管理のツールはありません。

## 必要なもの

- Node.js 22以上
- Claude Code、またはローカル stdio に対応する MCP クライアント
- 自分で管理できる Discord サーバーとbot

Windowsで開発・検証しています。自動テストでは偽のDiscordを使います。CIもWindows上で実行します。

## セットアップ

1. [Discord Developer Portal](https://discord.com/developers/applications) でアプリとbotを作ります。Bot設定で **Message Content Intent** を有効にします。
2. 「チャンネルを見る・メッセージを送る・スレッドで送る・履歴を読む・ファイルを添付」を付けて招待します。管理者権限は不要です。`<APP_ID>` はアプリのIDに置き換えます。

   ```text
   https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=274878008320
   ```

3. リポジトリを取得し、依存をインストールします。

   ```bash
   git clone https://github.com/jiro-prog/discord-maint-mcp.git
   cd discord-maint-mcp
   npm ci
   ```

4. `.env.example` を `.env` にコピーします（PowerShellなら `Copy-Item .env.example .env`）。botトークン、サーバーID、許可チャンネル名を入力します。トークンはGitに入れません。
5. Claude Codeに登録します。次の2つのパスを、取得したリポジトリの**絶対パス**に置き換えます。パスに空白がある場合も引用符を残します。

   ```text
   claude mcp add --transport stdio --scope user discord-maint -- node "--env-file=/absolute/path/discord-maint-mcp/.env" "/absolute/path/discord-maint-mcp/src/server.mjs"
   ```

   Windowsなら `/absolute/path/` 部分を `C:/tools/` などの実際の場所にします。登録構文は [Claude Codeの公式ドキュメント](https://code.claude.com/docs/en/mcp) を参照してください。
6. Claude Codeを開き直し、`/mcp` で接続状態を確認します。

他のMCPクライアントでも、同じ `node` コマンドと2つの引数で起動できます。`npm start` はリポジトリ内から手動で起動する場合のコマンドです。

## 設定

| 環境変数 | 内容 |
| --- | --- |
| `DISCORD_MAINT_TOKEN` | botトークン（必須） |
| `DISCORD_GUILD_ID` | サーバーID（必須） |
| `DISCORD_MAINT_CHANNELS` | 許可チャンネル名。`#`なし、カンマ区切り（必須） |
| `DISCORD_MAINT_UPLOAD_ROOTS` | 添付専用フォルダの絶対パス。カンマ区切り。未設定なら添付不可 |
| `DISCORD_MAINT_LOG` | 投稿記録のJSONLファイル。指定した場合のみ記録。絶対パスを推奨 |
| `DISCORD_MAINT_MAX_FILE_MB` | 1ファイルの上限。既定10 MiB。Discord側の制限も適用 |

チャンネル名は一意に解決できる必要があります。同じ名前のチャンネルが複数ある場合は、その名前宛ての読み書きを拒否します。

## 設計と境界

- 読み書き先は許可チャンネルと配下のスレッドに限定します。チャンネル一覧には許可していないチャンネル名も表示します。
- 添付は実体パスで確認し、許可フォルダ外を指すリンクやジャンクションを拒否します。`.env`・`.git`など、ドットで始まる名前を含むパスも拒否します。
- 許可フォルダ内の通常名のファイルは内容を検査しません。アップロード専用の場所を指定してください。PC全体やホームディレクトリを指定する用途には向きません。
- `@everyone` / `@here` は拒否し、ロール通知も無効にします。ユーザーへのメンションは可能です。
- 投稿記録を有効にすると、本文の先頭80字と添付の名前・サイズを保存します。記録を書き込めなくても投稿は継続します。
- botトークンをエラー文から伏せます。Discord本文は他人の指示を含みうるため、読むだけで新たな操作を許可したことにはなりません。

Discordへの本文・添付の送信と、MCPクライアントが読み取った内容をモデルへ渡す処理は、外部サービスを利用します。

## communitd と組み合わせる場合

communitd の `config.secrets.json` に `"maintenanceBotIds": ["<APP_ID>"]` を設定して再起動します。このbotからのメンションは作者の代理として扱われるため、トークンを持つ人はローカルエージェントに仕事を依頼できる立場になります。

## 開発と検証

```bash
npm ci
npm test
```

自動テストは12件です。許可範囲・添付の実体パス・メンション・上限・トークン伏字と、実プロセスに対するMCPのツール一覧取得を検証します。実際のDiscordには接続しません。

`src/policy.mjs` は検証ルール、`src/discord.mjs` はREST API窓口、`src/tools.mjs` はツール処理、`src/server.mjs` はMCP登録を担当します。

## ライセンス

[MIT](LICENSE)
