# 05. Data Model / PostgreSQL論理設計

MVPから監査可能なDBを採用。テーブル名・型は設計上の提案。すべてcreated_at/updated_at、参照整合性、必要なuniqueness、マイグレーションを用意。

## テーブル

| テーブル | 主要カラム | 用途 |
| --- | --- | --- |
| affiliate_programs | id, provider, status, terms_url, terms_checked_at, payout_currency | 契約・許可状況 |
| affiliate_offers | id, program_id, title, landing_url, tracking_url_secret_ref, reward_model, constraints_json, active | 紹介対象と条件 |
| opportunities | id, keyword, intent, audience, priority, source_ids, status | コンテンツ候補 |
| sources | id, canonical_url, source_type, fetched_at, hash, provenance | 一次情報 |
| claims | id, text, claim_type, last_verified_at, source_ids, confidence, verification_status | 記事に載せる主張 |
| test_scenarios | id, service_id, script_ref, env_spec, max_cost_jpy | 実機検証 |
| test_runs | id, scenario_id, status, started_at, finished_at, result_json, evidence_ids | 実行証跡 |
| evidence | id, type, object_key, checksum, redaction_status, retention_until | 検証資料 |
| content_items | id, slug, locale, topic, state, current_revision, offer_id | 記事の主体 |
| content_revisions | id, item_id, content_hash, markdown_path, qa_report_id, published_at, source_ids | 更新履歴 |
| qa_reports | id, item_id, artifact_hash, policy_version, status, checks_json | 公開品質判定 |
| job_runs | id, job_key UNIQUE, job_type, state, attempt, checkpoint, trace_id, cost_jpy | ジョブ管理 |
| publications | id, item_id, revision_id, destination, public_url, commit_sha, status | 公開の冪等性 |
| outbound_clicks_daily | date, page_id, offer_id, cta_id, channel, clicks | 自社CTR集計 |
| traffic_daily | date, page_id, channel, sessions, search_clicks, impressions | セッション/検索 |
| conversions | id, program_id, external_event_id, offer_id, occurred_at, status, amount, currency, amount_jpy | ASP成果 |
| payouts | id, program_id, paid_at, currency, amount, amount_jpy, reference | 入金 |
| spend_daily | date, category, provider, cost_jpy, source, estimated | 原価・見積費用 |
| agent_events | id, run_id, agent, event_type, payload_redacted, timestamp | 監査ログ |
| policy_versions | version, checksum, active_from, policy_json | 運用ルール |

## 主要制約

- conversions: UNIQUE(program_id, external_event_id)（外部イベントIDを取得できる場合）。取得できない連携は取り込みごとに重複排除ルールを別定義。
- content_items.slug + locale: UNIQUE。
- publications: UNIQUE(revision_id, destination)。
- evidence.object_key: 非公開。URL直書きではなく期限付き参照。ログには鍵とトークンを残さない。
- affiliate_offers: 紹介URLと報酬額はDB側に管理、記事内にはoffer_id参照。期限切れ・非承認ならリンク出力しない。
- tracking_url_secret_refはSecret Managerへの参照。紹介URL内の秘匿パラメータを分析ログに書かない。
- email/個人識別データは最小化。原則サイトのクリック計測に個別利用者追跡を不要とする。

## ASP状態と金額の定義

conversions.status:
PENDING -> APPROVED | REJECTED | CANCELED
APPROVED -> PAID（支払データと突合できる場合）
APPROVEDとPAIDは異なる。推定報酬と未承認成果は確定売上KPIに入れない。為替換算日時・レート出典を保持し、税務上の円換算と運営ダッシュボードの円換算は区別する。

## コンテンツの根拠追跡

記事の主張ごとにclaim_id。claims -> sources/evidence -> content_revisionの多対多関連テーブルを実装。料金・キャンペーン・規約など時間依存情報には有効期限と再検証日時。重要なclaimに裏付けがないとQA不合格。

## Jobイベント例

~~~json
{
  "event_type": "qa.decision",
  "run_id": "uuid",
  "content_item_id": "uuid",
  "artifact_hash": "sha256:...",
  "policy_version": "v1",
  "decision": "FAIL",
  "reasons": ["missing_primary_source", "offer_not_approved"],
  "cost_jpy": 3.1,
  "timestamp": "ISO-8601"
}
~~~

## 計測上の注意

ASP側にclick/conversionの個別紐付けがない場合、ページ別の収益を確定的に割り当てられない。できる限り各ASPの許容するsub_idを使う。不可ならページ別収益はUNKNOWNとし、推定アトリビューションを別指標にする。GA4, GSC, ASPレポートの数値が完全一致するとは限らない。
