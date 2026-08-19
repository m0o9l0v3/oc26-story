# OC26 Story Vote

高校生向けオープンキャンパス企画「みんなの投票で物語を作ろう」のリアルタイム投票アプリです。

## 特徴

- 参加者・中央モニター・運営者の3画面
- 一端末一票、締切まで投票変更可能
- SSEによるリアルタイム集計と自動再接続
- 得票率に重み `β` を適用した抽選
- 通信障害時の挙手投票モード
- データベース・外部npmパッケージ不要
- 投票や端末情報を永続保存しない

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

## 画面

- 参加者：`http://localhost:3000/participant`
- 中央表示：`http://localhost:3000/display`
- 運営者：`http://localhost:3000/operator`

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
- Figmaの色・余白・角丸は、`public/styles.css` のCSS変数と同じ名前で管理しています。

## Cloudflare Tunnelで公開

`cloudflared` をインストール済みの運営PCで、アプリを起動したまま次を実行します。

```bash
cloudflared tunnel --url http://localhost:3000
```

表示されたHTTPS URLの末尾に `/participant` を付けて参加者へ案内します。中央表示と運営者画面も同じURLを使用します。

## テスト

```bash
npm test
```

## 物語の差し替え

`src/story-data.js` が物語データです。各候補の `nextNodeId` が、選択後に表示する次の候補グループを指定します。`nextNodeId: null` は物語の終了を表します。

## トークン確率について

`src/story-data.js` の `tokenDemo.candidates[].probability` は、初期状態では `null` です。架空の確率を表示しないため、実際のモデルから取得した確率だけを入力してください。3候補すべてに数値が入った場合だけ、中央モニターへ確率が表示されます。
