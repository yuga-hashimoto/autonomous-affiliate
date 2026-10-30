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
- 日次ジョブ: `pipeline`（ドライラン、プレビュー成果物のみ・公開なし）と `live-pipeline`（実公開）は、どちらも毎日02:17 JSTに実行する（GitHubは毎時0分の定期実行を遅延/欠落させるため0分を避けた。`live-pipeline` の旧 `0 17` は4時間以上遅れて起動した）。02:17の定期実行そのものは未確認。
- ライブ公開（2026-10-27 開始）: 許可ドメインは `premium-water.net` のみ（robots確認済み、利用規約は本人が確認）。`LIVE_AUTOMATION_ENABLED=true`、`LIVE_POLICY_YAML`（`publish_enabled: true`）と `LIVE_PLANS_JSON`（計画1件）を登録済み。`live-pipeline` を手動実行し、`premium-water-famfit2-24month` の1本を公開した（run 40451118865、コミット `549f35f`）。`AFFILIATE_TRACKING_URLS_JSON` は未設定のため収益リンクはない（A8提携は未承認）。
- 公開済み記事の更新（2026-10-27 追加）: 毎日の `live-pipeline` は最初に鮮度巡回を行い、根拠Factが失効した記事（価格は7日）を `UPDATE_CANDIDATE` にして再生成・置き換える。QAに落ちる/公式ページが取れない場合は前版が公開され続け、翌日以降に再試行する（3回で停止）。手順と仕様は docs/04「既存記事更新」。この仕組みの追加前に公開した `premium-water-famfit2-24month` は図（PR #9）を持たない。反映するには `live-pipeline` を手動実行し、入力 `template_revision` に名前（例 `figures-1`）を渡す。同じ名前の再実行は何もしない。
- 公開の上限と残り: 計画は1件だけなので、翌日以降の実行は同じ記事を冪等にスキップし、記事は増えない。増やすには計画の在庫が要る。在庫の扱い（許可ドメインで待機・日次上限で繰り延べ）は実装済み（下の「計画の在庫」）。計画の金額を公式ページの原文の引用から起こす部分は水だけ実装済み（docs/18、`draft`。ローカルの実測3回とCIの `live-preview` 2回で、手書きと同じ入力・同じ数字の記事）。稼働中の計画はまだ使っていない。比較表は1社のみ。契約解除料は公式ページで未確認（記事にUNKNOWNと明記）。
- 初回のプレビューで見つけた不具合: 実LLM（API経由）の事実抽出が出力上限の既定2,048トークンで途中切れになり `Unterminated string in JSON` で失敗した。抽出器は16,384トークンを要求し、プロバイダは `finish_reason=length` を「truncated」として報告する（#6）。
- 記事の画像（AI生成・OpenRouter。**稼働中（2026-10-27〜、`OPENROUTER_API_KEY` 登録済み）**）: 公開する記事に16:9のヒーロー画像を1枚付ける。モデルは既定で `qwen/qwen-image-2.1-turbo`（OpenRouterの画像API、1枚約0.0184ドル）。`OPENROUTER_API_KEY` を **GitHub Actions secret** に入れたときだけ有効で、無ければ画像なしで公開する（エラーにしない）。プロンプトは業種ごとの固定文で、ページ本文やLLM出力は一切入らない。画像は商品写真ではなく一般的なイラストで、記事には「イメージ画像（AI生成）。実際の商品・サービスとは異なります。」を必ず表示する。生成物は png/jpeg/webp・16:9前後・640px以上だけを受け入れ、1280pxのWebPに再エンコードして `apps/site/public/images/articles/<slug>/hero.webp` に保存し、記事と同じコミットに入れる。失敗しても記事は止めない（画像なしで公開）。既に画像のある記事の更新では再生成しない（課金なし）。費用は `api` として月次の支出に記録する（JPY換算は `IMAGE_USD_JPY`、既定200円/ドルの上限見積もり。1枚あたりの上限は `IMAGE_MAX_COST_JPY`、既定15円。月予算を超える見込みなら呼ばない）。確認用に `image-smoke` workflow（手動）が1枚だけ生成して run artifact に残す。公式商品写真は使わない（premium-water.net の /affiliate/ 規約。A8承認後にASP提供素材を検討）。
- 緊急停止: `gh variable set LIVE_AUTOMATION_ENABLED --body false`（ジョブは即スキップ）。あわせて `LIVE_POLICY_YAML` の `publish_enabled` も `false` に戻す。

### 計画の在庫（2026-10-28）

`LIVE_PLANS_JSON` には計画を何件でも入れてよい。毎日の `live-pipeline` は上から順に処理し、**新規記事は `new_articles_per_day`（1）までしか公開しない**。順序が優先順位で、先頭の未公開が先に出る。

- **許可ドメインの外の計画は待機する**（`domain_not_allowlisted`）。例外にはしない。以前は1件でも許可外があると実行全体が止まり、公開済み記事の更新も止まった。待機中の計画は公式ページを読まず、LLMも呼ばない。会社を足す手順は変わらない: 本人が `robots.txt` と規約を確認し、`LIVE_POLICY_YAML` の `allowed_source_domains` にドメインを足した日から、その会社の計画が順番に出る。
- **上限に当たる計画は、調べる前に繰り延べる**（`daily_limit`）。以前は2本目以降を調査・生成・QAしてから公開の段階で上限に落とし、隔離（QUARANTINED）して、ジョブを完了にしていた。翌日以降は「完了済み」でスキップされ、LLM費用だけ使って二度と出なかった。今は何も記録せず、翌日の実行がそのまま拾う。
- 公開済み記事の更新は上限を数えず、待機の影響も受けない。
- 日次実行のサマリーには待機の理由別の件数だけを出す（このリポジトリのActionsログは公開で、計画は非公開のため）。名前と理由は本人のMacで見る:

```bash
pnpm worker plans-status --policy config/policy.live.yaml --plans config/plans.live.json
```

`plans-status` はネットワーク・DB・秘密情報を使わない。日次上限による待機は、その日に何が公開されたかで決まるため表示しない。

- A8.net: `sougakuhikaku.com` サブサイト登録済み。広告主プログラムの提携申請・承認は未完了。公開後にURL提出が必要なプログラムがあり、自動化できるまで自動運用の対象にしない。提携申請・リンク取得・URL提出にはA8の公式APIがなく、管理画面の操作が要る。CIから管理画面へログインできるかを `a8-login-smoke` workflow（手動）で確認する（下の「0-7」）。A8の利用規約は会員限定の情報（プログラム名・成果条件・報酬額）の公開を禁じるため、この公開リポジトリには書かない。

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

- Search Console: <https://search.google.com/search-console> → 「URL プレフィックス」で `https://sougakuhikaku.com/` を追加 → 確認方法は「HTML タグ」。表示される `<meta name="google-site-verification" content="...">` の `content` の値（公開値）をGitHubのVariable `GSC_VERIFICATION_TOKEN` に登録すると、次回のサイトビルドから全ページの `<head>` に出る。デプロイ後にSearch Consoleで「確認」を押す。**確認後もタグを外さない**（外すと所有権の確認が失効する）。「ドメイン」タイプのDNS TXT認証はCloudflare DNSの編集権限が要るため使わない。なお「HTML ファイル」方式は、Cloudflare Pagesが `.html` のURLを拡張子なしへリダイレクトする可能性があるため避けた。
  - 2026-10-30: プロパティ `https://sougakuhikaku.com/` を追加済み。確認は、タグを含むビルドのデプロイ後。
- GA4: <https://analytics.google.com/> → プロパティ作成 → Webストリームで測定ID取得
- 測定IDをGitHubのVariable `GA4_MEASUREMENT_ID` に登録する（`G-` で始まる公開値で、秘密情報ではない）。次回の `deploy` / `live-pipeline` のサイトビルドからGA4タグが入り、プライバシーポリシーもGoogle アナリティクス使用の文面に切り替わる。未登録のあいだはタグを出さない。
- GA4の管理画面 → カスタム定義で、イベントスコープのカスタムディメンション `page_id` / `offer_id` / `cta_id` / `channel` を登録する（紹介リンククリック `affiliate_cta_click` を案件・記事別に見るため。docs/08）。**2026-10-29に登録済み**: ディメンション名は `affiliate_page_id` / `affiliate_offer_id` / `affiliate_cta_id` / `affiliate_channel`（プロパティ「総額比較 (sougakuhikaku.com)」。GA4アカウントは既存の「Default Account for Firebase」配下）。
- 動作確認: 本番を開き、GA4の「リアルタイム」で閲覧が出ること、記事内の紹介リンクをクリックして `affiliate_cta_click` が出ることを確認する。広告ブロッカーやDo Not Trackを有効にしたブラウザでは計測されない（仕様）。

---

### 0-7. A8管理画面へのCIログイン確認（`a8-login-smoke`）

A8には提携申請・リンク取得・URL提出のAPIがなく、無人運用にはCIから管理画面（`media-console.a8.net`）へログインする必要がある。セッションCookieをsecretに置く方式は期限切れで止まるため、ID/パスワードでのログインを試す。まず**ログインだけ**を1回確認し、通ってから申請・リンク取得・URL提出を足す。

- 登録（本人。値はチャットやコードに書かない）: GitHubの Environment `a8`（mainブランチだけが使える）に secret `A8_LOGIN_ID` と `A8_LOGIN_PASSWORD` を入れる。`gh secret set A8_LOGIN_ID --env a8` のように実行すると値の入力を求められる。
- 実行: Actions の `a8-login-smoke` を手動実行（mainで）。ログイン1回と会員ページ1回の読み取りだけで、申請も変更もしない。
- 結果: ログは公開されるため、出力は `outcome`（`logged_in` / `challenge` / `rejected` / `unknown`）、ページのパス（クエリなし）、短い説明だけ。パスワード・ID・プログラム名は出さない。
- `challenge`（CAPTCHAやメール/端末の確認）ならCIからの自動ログインは通らない。回避せず、Macの定期実行に切り替える。`rejected` は再試行しない（ロック回避）。
- ログインが通ったあとの第一段階は、プログラム一覧の読み取りだけ（`a8-programs` workflow、手動・読み取り専用）。読む一覧は「参加中」「申込中」「終了」「解除」の4つで、どの一覧に載っているかが承認状況になる（参加中＝`approved`、申込中＝`pending`、終了・解除＝`ended`。「却下」「終了」などの文言があれば一覧より優先し、参加中で広告リンクのページが無い行は `unknown`＝未承認扱い）。出力は一覧ごとの状態別件数のみ。一覧が空なら「データなし」表示で `empty`、行も「データなし」も見つからなければ `unrecognized`（画面の作りが想定と違う）としてworkflowを失敗させ、空と取り違えない。入力 `probe` を有効にすると、空でない一覧の内容を伏せたページ構造（見出しや選択肢などの定型文、リンク先のパス、文字数）も出して、管理画面の作りを調べられる。ヘッダーのメディアIDやサイト名は出力に含まない（初回の実行でマスクの漏れがあり、その実行のログは削除した）。プログラム名・条件・報酬額・IDはログに出さない（公開リポジトリ・A8規約）。
- 提携申請の前に、対象プログラムの検索結果・詳細・申請画面を読むのが `a8-inspect-program` workflow（手動・読み取り専用、入力 `keyword`）。何も送信しない。会員限定の掲載条件は本文を出さず、固定の語句の有無（公開後URL提出、審査、即時提携、自己申込の注意、比較サイトの言及、リスティング広告）を真偽値でだけ出す。申請フォームのサイト選択は、選択肢の名前（アカウントのサイト名）を出さず、対象サイト（総額比較）が選べるか・既定で選ばれているかだけを出す。リンクは `/program/` 配下で、実行・完了・登録・削除などを思わせるパスは開かない。見出しは短いものだけ、キーワード（プログラム名）は `[term]` に置き換える。
- 管理画面の多くはページを開いたあとにJavaScriptで中身を描くため、開いた直後に読むと「データなし」に見える。読み取りは、通信が静まるまで待ち、行が0件のときはさらに少し待って読み直してから「空」と判定する（`a8-programs` / `a8-inspect-program` 共通）。最初の `a8-programs` の「4一覧とも空」は、この待ちが無い状態の結果なので、修正後にもう一度読んで確かめる。
- 承認済みプログラムは、名前を出さずに「どのジャンルか」の件数だけを `a8-programs` の出力に含める（`approvedByVertical`）。名前の公開語彙（ウォーターサーバー、光回線、SIM、引越し、買取などの語句）でdocs/01の業種に振り分け、先に当てはまった規則を採用する（車買取は買取より先）。どれにも当てはまらなければ `other`。名前そのものは保持も出力もしない。
- 提携申請は `a8-apply` workflow（手動、入力 `keyword`）。まだ提携していないプログラムの詳細ページで、申請フォームのサイト選択を**総額比較**に合わせ（選択肢のうち対象サイトを名指しするものがちょうど1つで、値を持つときだけ。見つからない・2つ以上なら何もしない。既定のままアカウント最初のサイトで申請する事故を避ける）、申請ボタンを押す。**このボタンの1回が申請そのもの**で、実行すると `/program/agreement/apply-result` に進み、同意画面は挟まらない（初回の実行で確認済み）。プログラムによっては即時に提携済みになる。結果ページの構造（内容は伏せる）、フォームの控えのサイト値が選択と一致したか、チェックボックスと送信ボタンの数を出力し、結果ページでは何も押さない。結果ページにサイト名は出ないため、サイトが正しかったことは「選択と控えの一致」で確かめる。押すのは単一プログラムの申請フォーム（`/program/agreement/apply`）だけで、一括提携は押さない。CAPTCHA・本人確認が出たら通過せず止まる。1回の実行で1プログラム、キーワードに合う最初の結果に申請するので、キーワードは具体的にする。
- 承認済みプログラムの名前とカードの文面は、公開ログに出せないので `a8-export` workflow（手動・読み取り専用）で**暗号化して**出力する。入力の公開鍵（RSA 2048bit以上）で、一回限りのAES-256-GCM鍵をRSA-OAEPで包む形で、出力は1行のbase64（`ENCRYPTED:` で始まる）。復号できるのは秘密鍵の持ち主だけで、秘密鍵はGitHubに置かない。秘密鍵を入力しても拒否する。鍵が不正ならA8にログインする前に失敗する。
- 提携済みプログラムの広告リンクページ（広告リンク作成）の構造は `a8-link-probe` workflow（手動・読み取り専用、入力 `keyword`）で読む。参加中一覧からキーワードに合い、自身の `/program/create-link?programId=` を持つ最初のプログラムを開き、構造（内容は伏せる）と、サイト選択に総額比較があるか・既定で選ばれているかのフラグだけを出す。何も押さず、リンクも生成しない。リンクを作る処理は、この出力を見てから作る。
- 自動操作はA8の会員規約上のリスクがある。申請は週5件程度から始め、アカウント停止の兆候があれば止める。

## Phase 1: GitHub 設定（リポジトリ → Settings → Secrets and variables → Actions）

Secrets（<https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions>）:

| Name | 値 | 出所 |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://...` | Phase 0-3 |
| `LLM_API_KEY` | API key（Z.ai/OpenAI互換） | Phase 0-4（API方式のみ） |
| `OPENROUTER_API_KEY` | OpenRouterのAPI key（記事の画像生成。任意） | 画像を付けたいとき |
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
   プログラム規約に「掲載後URL提出」等の継続的な手動作業がある場合、公式API/自動化経路が確認できるまでそのオファーは自動運用対象にしない（例: 公開後URL提出が必要なA8プログラム）。
3. **SERP観測（B000B）**: 手動で検索（地域=日本/言語=日本語/モバイルを固定）し、上位10件を記録。形式は `SerpObservation`（`packages/domain/src/types.ts`）。無断スクレイピングはしない。検索ボリュームはKeyword Planner等の実測値のみ、取れなければUNKNOWN。
4. **プラン作成**: `config/plans.dry-run.json` と同じ形式で `config/plans.live.json`。数値は全て対象サイトの公式ページから転記（確認日を記録）。

## Phase 3の前段: 非公開プレビュー（DB・公開なし）

実ページ・実LLMで、計画がQAを通るかを確認する。DB、git、デプロイには触れず、公開は強制的にオフになる（ポリシーの `publish_enabled` に関係なく）。

- GitHub Actions: `live-preview` workflow（手動実行）。本番と同じLLM経路で動く。結果はジョブのサマリーとartifactに出る。
- ローカル: `pnpm tsx apps/worker/src/index.ts run-pipeline --live --preview --policy config/policy.live-preview.yaml --plans config/plans.live-preview.json`（LLMは `LLM_PROVIDER=cli` のopencode等。遅い経路では `LLM_EXTRACT_TIMEOUT_MS` を上げる）。
- 更新パスの非公開確認: `live-preview` の入力 `update_path` を有効にする（CLI: `--preview-update` を追加）。新規プレビューに続けて、その記事を更新パスで再生成した原稿とQAを示す（調査が2回走る）。
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
5. 更新パスの運用: 日次実行が鮮度巡回と更新を行う。記事生成側の改善を公開済み記事へ反映したい時は `live-pipeline` を手動実行して `template_revision` に新しい名前を渡す。更新は `limits.new_articles_per_day` を消費しない（新規記事だけが1日1本）。結果は実行のジョブサマリー（記事ごとの action / update）に出る。`kept_previous` が続く時は計画の金額が公式ページとずれていることが多く、`LIVE_PLANS_JSON` を直して新しい名前で再実行する。
6. 緊急停止: GitHub Variable `LIVE_AUTOMATION_ENABLED=false` にする（workflow jobが即skip）と同時に `LIVE_POLICY_YAML` の `publish_enabled` もfalseへ。記事単位の撤去は `worker refresh`（鮮度切れ/無効Fact検知でUPDATE_CANDIDATE/REVOKED化）。

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
