# 02. Architecture / 全体技術設計

## 論理構成

~~~mermaid
flowchart LR
 S[Scheduler: GitHub Actions] --> O[Orchestrator]
 O --> Q[(PostgreSQL)]
 O --> M[LLM Gateway]
 M --> PA[OpenCode / Provider Adapters]
 O --> R[Research Adapters: allowlist]
 O --> T[Test Runner: isolated Playwright]
 T --> E[(Evidence Object Storage)]
 R --> E
 O --> C[Content Builder]
 C --> G[Policy/QA Engine]
 G -->|PASS| PUB[Git Commit / Site Deploy]
 G -->|FAIL/UNKNOWN| HOLD[Quarantine]
 PUB --> SITE[Astro Static Site]
 SITE --> EVT[Analytics]
 EVT --> O
 O --> AFF[Affiliate Report Import]
 AFF --> Q
~~~

## 初期技術スタック（候補・確定前は要検証）

- TypeScript strict / Node.js LTS / pnpm workspaces。
- サイト: Astro（静的ビルド）/ Cloudflare Pages。公開はGitコミットとビルドの再現性で管理。
- Scheduler: GitHub Actions cron + workflow_dispatch。実行遅延があり、厳密な実時間保証はしない。ジョブ内で排他/再試行。
- 状態保存: PostgreSQL（Supabase/Neon/自前のいずれもadapter経由）。Actionsは永続ディスクではない。
- 重い検証: Playwrightを非特権・使い捨てブラウザコンテナで実行。セッションごとに破棄。
- エージェント推論: LLMGateway interface。OpenCode連携はCLI/APIの現行対応を検証して実装。対応しなければ直接Provider SDK adapterへ。
- 証跡: アクセス制限付きR2/S3互換オブジェクトストレージ。個人情報・認証トークンを削除/マスクしてから保存。
- 監視: DB events + 構造化ログ + 失敗集計 + オーナーへの通知。通知は承認要求ではない。
- 動画/SNS: 将来的に公式API adapter。権限不足・API制約なら「未配信」で保持。

## 目標monorepo構造（未作成）

~~~text
apps/
  site/                    # Astro frontend
  worker/                  # scheduled jobs / CLI
packages/
  domain/                  # state machine, policies, types
  db/                      # schema, migrations, repository
  agents/                  # 7 agent implementations
  llm/                     # model abstraction, budget tracking
  integrations/            # sources, ASP, GSC, GA4, publishers
  testing/                 # Playwright sandbox and fixtures
  content/                 # article templates, validation, scoring
  analytics/               # attribution and KPI calculation
config/
  policy.example.yaml
content/                   # versioned articles/assets (future)
tests/
  unit/
  integration/
  e2e/
.github/workflows/         # staged workflows (future)
docs/
~~~

## 責務の分割

1. Orchestrator = 状態遷移と冪等性。自由な意思決定は禁止。外部操作はpolicyの下で行う。
2. LLM = 文章・分類・企画・仮説生成。実測数値・確定売上・規約許可を決める権威ではない。
3. Evidence = 客観的資料と実行ログの格納・出典管理。すべての可変データに確認日時。
4. QA = 決定論的なpublish blockingルール＋LLM意味整合レビュー（後者だけのPASS禁止）。
5. Publisher = QA済みimmutable artifactだけを公開。ビルド失敗時はロールバック。
6. Growth = 収益計測と提案生成。許可された範囲でのみ記事差分の再生成を指示。

## モデル非依存性

~~~text
interface LLMGateway {
  generateStructured(task, input, schema, limits): Result
  summarize(sourceRefs, limits): Result
}
~~~

adapterは modelId, provider, tokens, cost, latency, errors を返す。原則: 低コストの調査分類モデル→高精度の検証モデル→別モデルの反証レビュー。特定プロバイダーの「無料無制限」は前提としない。

## 配備境界

- Public: Astroの静的HTML/JS/CSS。Secretsなし。
- Worker: secretsを必要最小限持つジョブ実行基盤。ログにcredentialを出さない。
- Sandbox: Webブラウザ・第三者ページ・ダウンロード等。不信データをworker中核から隔離。
- Storage: DB接続資格情報、証跡、財務データをアクセス制限する。
- Publisher credential: 検証ジョブには渡さず、最終段の発行タスクに限定する。

## 発展計画

MVPは逐次ワークフローで十分。ジョブが長時間化/多並列化した段階でTemporal等のdurable workflowへ移行。キュー・分散ロック・DBマイグレーションを先に作り、移行余地を残す。OCI Always Free等の無料リソースは可用性・上限・契約条件を確認してから採用する。
