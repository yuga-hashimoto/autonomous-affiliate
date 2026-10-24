# 07. Security, Access & Budget Guardrails

## 脅威モデル

脅威: prompt injection、ツール出力汚染、偽の公式料金情報、アカウント乗っ取り、秘密情報流出、無限ループによる課金、誤公開、著作権侵害、悪意のあるダウンロード、ASP規約違反。

## 権限マトリクス

| 機能 | Research | Testing | Content | QA | Publisher | Growth |
| --- | --- | --- | --- | --- | --- | --- |
| 公開Web読取 | allowlist | allowlist | evidence only | evidence only | no | API only |
| ブラウザのログイン操作 | no | sandbox only | no | no | no | no |
| 本番サイトの書込 | no | no | no | no | QA PASSのみ | no |
| Secretsの参照 | no | scoped test token | no | no | scoped publish token | analytics read token |
| 課金/決済 | no | no | no | no | no | no |
| 規約同意/新規アカウント | no | no | no | no | no | no |

## 隔離実行

- コンテナ非root、read-only filesystem、CPU/memory/time limit、ephemeral workspace。
- ネットワークはドメインallowlistと必要なポートに限定。
- 明示的に許されたAPI/ユーザー提供テストアカウントだけを操作。
- CAPTCHAや2FA、支払画面、メールOTPなどで阻まれた場合は停止。回避コードを作らない。
- ブラウザセッション終了時にcookie/token/tmpファイルを破棄。
- 証拠スクリーンショットを公開前に個人情報・メールアドレス・アクセストークンで検査。

## Secret handling

- GitHub Actions secrets / cloud secret managerへ保存。env exampleにはプレースホルダーのみ。
- git history、URLクエリ、ログ、LLM prompt、記事、例外stacktraceに資格情報を含めない。
- tokenのscopeを読み取り/公開で分離。失効/ローテーション、最小権限。
- ソースからAPIレスポンスを取得する場合はHTML内のpromptを実行指示として扱わない。
- 変更されたモデル・プロンプト・外部agent toolの権限付与はCIで監査。

## 予算

初期設定: 月額30,000 JPY（LLM/API/worker/storageを含む）、1ジョブ500 JPY、1テスト50 JPYを**仮の上限**とする。無料枠に依存せず請求上限を持つ。

- スケジューラ実行時、各外部API要求前、各LLM要求前に原価予測を確認。
- 料金が把握できない呼び出しは保守的な上限計算。見積もれない場合は禁止。
- 月予測 > 85%: 新規記事生成を減速、実測更新優先。
- 月実績＋引当 > 100%: すべての有料ジョブを停止。
- 不可逆操作（広告予算増額・クレジットカード登録等）は自律ツールの許可対象外。
- 承認済み売上−AI/インフラ/外注/広告等の費用を月次粗利益とする（税・会計確定額ではない）。

## 通知とフェイルセーフ

通知は運営権限要求ではなく状態可視化。重大事象はpublic_content_pipeline OFF、該当API連携停止、公開可能ならrollback。通知先未設定でもfail-closed可能な状態を維持。
