# 12. Architecture Decisions & Open Questions

## ADR-001: Human-free operation, fail closed

Decision: 通常運用に人間承認を置かない。例外は自動的に隔離/停止、通知のみ。人間が必要な外部法的/本人手続きは初期接続要件に分類。

Consequence: 公開量より信頼性を優先する。QA未確定ならコンテンツは公開できない。

## ADR-002: Evidence-first content

Decision: Agentの文章ではなく、公式一次情報・透明な料金式と前提・比較条件を主なソースとする。MVPでは実機検証をしない。

Consequence: 実際に使っていないサービスの体験レビューは禁止。一次情報から独自の比較・計算・判断材料を作れないなら掲載しない。

## ADR-003: Model-agnostic gateway

Decision: OpenCodeを中心候補としながら、Adapter interfaceで複数モデル/プロバイダーを接続できるようにする。

Consequence: 無料枠に依存せず料金・速度・品質の実測で切り替える。

## ADR-004: Static-first distribution

Decision: Astroの静的サイトとGit経由の公開。動的機能は必要時のみ導入。

Consequence: 低コストでバージョン/rollback追跡が容易。

## ADR-005: GitHub Actions first; durable workflow later

Decision: 小規模MVPはGitHub Actionsでスケジュール。stateをDBで保持。規模が増えたらTemporal等に移す。

Consequence: cron遅延やActionsの上限に注意。Cloudflare Pagesだけではブラウザテストを実行しない。

## ADR-006: Program access is opt-in

Decision: ASP/広告主審査が完了し、掲載・追跡・宣伝が許可されたprogramだけactive化。案件条件は実データから読み込む。

Consequence: 実案件がゼロの期間は収益リンクを持たない有益コンテンツのみ、または自動公開停止。

## 未確定（実装着手時に検証）

1. ドメイン名・正式ブランド名・商標チェック。
2. プログラム登録結果と各案件の媒体/PPC/動画/メール条件。
3. OpenCode連携の実際の非対話実行API/CLI仕様と認証・課金方式。
4. Hosting/DB/Storageの価格・無料枠・ジョブ制限。
5. 動画生成と各SNSの公式アップロードAPI・審査要件。
6. クッキー同意・プライバシーポリシー・メール配信の要件。
7. ASP attributionの粒度とレポート取得許可。
8. オープンソース化する場合のLICENSE選択（現時点では未設定）。

## ADR-007: Hands-on testing removed from MVP

MVPではSaaSの実機操作を必須としない。公式の料金・機能・制約を構造化したAnalysis Agentを採用。使用経験や実測結果を捏造しない。必要になれば後続Phaseで再判断する。

## ADR-008: Own domain and search first

記事の正本と収益リンクは独自ドメイン。検索流入を主軸にYouTube/Xを補助。noteの個人向け非公式投稿経路やQiita/Zennでの販促量産は採用しない。
## ADR-009: ユーザーはAIアフィリエイトを希望していない

Decision: AI/SaaSなど特定ジャンルを既定値とせず、国内ASP案件・検索需要・競合・実効報酬・購入障壁・法令/完全自動化適性を横断比較する。初期調査の結果に基づき専門サイトのジャンルを選定する。

Consequence: 過去のn8n/Make/AI系の記事20本は既定の公開計画ではない。AIを優先するロジックを実装に含めない。

## ADR-010: 公開済み記事は更新パスだけが置き換える

Decision: 公開済み（PUBLISHED / MEASURING / UPDATE_CANDIDATE）の記事は新規記事パイプラインから切り離し、更新パス（`runArticleUpdate`）だけが再調査・再QAして置き換える。QAに通り、サイトがビルドでき、commitできた時だけファイルを入れ替え、そうでなければ前版を残す。状態は実際に入れ替わった時だけ進める。ジョブは「トリガー+サイクル+policy_version」をkeyにして、同じトリガーの繰り返しは何もせず新しいサイクルは実行する。更新は `new_articles_per_day` を数えない。

Consequence: 失敗した更新は公開内容を変えないが、失効した価格の記事が前版のまま残り続けうる（`最終確認日` は前回のまま）。再試行は3回で止まり、計画（`LIVE_PLANS_JSON`）の修正が必要。REVOKEDは状態の変更だけでファイルの撤去はまだ自動化していない。
