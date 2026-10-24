# 16. Live Rollout Runbook（実運用への切替手順）

状態: dry-run MVPは実装済み（docs/11参照）。この文書は **実運用を開始するために必要な、本人が行う手続きと、その後のAI側の作業** を定義する。

原則（AGENTS.md再掲）:
- 本人確認・ASP審査・規約同意・口座登録・ドメイン購入・支払設定は **本人手続き**。システムもAIも代行しない。
- 本人手続きが完了していない連携は **無効のまま**。承認済みデータが揃うまで該当機能は停止する（fail-closed）。
- 推測値・未承認案件・UNKNOWN の確定表示は禁止のまま。

---

## Phase 0: 本人手続きチェックリスト（並行可）

| # | 手続き | 内容 | メモ |
| --- | --- | --- | --- |
| 0-1 | ASP本人登録 | A8.net / バリューコマース / アクセストレード / afb 等のアカウント作成・本人確認・口座登録 | サイト審査用にドメイン確定後が効率的 |
| 0-2 | 独自ドメイン取得+DNS | Cloudflare等で取得・管理 | 取得・課金は本人 |
| 0-3 | Cloudflare Pages プロジェクト作成 | Pages project + API token（Pages:Edit権限） | `CF_PAGES_PROJECT` / `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` をGitHub secretsへ |
| 0-4 | Postgres 用意 | Supabase / Neon など。接続文字列を `DATABASE_URL` へ | マイグレーションはworker起動時に自動適用 |
| 0-5 | LLM契約 | OpenAI互換API（OpenAI / OpenRouter 等） | `LLM_API_KEY` / `LLM_MODEL` / `LLM_BASE_URL` / トークン単価(JPY/1M) |
| 0-6 | Search Console / GA4 | ドメインの所有者確認、GA4プロパティ作成 | 実測定の接続はPhase 3以降 |

## Phase 1: リポジトリ設定

1. GitHub secrets: `DATABASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_INPUT_COST_JPY_PER_1M`, `LLM_OUTPUT_COST_JPY_PER_1M`（オプション: `LLM_BASE_URL`）, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`。Variables: `SITE_BASE_URL`, `CF_PAGES_PROJECT`。
2. `pnpm install && pnpm test` が通ることを確認（ローカルでもCIでもsecrets不要）。

## Phase 2: 市場選定（B000A-D、実データ）

1. **候補ドメインの精査**: `pnpm tsx apps/worker/src/index.ts check-robots https://<公式サイト>/price` でrobots.txt確認。取得可否とToS（各サイトの利用規約・自動アクセスに関する条項）を確認し、結果を記録する。
2. **オファー台帳**: ASPで提携承認された案件を `config/offers.live.json`（`config/offers.dry-run.json` と同じ形式）に実値で登録し `worker import-offers config/offers.live.json` で投入。**APPROVED + active=true のみ収益化リンクに使われる。**
3. **SERP観測（B000B）**: 手動観測（検索地域/言語/日時を固定）をJSON化し `worker serp-import` で記録。無断スクレイピングはしない。検索ボリュームはKeyword Planner等の実測のみ。取得できない値はUNKNOWNのまま。
4. **`scoreOpportunity` でランク付け**、docs/15のスコアと根拠カバレッジを確認し、初期実験カテゴリ（≤3）を決定。

## Phase 3: liveポリシー + 初回ライブ実行

1. `config/policy.live.example.yaml` を `config/policy.live.yaml` にコピーし、`security.allowed_source_domains` に Phase 2 で確認済みの実ドメインを記入。
2. `config/plans.live.json`（`plans.dry-run.json` と同じ形式、実ソースURL+実数値はPhase 2のFactから）を作成。
3. 疎通（まだ非公開）:
   ~~~bash
   export $(cat .env | xargs)   # DATABASE_URL / LLM_* を読み込む
   pnpm tsx apps/worker/src/index.ts run-pipeline --live --policy config/policy.live.yaml --plans config/plans.live.json
   ~~~
   - `publish_enabled=false` のままでもライブ実行は **エラーで停止**（assertLiveReadiness）。 Phase 3-4でflipする。
   - live実行は research → analysis → draft → QA → `content/articles/` への書込 + git commit まで行い、QA不合格なら commit しない。
4. コミットされた記事を確認し、`pnpm --filter site build` → `deploy` workflow（手動）でサイトへ反映。

## Phase 4: 自動公開の有効化

1. `policy.live.yaml` の `flags.publish_enabled: true` に変更（コミット）。nightly pipeline がQA合格分を自動commitする。
2. 引き続き禁止のまま: 実機レビュー表現、未承認オファーの収益リンク、 UNKNOWN の断定、予算超過後の有料ジョブ。
3. 公開レート: 1記事/日（policy.limits.new_articles_per_day）。
4. 障害時: `worker refresh` で鮮度切れ記事を UPDATE_CANDIDATE/REVOKED 化 → 再QA後に復帰。緊急停止は publish_enabled を false に戻す + deploy workflow を無効化。

## Phase 5: 計測と改善

- GSC/GA4実接続はB014 adapterの credential 実装後に有効化（現在はモック。実データなしの指標はUNKNOWN表示）。
- ASP成果レポートCSVを `worker import-conversions` で日次取込。PENDINGは収益に計上されない。
- `worker report --month YYYY-MM` で月次レポート（承認/入金/費用を分離、推定は明示）。

---

## システムが自律的に行わないこと（常時）

- ASP等への登録・審査対応・規約同意・支払/口座操作
- ドメイン取得・DNS変更・インフラ契約
- CAPTCHA/認証の回避、非公式API・無断スクレイピング
- 高規制ジャンル（金融・医療・法律等）の無人公開
- 予算上限（月3万円・初期値）を超えた実行

## トラブル時の自動挙動（docs/10参照）

- QA不合格 → 修正3回 → REJECTED（隔離）
- ソース取得不可 → 該当claimはUNKNOWN → 記事はFAIL（非公開のまま）
- 予算超過 → 有料ジョブ全停止（STOPPED_BUDGET）
- ビルド失敗 → commitは行われず前版を維持
