# 04. Workflows / 無人実行設計

## Article pipeline — 状態マシン

~~~text
DISCOVERED
  -> ELIGIBILITY_CHECKED
  -> RESEARCHED
  -> ANALYZED
  -> DRAFTED
  -> QA_PENDING
  -> APPROVED_AUTOMATICALLY
  -> DEPLOYING
  -> PUBLISHED
  -> MEASURING
  -> UPDATE_CANDIDATE -> RESEARCHED
~~~

例外状態:
- QUARANTINED: 規約不明・根拠不足・PII・安全性リスク
- RETRY_SCHEDULED: 一時エラー（再試行対象）
- REJECTED: 品質基準未達
- REVOKED: 古い/誤りの記事を自動非公開化した状態
- STOPPED_BUDGET: 予算超過による停止

各遷移は (run_id, entity_id, from, to, policy_version, evidence_ids) をDBに永続記録。再実行時に重複記事や二重配信を作らない。

## Idempotency

job_key = task_kind + target_entity + source_version_or_snapshot + policy_version。
公開: content_hash + destination + language の一意キー。APIリトライで同じ記事を複数公開しない。処理の途中で落ちた場合は最後の永続化checkpointから再開。

## 実行スケジュール（日本時間での目安）

- 02:00 Opportunity + Research（毎日）
- 04:00 Analysis + Content（公式情報の比較・料金試算）
- 07:00 QA + Deploy（合格のみ、最大1新記事/日）
- 12:00 SNS / 動画（承認済み公式APIが存在する場合のみ）
- 20:00 Metrics import + Growth（毎日/週次で集計）

GitHub ActionsのcronはUTCで設定し、厳密な時間は保証されない。スケジューラーは「時刻」ではなく未完了jobを処理するためのトリガー。1実行が長い場合はjob queueを分割。

## リトライ

- 一過性: 最大3回、指数バックオフ＋ジッター。429時はRetry-After優先。
- 恒久的: API権限不足、認証切れ、ToS不許可、品質FAIL、公開契約不明は再試行せず隔離。
- 3回失敗: DEAD_LETTERに入れ、原因分類。サービス設定の変更が必要なら自動停止したまま。
- ワークフロー全体のdeadlineとmax_tokens/max_cost_jpyを必須とする。

## Publication gate（決定論的）

~~~text
can_publish(item) =
  env.publish_enabled
  AND offer.approved
  AND offer.permission_to_publish
  AND article.ad_disclosure_present
  AND article.affiliate_links_all_sponsored
  AND article.claims_all_evidenced
  AND article.derived_prices_have_formula_and_assumptions
  AND article.comparison_units_match
  AND article.has_original_value
  AND article.no_unsupported_experience
  AND article.no_secrets_or_pii
  AND article.links_pass
  AND article.build_pass
  AND article.content_hash == qa.artifact_hash
  AND article.quality_status == PASS
  AND daily_publish_count < policy.max_new_articles_per_day
  AND monthly_projected_cost <= policy.monthly_limit_jpy
~~~

判断不能=FALSE。URLや規約など依存データの取得に失敗した場合はフェイルクローズ。

## 既存記事更新

定期巡回で公式サイトと掲載内容を照合。価格/料率/仕様の変更発見時は公式情報の再取得→再計算→QA→再公開。重大誤りを見つけた場合は即時に当該セクションを除去するかページを非公開化。更新日付は「実際に再検証した内容」に基づく。

## 外部アクション

- 公開・SNS投稿・YouTube投稿は別々のfeature flag、別のアカウント資格情報。
- 公式APIに非対応、権限不足、プラットフォーム投稿規約未確認ならSKIPPED。
- CAPTCHA/2FAの迂回や無断スクレイピングは禁止。ユーザーによる正規の初期認証が要る連携はセットアップ完了まで無効。

## 実機操作の扱い

MVPのワークフローにテスト環境の構築、SaaSへのログイン、操作テストを含めない。公式情報で裏付けできない体験記事はREJECTED。計算式または紹介条件が未確認の場合もFAIL CLOSED。