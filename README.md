# Autonomous Affiliate Engine

AIが調査・実測・コンテンツ制作・公開・集客・収益分析・改善を行う、**無人運用を目標としたアフィリエイトメディア基盤**。

> Status: **Design / Pre-implementation**（2026-10-24）。現時点では設計書のみです。サイト・ワーカー・収益化は稼働していません。
>
> 方針: **運用フローに人間の承認ステップを置かない**。自動判定できない場合は公開・支出・外部操作を止める（fail closed）。本人確認、ASP入会審査、決済・税務などサービス側で本人対応が必要な手続きまで自動化可能と主張しません。

## 目的

- メイン領域: **AI業務自動化 / SaaS比較**（初期検証例: n8n、Make）。
- 読者: 日本の個人開発者、副業者、小規模事業者、AI自動化を導入したい人。
- 提供価値: AIによる**再現可能な実機検証**、設定例、独自計測、料金・制約比較、無料テンプレート。
- 収益: 各ASPやサービスで**承認済み**の紹介プログラムのみ。成果確定額と推定額を分離する。
- 主要KPI: 承認売上 / 1,000収益化対象訪問（JPY）、承認EPC、CTA CTR、確定利益。
- 開発目標: **90日で自動実行のMVP・計測ループを成立**。売上金額・SEO順位は保証しない。

## 自律運営フロー

~~~mermaid
flowchart TD
  A[Opportunity Agent: 市場/案件発見] --> B[Research Agent: 一次情報]
  B --> C[Testing Agent: 隔離環境で実測]
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

すべての公開物には出典・検証日時を残す。実際に操作していないサービスに「実機検証済み」と記載しない。PR表記、禁止事項のチェック、予算上限を自動実装する。

## 開発方針

- 言語: TypeScript / Node.js。パッケージ管理: pnpm（実装時にバージョンを固定）。
- サイト: Astro + Cloudflare Pages（候補）。ワーカー: GitHub Actionsから開始。重い実機検証は分離された一時コンテナ。
- エージェント: OpenCodeは実装候補。LLM provider adapterにより特定モデルへ依存しない。
- DB: PostgreSQL。ログ・スクリーンショット: プライベートオブジェクトストレージ。ソース: Git。
- 自動公開: **根拠・広告表示・セキュリティ・技術的QAの全ゲート合格**が必要。未検証・不明・違反疑いの場合は公開しない。
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
| [AGENTS.md](AGENTS.md) | このリポジトリを実装するAIコーディングエージェントへの指示 |
| [config/policy.example.yaml](config/policy.example.yaml) | 実行・公開・費用ポリシー例 |
| [.env.example](.env.example) | 環境変数一覧（秘密情報は含めない） |

## Quick start（実装着手手順）

1. [docs/11-backlog.md](docs/11-backlog.md) を上から順に実装する。
2. [docs/02-architecture.md](docs/02-architecture.md) のmonorepo構造を作り、テストと型検査を導入する。
3. [config/policy.example.yaml](config/policy.example.yaml) を検証し、環境固有の設定に展開する。
4. 本人による外部サービス登録・必要な審査・正規の認証情報設定を完了させる。
5. まず dry-run で **調査 → 実測 → 原稿 → QA → プレビュー** をE2E検証する。
6. パブリッシュと配信の機能フラグを個別に有効化する。自動公開できないなら何も公開しない。

**設計書に書かれた機能は現時点で未実装。** 現在の実行状況を示すバッジや収益数値は置かない。

## 公式ポリシー参考

- [Google 検索スパムポリシー](https://developers.google.com/search/docs/essentials/spam-policies?hl=ja)
- [Google 広告リンクのrel属性](https://developers.google.com/search/docs/crawling-indexing/qualify-outbound-links?hl=ja)
- [消費者庁 ステルスマーケティング](https://www.caa.go.jp/policies/policy/representation/fair_labeling/stealth_marketing)

## License

未決定。ライセンスファイルを用意するまで、公開リポジトリであっても再利用許諾を意味しません。
