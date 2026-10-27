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

公開済み（PUBLISHED / MEASURING / UPDATE_CANDIDATE）の記事を新規記事パイプライン（`runArticlePipeline`）は一切触らない。置き換えは下記「既存記事更新」の更新パスだけが行う。REVOKEDも自動では戻さない。`PUBLISHED -> UPDATE_CANDIDATE` の直接遷移はなく、必ず `PUBLISHED -> MEASURING -> UPDATE_CANDIDATE` を記録する。

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
  AND daily_publish_count < policy.max_new_articles_per_day   -- 新規記事のみ。更新は数えない（下記）
  AND monthly_projected_cost <= policy.monthly_limit_jpy
~~~

判断不能=FALSE。URLや規約など依存データの取得に失敗した場合はフェイルクローズ。

## 既存記事更新

公開済みの記事を再調査して置き換える決定論的・冪等・fail-closedの経路（`packages/agents/src/update.ts`）。重大誤り（INVALID Fact）は即時にREVOKED化する（`refresh.ts`）。更新日付は「実際に再検証した内容」に基づく。

### 起動条件（2種類）

| トリガー | 条件 | 起動元 |
| --- | --- | --- |
| stale | 記事の根拠Factが失効し、鮮度巡回が `UPDATE_CANDIDATE` にした（価格は `price_source_max_age_days: 7`） | 毎日の `live-pipeline` が実行の最初に鮮度巡回（`refreshSweep`）を行う |
| template | 記事生成側を改善した（図の追加など）ので公開済み記事を作り直したい | `live-pipeline` を手動実行し入力 `template_revision` に名前を渡す（CLI: `--template-revision <名前>`） |

鮮度巡回は公開中のリビジョン（`currentRevision`）の出典から失効を判定する。公開に至らなかった候補は判定に影響しない。

### 流れ

~~~text
UPDATE_CANDIDATE（templateならPUBLISHED -> MEASURING -> UPDATE_CANDIDATE を記録してから）
  1. 予算ゲート（月次上限超過なら何もしない）
  2. 計画の公式ページを全て再取得。1つでも取得不可なら中止（LLMを呼ばない）
  3. Fact抽出 -> 分析 -> 原稿 -> QA。原稿とQAは「この回に取得した出典とFact」だけを見る
     （古いスナップショットの価格Factで計画の金額が通ってしまうことを防ぐ）
  4. QA PASS かつ 公開ゲート通過 -> ファイルを書く -> サイトビルド -> `update: <slug> (<revision>)` でcommit
  5. 成功後に初めて currentRevision と状態を進める
     UPDATE_CANDIDATE -> RESEARCHED -> ANALYZED -> DRAFTED -> QA_PENDING -> APPROVED_AUTOMATICALLY -> DEPLOYING -> PUBLISHED
~~~

状態は「公開記事が実際に入れ替わった時」だけ動く。失敗時は状態を動かさず UPDATE_CANDIDATE のまま、前版が公開され続ける。UNKNOWNは公開しない。

### fail-closed（前版を維持）

| 失敗 | 結果 |
| --- | --- |
| 予算超過 / 公式ページ取得不可 / 抽出（LLM）失敗 / 原稿棄却 | `kept_previous`。ファイル・commitは変わらない |
| QA FAIL/UNKNOWN（計画の金額が新しいページと一致しない等） | `kept_previous`。失敗チェックは結果JSONと監査ログに残る |
| 公開ゲート拒否（収益リンク条件・予算等）/ ビルド失敗 / commit失敗 | `kept_previous`。書き込んだファイルは直前の内容に戻す（無ければ削除） |
| INVALID Fact | 鮮度巡回がREVOKEDにする。更新パスはREVOKED記事を戻さない |
| `publish_enabled: false` | `previewed`。プレビュー先にだけ書き、状態・job・リビジョンは変えない |

計画の金額は設定（`LIVE_PLANS_JSON`）の入力でありFactから自動更新されない。ページの価格が変わると新しいFactと計画が一致せずQAが落ち、前版が残る。計画の数字を直して新しい `template_revision` で再実行する。

### 冪等性（job key）

`update|<slug>|<locale>|<サイクル>|<policy.version>`。サイクルは stale なら `stale:<公開中リビジョンID>`、template なら `template:<名前>`。

- 同じ名前のtemplateを繰り返し起動しても2回目以降は `already_completed` で何もしない。新しい名前は新しいサイクルとして実行される。
- 成功したサイクルは `SUCCEEDED`。失敗したサイクルは `RETRY_SCHEDULED`（12時間後以降に再実行可）。同日の再起動は `retry_not_due`、翌日の定期実行が再試行する。`task_retry_attempts`（3）回失敗で `DEAD_LETTER` となり、以後支出しない。staleサイクルがDEAD_LETTERでも記事は UPDATE_CANDIDATE のまま。計画を直して新しい `template_revision` を使えば再開できる。
- `RUNNING` のまま残ったjobは `max_job_duration_seconds` 経過後にだけ引き継ぐ。実行中のjobは `in_progress` として二重起動しない。

### 日次上限

`limits.new_articles_per_day` は新規記事だけを数える（`publications.countOnDay` は「その日に初めて成功公開された記事の数」）。更新は数えず、更新が新規記事の枠を消費することも、更新が上限で止まることもない。更新を抑えるのは、サイクル単位の冪等性、月次予算、1件あたりの費用上限、再試行上限。

### 確認

- 結果JSONの各記事に `action`（pipeline / update）と `update.outcome`（updated / previewed / kept_previous / skipped）が出る。`live-pipeline` のジョブサマリーにも表で出る。
- 非公開の確認: `live-preview` workflowの入力 `update_path` を有効にする、または `run-pipeline --live --preview --preview-update`。新規プレビューの後に更新パスを走らせ、再生成した原稿（図を含む）とQA結果を示す。

## 外部アクション

- 公開・SNS投稿・YouTube投稿は別々のfeature flag、別のアカウント資格情報。
- 公式APIに非対応、権限不足、プラットフォーム投稿規約未確認ならSKIPPED。
- CAPTCHA/2FAの迂回や無断スクレイピングは禁止。ユーザーによる正規の初期認証が要る連携はセットアップ完了まで無効。

## 実機操作の扱い

MVPのワークフローにテスト環境の構築、SaaSへのログイン、操作テストを含めない。公式情報で裏付けできない体験記事はREJECTED。計算式または紹介条件が未確認の場合もFAIL CLOSED。