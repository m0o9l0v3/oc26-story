# OC26 Story Vote

高校生向けオープンキャンパス企画「みんなの投票で物語を作ろう」のリアルタイム投票アプリです。

## 特徴

- 参加者・中央モニター・運営者・スタッフ支援の4画面
- 一端末一票、締切まで投票変更可能
- HttpOnly Cookieによる匿名参加者・運営者セッション
- SSEによるリアルタイム集計と、HTTPポーリングによる予備接続
- 再起動時の進行状態復元と1世代バックアップ
- 得票率に重み `β` を適用した抽選
- 通信障害時の挙手投票モード
- データベース・外部npmパッケージ不要
- 個別の投票や端末情報を永続保存しない

## 必要環境

- Node.js 20以上
- モダンブラウザ（Chrome、Edge、Safariなど）

## 起動

```bash
OPERATOR_PIN=任意の数字 npm start
```

Windows PowerShellの場合：

```powershell
$env:OPERATOR_PIN="任意の数字"
npm start
```

PINを指定しない場合は、開発用の `260822` が使用されます。本番公開時は必ず変更してください。
`NODE_ENV=production` でPINが未設定または開発用PINのままの場合、ready確認は失敗します。

## 画面

- 参加者：`http://localhost:3000/participant`
- 中央表示：`http://localhost:3000/display`
- 運営者：`http://localhost:3000/operator`
- スタッフ支援：`http://localhost:3000/support`

## 操作順

1. 運営者画面でPINを入力
2. 「開始」→「次へ」→「次へ」
3. 「投票開始」
4. 参加者が投票
5. 「投票締切」
6. 必要に応じて `β` を変更
7. 「抽選実行」
8. 「次のラウンドへ」
9. 第4ラウンドまで繰り返す

## デザイン

- [Figma：参加者画面](https://www.figma.com/design/GgAtss1Qwq7DjVKNWufUD8/無題?node-id=10-2&m=dev)
- [Figma：運営者画面](https://www.figma.com/design/GgAtss1Qwq7DjVKNWufUD8/無題?node-id=25-17&m=dev)
- Figmaの色・余白・角丸は、`public/styles.css` のCSS変数と同じ名前で管理しています。

## 開発計画

- [バックエンド開発計画](docs/backend-development-plan.md)
- [セキュリティ・障害復旧 60%到達実装計画](docs/security-recovery-60-plan.md)

## Cloudflare Tunnelで公開

`cloudflared` をインストール済みの運営PCで、アプリを起動したまま次を実行します。

```bash
cloudflared tunnel --url http://localhost:3000
```

表示されたHTTPS URLの末尾に `/participant` を付けて参加者へ案内します。中央表示と運営者画面も同じURLを使用します。
Cloudflareが付与する接続元IP単位でPIN試行制限を行う場合は、アプリ起動時に `TRUST_CF_CONNECTING_IP=true` を指定します。直接インターネットへ公開する構成では有効にしないでください。

Quick TunnelはSSEを転送しないため、アプリは約3秒間隔のHTTPポーリングへ自動的に切り替わります。画面に「予備接続中」と表示されていれば投票を継続できます。固定URLと即時更新が必要な本番運用では、管理下のドメインを使ったNamed Tunnelを推奨します。

## テスト

```bash
npm test
```

100台相当のSSE接続試験：

```bash
npm run test:load
```

Quick Tunnel用の予備ポーリング100台相当試験：

```bash
npm run test:load:poll
```

## 障害復旧

- 進行フェーズ、物語履歴、β、投票方式は `DATA_DIR` に原子的に保存されます。
- 投票途中で再起動した場合は、そのラウンドを投票準備へ戻して再投票します。
- 個別票は保存しません。
- live確認：`/health/live`
- ready確認：`/health/ready`
- [補助スタッフ用クイックガイド](docs/staff-quick-guide.md)
- [当日運用手順](docs/event-day-runbook.md)

## 物語の差し替え

`src/story-data.js` が物語データです。各候補の `nextNodeId` が、選択後に表示する次の候補グループを指定します。`nextNodeId: null` は物語の終了を表します。

## トークン確率について

`src/story-data.js` の `tokenDemo.candidates[].probability` は、初期状態では `null` です。架空の確率を表示しないため、実際のモデルから取得した確率だけを入力してください。3候補すべてに数値が入った場合だけ、中央モニターへ確率が表示されます。
