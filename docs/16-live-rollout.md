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

### 0-4. LLM（3方式から選択。切替は `LLM_PROVIDER` で行う）

| 方式 | `LLM_PROVIDER` | 登録URL | 必須env | コスト計上 |
| --- | --- | --- | --- | --- |
| **OpenAI互換API（推奨）** | `openai-compatible`（既定） | OpenAI <https://platform.openai.com/signup> / OpenRouter <https://openrouter.ai/> / **Z.ai(GLM)** <https://z.ai/model-api> | `LLM_API_KEY` `LLM_MODEL` `LLM_BASE_URL` `LLM_INPUT_COST_JPY_PER_1M` `LLM_OUTPUT_COST_JPY_PER_1M` | Standard APIは従量課金、Coding Plan endpointはポイント枠 |
| ローカルCLI（opencode / Claude Code / Antigravityのサブスク） | `cli` | 各CLIの既存ログイン | `LLM_CLI_COMMAND`（例 `opencode`） `LLM_CLI_ARGS`（例 `["run","-m","zai-coding-plan/glm-5.2","{{PROMPT}}"]`、または `LLM_CLI_STDIN=1`） `LLM_CLI_COST_JPY_PER_CALL`（**必須**。保守的な1呼当り割当額） | 固定割当（サブスクのためトークン単価なし） |
| （開発時）モック | — | — | — | 0円（live実行不可） |

- **推奨はOpenAI互換API**。Z.ai公式資料: Standard API Base URL `https://api.z.ai/api/paas/v4`、API key <https://z.ai/manage-apikey/apikey-list>、Billing/使用枠 <https://z.ai/manage-apikey/billing>。GLM Coding PlanのAPI keyは **Personal Coding Plan** タブから別途作成し、専用Base URL `https://api.z.ai/api/coding/paas/v4` を使う（<https://docs.z.ai/guides/llm/glm-5.3>）。当環境はPersonal Coding Plan key + `glm-5.3-flash`で手動LLM smoke成功（GitHub Actions run 40260429078）。Standard API keyは残高なしで1113になったため使用していない。APIの使用枠購入/入金は本人操作。
- `LLM_INPUT_COST_JPY_PER_1M=30` / `LLM_OUTPUT_COST_JPY_PER_1M=100` は公式Standard API単価を200円/USDで換算した**保守的な内部計上値**。Coding Planでは外部請求額ではなく、予算台帳用の参考原価。実際の利用上限は契約プランのポイント/Quotaで別途監視。
- CLI方式は「サブスク料だけで回したい」場合の予備経路。1呼出ごとにCLIプロセスを起動するため遅く、出力はJSON抽出＋スキーマ検証で保証する（マーカー付きコードブロックや前後の文章は自動で剥がす）。
- どちらの方式でも**費用の見積れない呼出しは禁止**（policy docs/07）。CLI方式は1呼当りの割当額を必ず設定する。
- 支払方法登録・月次上限設定は **必ず本人操作**。

### 現在のセットアップ状況（2026-10-26）

- サイト: `https://sougakuhikaku.com` 公開中（Cloudflare Pages、5ページ）。GitHub Actionsの `deploy` workflow成功確認済み。
- DB: Neon project作成済み、`DATABASE_URL` GitHub Secret登録済み、migration `001_init.sql` を適用済み。
- LLM: Z.ai **Personal Coding Plan** API keyを `LLM_API_KEY` secretに登録。GitHub Actions smoke成功（GLM-5.3-Flash、JSON応答、workflow run 40260429078）。Standard API keyは残高不足、無料モデルは過負荷で使わず、Coding Plan endpointへ切替済み。
- Cloudflare: Pages-only edit tokenをSecret登録済み。Pages project/account/SITE_BASE_URL variables設定済み。
- 配信: `deploy` workflowは、mainのCIが成功すると（そのコミットを）自動でCloudflare Pagesへ配信する。手動実行（workflow_dispatch）も可。`live-pipeline` はGITHUB_TOKENでpushするためCIが起動せず、自分でデプロイする（二重配信なし）。
- 日次ジョブ: `pipeline`（ドライラン、プレビュー成果物のみ・公開なし）は毎日02:17 JSTに実行（GitHubは毎時0分の定期実行を遅延/欠落させるため0分を避けた。変更前の `0 17` では実行記録が1件もなかった）。この変更後の初回定期実行は未確認。
- 安全: `LIVE_AUTOMATION_ENABLED=false`。`LIVE_POLICY_YAML` / `LIVE_PLANS_JSON` / `AFFILIATE_TRACKING_URLS_JSON` は未設定のため、ライブ自動公開は開始していない。
- A8.net: `sougakuhikaku.com` サブサイト登録済み。広告主プログラムへの提携申請・承認は未実施。確認した引越し侍案件は公開後URL提出が必要で、公式自動化経路未確認のため自動運用候補として保留。

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
| `LLM_API_KEY` | API key（Z.ai/OpenAI互換） | Phase 0-4（API方式のみ） |
| `CLOUDFLARE_API_TOKEN` | Phase 0-2のトークン | 同上 |
| `AFFILIATE_TRACKING_URLS_JSON` | `{"offers":{"<offer_id>":"https://...tracking..."}}` | ASP承認後（Phase 2-4） |
| `LIVE_POLICY_YAML` | `config/policy.live.yaml` の内容（publish_enabled含む） | Phase 4。コード/履歴に入れずSecretで保管 |
| `LIVE_PLANS_JSON` | `config/plans.live.json` の内容 | Phase 4。コード/履歴に入れずSecretで保管 |

Variables（平文でよい値）: `SITE_BASE_URL`（例 `https://sougakuhikaku.com`）, `CF_PAGES_PROJECT`（Pagesプロジェクト名）, `CLOUDFLARE_ACCOUNT_ID`, `LLM_PROVIDER`（`openai-compatible`）, `LLM_BASE_URL`, `LLM_MODEL`, `LLM_INPUT_COST_JPY_PER_1M`, `LLM_OUTPUT_COST_JPY_PER_1M`, `LIVE_AUTOMATION_ENABLED`（最後まで`false`のまま）。

CLI方式のローカル手動実行時のみ: `.env`（gitignore済み）へ `LLM_PROVIDER=cli`, `LLM_CLI_COMMAND=opencode`, `LLM_CLI_ARGS=["run","--pure","-m","opencode-go/glm-5.3-flash","{{PROMPT}}"]`, `LLM_CLI_COST_JPY_PER_CALL=20` を設定。GitHub-hosted runnerではローカルCLIログインが使えないため、scheduled automationにはAPI方式を使う。

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
   プログラム規約に「掲載後URL提出」等の継続的な手動作業がある場合、公式API/自動化経路が確認できるまでそのオファーは自動運用対象にしない（例: A8引越し侍プログラムはURL提出要件の自動化手段が未確認、docs/research参照）。
3. **SERP観測（B000B）**: 手動で検索（地域=日本/言語=日本語/モバイルを固定）し、上位10件を記録。形式は `SerpObservation`（`packages/domain/src/types.ts`）。無断スクレイピングはしない。検索ボリュームはKeyword Planner等の実測値のみ、取れなければUNKNOWN。
4. **プラン作成**: `config/plans.dry-run.json` と同じ形式で `config/plans.live.json`。数値は全て対象サイトの公式ページから転記（確認日を記録）。

## Phase 3の前段: 非公開プレビュー（DB・公開なし）

実ページ・実LLMで、計画がQAを通るかを確認する。DB、git、デプロイには触れず、公開は強制的にオフになる（ポリシーの `publish_enabled` に関係なく）。

- GitHub Actions: `live-preview` workflow（手動実行）。本番と同じLLM経路で動く。結果はジョブのサマリーとartifactに出る。
- ローカル: `pnpm tsx apps/worker/src/index.ts run-pipeline --live --preview --policy config/policy.live-preview.yaml --plans config/plans.live-preview.json`（LLMは `LLM_PROVIDER=cli` のopencode等。遅い経路では `LLM_EXTRACT_TIMEOUT_MS` を上げる）。
- 本番のDBでプレビューを実行しない。ジョブはスラッグ＋ポリシーのバージョンで冪等管理され、QAで落ちた計画も「完了」として記録されるため、後の本番実行がスキップされる／状態遷移に失敗する。
- プレビュー用のスラッグは `preview-` で始める。

## Phase 3: live初回実行（まだ非公開）

~~~bash
cp config/policy.live.example.yaml config/policy.live.yaml
# → allowed_source_domains に実ドメインを記入（publish_enabled は false のまま）
pnpm tsx apps/worker/src/index.ts run-pipeline --live \
  --policy config/policy.live.yaml --plans config/plans.live.json
~~~

- `publish_enabled=false` のままなら、実ソース・実LLMで research → analysis → draft → QA を実行し、記事は `.tmp/live-preview/` にだけ書く（Git commit/公開なし）。前提は `mode=live`、DB、allowlist、LLM。
- 確認: preview原稿・QAレポートを確認し、価格・成果条件・PR表示・出典が正しいか確認する。問題があれば修正して再実行。
- `publish_enabled=false` はlive previewとして有効なモード。`publish_enabled=true` でのみ `content/articles/*.md` への書込・git commitが有効になる（QA不合格はcommitされない）。

## Phase 4: 自動公開の有効化

1. `LIVE_POLICY_YAML` GitHub Secretに `flags.publish_enabled: true` のポリシーを登録（ポリシー自体はrepoにコミットしない）。
2. GitHub Secrets `LIVE_PLANS_JSON` を設定し、`DATABASE_URL`、LLM API key/単価、`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`AFFILIATE_TRACKING_URLS_JSON` があることを確認。
3. GitHub Variable `LIVE_AUTOMATION_ENABLED=true` にする。`.github/workflows/live-pipeline.yml` が毎日02:00 JSTにQA合格記事を `content/articles/` にcommit/pushし、Pagesへデプロイする。
4. GitHub-hosted runnerにはローカルのOpenCodeログインは引き継がれない。**スケジュール自動運用にはAPIキー方式（OpenAI互換）が必要**。OpenCode/Claude Code/Antigravity CLI方式はローカル手動実行向け（または認証設定済みself-hosted runnerを別途用意する）。
5. 緊急停止: GitHub Variable `LIVE_AUTOMATION_ENABLED=false` にする（workflow jobが即skip）と同時に `LIVE_POLICY_YAML` の `publish_enabled` もfalseへ。記事単位の撤去は `worker refresh`（鮮度切れ/無効Fact検知でUPDATE_CANDIDATE/REVOKED化）。

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
