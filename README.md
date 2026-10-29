# Autonomous Affiliate Engine

AIが公式一次情報を調査・構造化し、比較分析・記事生成・公開・集客・収益分析・改善を行う、**無人運用を目標としたアフィリエイトメディア基盤**。

> Status: **Dry-run MVP implemented / Live operation disabled**（2026-10-24）。
> pnpm monorepo・記事パイプライン（公式ソース取得→Fact構造化→試算→原稿→自動QA→プレビュー公開）・Astroサイト・セキュリティ負例テストは実装済み（`pnpm test` で検証可能）。
> **実サイトでの自動公開・収益化・実ASPデータの取り込み・GSC/GA4データの取り込み（read adapter）は稼働していません。** 自社サイトのGA4タグ（閲覧と紹介リンククリックの送信）は実装済みですが、`GA4_MEASUREMENT_ID` を登録するまで無効です（[docs/08](docs/08-distribution-and-analytics.md)）。実データを用いる市場選定（B000A〜D）も未実施です。
>
> 方針: **運用フローに人間の承認ステップを置かない**。自動判定できない場合は公開・支出・外部操作を止める（fail closed）。本人確認、ASP入会審査、決済・税務などサービス側で本人対応が必要な手続きまで自動化可能と主張しません。

## 目的

- **ジャンル未指定・未決定。AI系を優先する要件はない。** 通信、宅配買取、資格・教育、転職、生活サービス、ソフトウェアなどを横断して、日本の需要・競合・報酬・成約障壁・無人運営適性から選ぶ。
- 読者: 日本のサービス申込・契約・買取・講座選びなどを検討する人。具体的な読者像は選定されたジャンルごとに定義。
- 提供価値: **公式一次情報に基づく独自比較・条件別料金シミュレーション・用途別選定表**。
- 収益: 各ASPやサービスで**承認済み**の紹介プログラムのみ。成果確定額と推定額を分離する。
- 主要KPI: 承認売上 / 1,000収益化対象訪問（JPY）、承認EPC、CTA CTR、確定利益。
- 開発目標: **90日で市場スクリーニングを含む自動実行のMVP・計測ループを成立**。売上金額・SEO順位は保証しない。

## 自律運営フロー

~~~mermaid
flowchart TD
  A[Opportunity Agent: 需要/競合/報酬を比較して候補採点] --> B[Research Agent: 公式一次情報]
  B --> C[Analysis Agent: 料金試算/用途別比較]
  C --> D[Content Agent: 記事/比較表/素材]
  D --> E{QA Agent: 全ゲート合格?}
  E -- Yes --> F[Publisher Agent: 自動デプロイ]
  E -- No --> G[修正3回まで/隔離]
  G --> E
  F --> H[Growth Agent: SEO/CTR/承認売上]
  H --> A
  H --> I[旧記事の改善候補]
  I --> B
~~~

すべての公開物に出典・確認日時・計算式・試算条件を残す。**MVPではSaaSを実際に操作しない**。使ったことがないサービスについて体験談・実機検証済みと記載しない。PR表記、禁止事項のチェック、予算上限を自動実装する。

## 開発方針

- 言語: TypeScript / Node.js。パッケージ管理: pnpm（実装時にバージョンを固定）。
- サイト: Astro + Cloudflare Pages（候補）。ワーカー: GitHub Actionsから開始。MVPはSaaSへのログイン・実機検証を行わない。将来必要になった場合のみ別機能として検討。
- エージェント: OpenCodeは実装候補。LLM provider adapterにより特定モデルへ依存しない。
- DB: PostgreSQL。ログ・スクリーンショット: プライベートオブジェクトストレージ。ソース: Git。
- 自動公開: **出典・計算式・独自価値・広告表示・セキュリティ・技術的QAの全ゲート合格**が必要。未検証・不明・違反疑いの場合は公開しない。
- 初期レート: 最大1記事/日、AI・実行基盤費は月3万円上限、広告出稿なし。
- サービスの利用規約やプログラム条件が未検証なら、その連携は有効化しない。

## ドキュメント

| ファイル | 内容 |
| --- | --- |
| [docs/01-product.md](docs/01-product.md) | ビジョン、対象読者、非目標、成功基準 |
| [docs/02-architecture.md](docs/02-architecture.md) | システム構成、境界、責務、デプロイ |
| [docs/03-agents.md](docs/03-agents.md) | 7エージェントのI/O・実行権限 |
| [docs/04-workflows.md](docs/04-workflows.md) | 状態遷移、リトライ、スケジュール |
| [docs/05-data-model.md](docs/05-data-model.md) | DBテーブル・スキーマ・イベント |
| [docs/06-quality-and-compliance.md](docs/06-quality-and-compliance.md) | 自動QA、広告表示、SEO・法令 |
| [docs/07-security-and-budget.md](docs/07-security-and-budget.md) | 秘密情報、隔離、ガードレール |
| [docs/08-distribution-and-analytics.md](docs/08-distribution-and-analytics.md) | SEO、動画、SNS、計測、収益指標 |
| [docs/09-roadmap.md](docs/09-roadmap.md) | 90日ロードマップ・Done条件 |
| [docs/10-operations.md](docs/10-operations.md) | 自律運用、障害復旧、自動停止 |
| [docs/11-backlog.md](docs/11-backlog.md) | 実装順序と受入条件 |
| [docs/12-decisions.md](docs/12-decisions.md) | 主要設計判断と未確定事項 |
| [docs/13-editorial-and-channels.md](docs/13-editorial-and-channels.md) | **何の記事をどこへ配信するか：具体的な20記事案とCTA** |
| [docs/14-affiliate-programs.md](docs/14-affiliate-programs.md) | 商材候補の公式制度・掲載条件・審査ゲート |
| [docs/15-market-validation.md](docs/15-market-validation.md) | **ジャンル横断の需要・SEO競合・収益性検証** |
| [AGENTS.md](AGENTS.md) | このリポジトリを実装するAIコーディングエージェントへの指示 |
| [config/policy.example.yaml](config/policy.example.yaml) | 実行・公開・費用ポリシー例 |
| [.env.example](.env.example) | 環境変数一覧（秘密情報は含めない） |

## Quick start（実装済み dry-run の実行手順）

~~~bash
pnpm install
pnpm test        # unit / integration / e2e（セキュリティ負例を含む）
pnpm lint && pnpm typecheck && pnpm build
pnpm pipeline:dry-run   # フィクスチャソース → 試算 → 原稿 → QA → プレビュー出力（.tmp/preview）
pnpm --filter site build  # プレビュー記事を含むサイトビルドの検証は tests/e2e が実施
~~~

- `apps/worker` — パイプラインCLI。`run-pipeline`（dry-run）/ `run-pipeline --live`（実運用・前提条件を満たさなければ停止。鮮度巡回と公開済み記事の更新も行う。`--template-revision <名前>` で公開済み記事を作り直す。docs/04）/ `import-offers` / `import-conversions` / `serp-import` / `check-robots` / `refresh` / `growth` / `report`。dry-runは secrets 不要。
- `packages/*` — domain（policy/state machine/logging）、db、llm（budget ledger / OpenAI互換provider）、integrations（source collector/allowlist/ASP取込/計測モック/robots確認）、analysis（ジャンル別試算）、content（draft/QA）、agents、analytics。
- `config/policy.dry-run.yaml` — フィクスチャ用 allowlist を含む検証済みポリシー。
- `config/policy.live.example.yaml` — 実運用ポリシーのテンプレート（allowlist未設定のままでは起動しない）。
- **実運用への切替手順は [docs/16-live-rollout.md](docs/16-live-rollout.md)**（本人手続きチェックリスト含む）。
- ライブパイプラインは `.github/workflows/pipeline.yml`（毎日 02:00 JST）で**dry-runのみ**実行。サイトのデプロイは `.github/workflows/deploy.yml`（手動、Cloudflare Pages secrets必須）。

設計時の着手手順（履歴として保持）:

1. [docs/11-backlog.md](docs/11-backlog.md) を上から順に実装する。
2. [docs/02-architecture.md](docs/02-architecture.md) のmonorepo構造を作り、テストと型検査を導入する。
3. [config/policy.example.yaml](config/policy.example.yaml) を検証し、環境固有の設定に展開する。
4. 本人による外部サービス登録・必要な審査・正規の認証情報設定を完了させる。
5. まず dry-run で **公式情報収集 → 料金・機能を正規化 → 比較/試算 → 原稿 → QA → プレビュー** をE2E検証する。
6. パブリッシュと配信の機能フラグを個別に有効化する。自動公開できないなら何も公開しない。

**実データの収集・公開は現時点で未実施。** 現在の実行状況を示すバッジや収益数値は置かない。

## 公式ポリシー参考

- [Google 検索スパムポリシー](https://developers.google.com/search/docs/essentials/spam-policies?hl=ja)
- [Google 広告リンクのrel属性](https://developers.google.com/search/docs/crawling-indexing/qualify-outbound-links?hl=ja)
- [消費者庁 ステルスマーケティング](https://www.caa.go.jp/policies/policy/representation/fair_labeling/stealth_marketing)

## License

未決定。ライセンスファイルを用意するまで、公開リポジトリであっても再利用許諾を意味しません。

## 記事の公開先と集客経路

- **記事本体:** 独自ドメインのAstroサイト。収益化の中心となる比較ページをここへ掲載。
- **メイン集客:** Google検索のSEO。検索で訪れた読者を記事内の許可されたASP紹介リンクへ誘導。
- **補助集客:** YouTube（記事の図解）とX（料金・比較の要点）から自社記事へ誘導。ただし公式API・利用規約・紹介規約が確認できた場合だけ。
- **初期対象外:** note個人アカウントへの非公式自動投稿、Qiita/Zennへのアフィリエイト量産、無断SNS宣伝。

実際に公開する記事20本の候補と、各記事のCTA・配信先は [記事/配信設計](docs/13-editorial-and-channels.md) を参照。
## 商材の選定ルール（2026-10-24改訂）

**AI/SaaSを特別扱いしない。ユーザーはAIツール紹介を希望していない。** 初期候補を市場調査し、`docs/15-market-validation.md` に従ってランク付け。検索ボリュームや実成約率が未取得の場合はUNKNOWNとし、推測値を実績として公表しない。小規模テスト後は検索流入・紹介クリック・承認EPCに応じて商材を入れ替える。
