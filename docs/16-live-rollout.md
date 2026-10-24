# 16. Live Rollout Runbook（実運用への切替手順・詳細版）

状態: dry-run MVP実装済み（docs/11参照）。本書は **本人が行う手続き（URL付き）** と、その後のAI側作業・切替手順を定義する。

原則（AGENTS.md再掲）: 本人確認・ASP審査・規約同意・口座登録・ドメイン購入・支払設定は**本人手続き**。システムもAIも代行しない。手続き未了の連携は無効のまま（fail-closed）。推測値・未承認案件・UNKNOWNの断定表示は禁止。

所要目安: Phase 0〜2は半日程度の作業 + ASP審査待ち（数日）。Phase 3〜4は審査通過後、1〜2時間。

---

## Phase 0: 本人手続き（URL付きチェックリスト）

### 0-1. 独自ドメイン取得（最初にやる。ASP審査にサイトURLが必須のため）

1. Cloudflareに登録: <https://dash.cloudflare.com/sign-up>
2. ドメイン購入: <https://domains.cloudflare.com/>（例: `example-media.jp`。年払い、Whoisプライバシー標準添付）
3. 以後、`<ドメイン>` を「取得したドメイン」に読み替える。

### 0-2. Cloudflare Pages プロジェクト作成

1. Pages作成: <https://dash.cloudflare.com/> → Workers & Pages → Create → Pages → **Direct Upload** で空プロジェクト作成（プロジェクト名がそのままURL `<name>.pages.dev` になる。独自ドメインは後で Custom domains で接続: <https://developers.cloudflare.com/pages/configuration/custom-domains/>）
2. APIトークン発行: <https://dash.cloudflare.com/profile/api-tokens> → Create Token → テンプレート「Cloudflare Pages — Edit」→ アカウントIDと共に控える
   - アカウントIDの確認: ダッシュボード右側「Account ID」
   - wrangler-actionの仕様: <https://github.com/cloudflare/wrangler-action>
3. この時点で一度デプロイしてサイトを公開状態にする（`.github/workflows/deploy.yml` を使うにはPhase 1のsecrets設定が先。まずローカルから `pnpm --filter site build && npx wrangler pages deploy apps/site/dist --project-name=<name>` でも可）。
   - **ASP審査用に「公開済みサイト」が必要**。index/about/privacy だけの状態で良い（「工事中」は審査却下の典型原因）。

### 0-3. Postgres（どちらか一方）

| 選択肢 | URL | 手順 |
| --- | --- | --- |
| Supabase（無料枠あり） | <https://supabase.com/dashboard> → New project | Project Settings → Database → Connection string → **URI**（Session pooler推奨）をコピー。接続ガイド: <https://supabase.com/docs/guides/database/connecting-to-postgres> |
| Neon（無料枠あり） | <https://console.neon.tech/sign_up> | Project → Connection Details で `postgresql://...` をコピー。<https://neon.com/docs/connect/connection-string> |

コピーした文字列がそのまま `DATABASE_URL`。**パスワード付きURLなので第三者に見せない。**

### 0-4. LLM API（OpenAI互換ならどれでも可）

| 選択肢 | 登録 | APIキー | 料金ページ |
| --- | --- | --- | --- |
| OpenAI | <https://platform.openai.com/signup> | <https://platform.openai.com/api-keys> | <https://openai.com/api/pricing/> |
| OpenRouter（多数のモデルを一つのAPIで） | <https://openrouter.ai/> → Sign in | <https://openrouter.ai/settings/keys> | <https://openrouter.ai/models> |

支払方法登録（クレジット等）と月次上限設定もここで行う（**支払設定は必ず本人操作**）。低コスト運用の目安: 月3万円上限に対し、Fact抽出は1記事あたり数回の呼び出し。

### 0-5. ASP 本人登録（審査は「公開済みの自サイトURL」で申し込む）

> 登録時に聞かれる典型項目: サイトURL・サイト名・サイト概要・掲載方法（記事内リンク等）・氏名・住所・電話番号・振込口座。**すべて本人情報で入力。** サイト概要には「公式一次情報に基づく料金比較メディア」と正直に書く（衣料系・無関係サイトの申告は規約違反）。

| ASP | 新規登録 | ログイン | 利用規約/ポリシー（登録前に必読） | 最低支払額 |
| --- | --- | --- | --- | --- |
| A8.net | <https://media-console.a8.net/signup-mail-send?action=default> | <https://www.a8.net/> | <https://www.a8.net/compliance/media-userpolicy.php> / 禁止事項 <https://www.a8.net/compliance/prohibited-matter.php> / ヘルプ <https://support.a8.net/a8/as/faq/> | 1,000円〜 |
| もしもアフィリエイト | <https://secure.moshimo.com/ac/owner/register/entry/af> | <https://af.moshimo.com/af/shop/login> | <https://af.moshimo.com/af/www/terms/shop> / 違反事例 <https://af.moshimo.com/af/www/about/unfaircase> / PPCガイドライン <https://af.moshimo.com/af/www/about/ppcGuideline> | 1,000円・振込手数料無料 |
| アクセストレード | <https://www.accesstrade.ne.jp/pregist/mail> | <https://member.accesstrade.net/atv3/sp/login.html> | パートナー規約 <https://www.accesstrade.ne.jp/agreement> / 禁止事項 <https://www.accesstrade.ne.jp/rule> / 登録手順FAQ <https://www.accesstrade.ne.jp/faq/detail/531> | 1,000円・振込手数料無料 |
| バリューコマース | <https://www.valuecommerce.com/> トップの「メディア登録」から | 同サイト | 同サイトのメディア規約を確認 | 要確認 |

審査はメディア目視審査（もしもは明言済み）で数日程度が目安。**審査通過後、提携したい広告主プログラムごとに「提携申請」が必要**（ASPアカウントとは別）。

### 0-6. Search Console / GA4（計測。収益化の必須手続きではないが公開直後に使う）

- Search Console: <https://search.google.com/search-console> → ドメインを追加 → DNS TXTレコード認証（Cloudflare DNSに追加）
- GA4: <https://analytics.google.com/> → プロパティ作成 → Webストリームで測定ID取得

---

## Phase 1: GitHub 設定（リポジトリ → Settings → Secrets and variables → Actions）

Secrets（<https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions>）:

| Name | 値 | 出所 |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://...` | Phase 0-3 |
| `LLM_API_KEY` | `sk-...` 等 | Phase 0-4 |
| `LLM_MODEL` | 例 `gpt-5.5-mini` / OpenRouterのモデルID | 同上 |
| `LLM_BASE_URL` | OpenAIなら不要 / OpenRouterは `https://openrouter.ai/api/v1` | 同上 |
| `LLM_INPUT_COST_JPY_PER_1M` | 入力トークン1Mあたりの円建て費用 | 料金ページから換算 |
| `LLM_OUTPUT_COST_JPY_PER_1M` | 出力トークン1Mあたりの円建て費用 | 同上 |
| `CLOUDFLARE_API_TOKEN` | Phase 0-2のトークン | 同上 |
| `CLOUDFLARE_ACCOUNT_ID` | ダッシュボードのAccount ID | 同上 |
| `AFFILIATE_TRACKING_URLS_JSON` | `{"offers":{"<offer_id>":"https://...tracking..."}}` | ASP承認後（Phase 2-4） |

Variables（平文で良いもの）: `SITE_BASE_URL`（例 `https://<ドメイン>`）, `CF_PAGES_PROJECT`（Pagesプロジェクト名）。

## Phase 2: 市場選定・データ投入（AIと協同で可）

1. **robots確認**（allowlist追加の必須前提）:
   ~~~bash
   pnpm tsx apps/worker/src/index.ts check-robots https://<対象公式サイト>/price
   ~~~
   `disallowsAll: false` を確認し、かつ各サイトの利用規約（自動アクセス・データ取得条項）を目視確認する。問題なければ `config/policy.live.yaml` の `allowed_source_domains` へ追記。
2. **オファー台帳**: `config/offers.dry-run.json` と同じ形式で `config/offers.live.json` を作る（ASP管理画面の提携済みプログラムの実値: 案件名・報酬額・成果地点・媒体許可）。投入:
   ~~~bash
   export DATABASE_URL=...   # .envから読み込む等
   pnpm tsx apps/worker/src/index.ts import-offers config/offers.live.json
   ~~~
   `status: "APPROVED"`, `active: true` にした案件だけが収益化CTAに使われる。
3. **SERP観測（B000B）**: 手動で検索（地域=日本/言語=日本語/モバイルを固定）し、上位10件を記録。形式は `SerpObservation`（`packages/domain/src/types.ts`）。無断スクレイピングはしない。検索ボリュームはKeyword Planner等の実測値のみ、取れなければUNKNOWN。
4. **プラン作成**: `config/plans.dry-run.json` と同じ形式で `config/plans.live.json`。数値は全て対象サイトの公式ページから転記（確認日を記録）。

## Phase 3: live初回実行（まだ非公開）

~~~bash
cp config/policy.live.example.yaml config/policy.live.yaml
# → allowed_source_domains に実ドメインを記入（publish_enabled は false のまま）
pnpm tsx apps/worker/src/index.ts run-pipeline --live \
  --policy config/policy.live.yaml --plans config/plans.live.json
~~~

- `publish_enabled=false` でも実行には通るが、**`assertLiveReadiness` が前提（DB/LLM/allowlist/publish flag）を満たさなければ即エラー停止**する。
- 成功すると: research → analysis → draft → QA → `content/articles/*.md` 書込 → git commit（QA不合格ならcommitされない）。
- 確認: `pnpm --filter site build` でビルド → `deploy` workflow（Actions → deploy → Run workflow）でサイト反映。

## Phase 4: 自動公開の有効化

1. `config/policy.live.yaml` の `flags.publish_enabled: true` に変更してコミット。
2. `.github/workflows/pipeline.yml`（毎日02:00 JST）がQA合格分だけ自動commitする。デプロイは `deploy` workflowを手動実行（またはPages Git連携に切り替え）。
3. 緊急停止: `publish_enabled` を `false` に戻す + deployを無効化。記事単位の撤去は `worker refresh`（鮮度切れ/無効Fact検知で UPDATE_CANDIDATE/REVOKED 化）。

## Phase 5: 計測と改善

- ASP成果CSV（管理画面からダウンロード）を日次で `worker import-conversions`。PENDINGは収益に計上されない。
- `worker report --month YYYY-MM` で月次レポート（承認/入金/費用を分離）。
- GSC/GA4実接続はB014 adapterのcredential実装後に有効化（現状モック。実データなしの指標はUNKNOWN）。

---

## システムが自律的に行わないこと（常時）

- ASP等への登録・審査対応・規約同意・支払/口座操作
- ドメイン取得・DNS変更・インフラ契約
- CAPTCHA/認証回避、非公式API・無断スクレイピング
- 高規制ジャンル（金融・医療・法律等）の無人公開
- 月3万円（policy.limits.monthly_operating_cost_jpy）超過後の有料ジョブ実行

## トラブル時の自動挙動（docs/10参照）

- QA不合格 → 修正3回 → REJECTED（隔離）
- ソース取得不可 → 該当claimはUNKNOWN → 記事はFAIL（非公開のまま）
- 予算超過 → 有料ジョブ全停止（STOPPED_BUDGET）
- ビルド失敗 → commitは行われず前版を維持
