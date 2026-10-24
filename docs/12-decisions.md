# 12. Architecture Decisions & Open Questions

## ADR-001: Human-free operation, fail closed

Decision: 通常運用に人間承認を置かない。例外は自動的に隔離/停止、通知のみ。人間が必要な外部法的/本人手続きは初期接続要件に分類。

Consequence: 公開量より信頼性を優先する。QA未確定ならコンテンツは公開できない。

## ADR-002: Evidence-first content

Decision: Agentの文章ではなく、一次情報・テスト結果とassertionを主なソースとする。

Consequence: 実測不可能なサービスは体験レビューとして扱わない。一次情報の紹介/解説で価値を出せないなら掲載しない。

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
