# Integration review 指摘対応記録

更新日：2026年8月20日

## 判定

レビューで報告された重大3件と中程度6件は、すべて実装および自動試験の対象にした。コード上の60%到達条件は合格とする。現地環境を必要とするQuick Tunnel実地試験と、補助スタッフ2名によるリハーサルは別の運用ゲートとして未実施である。

## 重大指摘

| 指摘 | 原因 | 対応 | 証明する試験 |
| --- | --- | --- | --- |
| 強制停止後に復旧状態を画面が破棄 | ブラウザがrevisionだけで新旧判定し、再起動を識別できなかった | `serverInstanceId`を全状態へ付与し、世代変更時にrevision基準をリセット。参加者Cookieを自動再発行 | `test/recovery.integration.test.js`のSIGKILL復旧試験 |
| 二重運営操作で二段階進行・保存競合 | 運営操作と同一一時ファイルへの保存が並行実行された | サーバー側Promiseキュー、`expectedRevision`、クライアント操作中ガード、保存失敗時ロールバック | `test/server.integration.test.js`の同一revision同時送信試験、`test/readiness.integration.test.js`のロールバック試験 |
| 書き込み不能でもready 200 | 起動時に保存先を検査していなかった | 実際のwrite・fsync・rename・deleteを行うprobeを起動時に実施 | `test/readiness.integration.test.js`の書き込み不能試験 |

## 中程度の指摘

| 指摘 | 対応 |
| --- | --- |
| 破損時の画面警告とready回復なし | 運営画面に復旧警告を表示し、正常保存後にreadyを回復 |
| 本番で開発用PINを明示できる | `NODE_ENV=production`では未設定と`260822`の両方をready 503にする |
| Tunnel配下でPINロック元が共有される | `TRUST_CF_CONNECTING_IP=true`の場合のみ`CF-Connecting-IP`を信頼 |
| Origin欠落を許可 | JSON変更APIでOriginを必須化 |
| 参加者の復旧案内が不足 | `ERR-SSE-01`、再読み込みボタン、予備接続状態を表示 |
| 期限後も既存運営者SSEが継続 | heartbeatごとに認証期限を再確認し、期限切れ接続を終了 |

## 追加の運用リスク

Quick TunnelはSSEを転送しない。全画面に約3秒間隔のHTTPポーリングを追加し、SSEの状態イベントまたはheartbeatを18秒受信できない場合に自動切り替えする。予備接続へ移行した後はEventSourceを閉じ、Quick Tunnelの同時リクエスト上限を圧迫しない。参加台数はSSE接続数と直近15秒の参加者アクセスを統合して数える。

予備接続への切り替え境界と、参加者向けエラー番号・再読み込み導線は `test/connection-policy.test.js` で固定している。

## 残る運用ゲート

1. 現地回線からQuick Tunnelを起動し、参加者・中央表示・運営者・スタッフの4画面で「予備接続中」を確認する。
2. 100台規模でなくても複数実機から投票変更・締切・抽選を一周する。
3. 補助スタッフ2名がクイックガイドだけを見て、再読み込み案内と挙手投票切り替えを実施する。
