# 15. Market Validation — 商材・検索キーワードを先に選ぶ

更新: 2026-10-24 / 状態: 調査基準と探索候補。**商材の市場勝者は未確定**。

## 方針変更

n8nとMakeは「紹介制度が存在する」という理由で仮の主力とされていたが、日本における検索需要、検索競合、初回有料化率、承認EPCを比較していなかった。今後は**先に市場調査し、買われる商材を選ぶ**。どの案件も検索数・CVR・受注数の実データを持たない限り「売れやすいと確定」しない。

MVPでも日常運用への人間承認は組み込まない。ただしASP本人確認・審査・銀行/税務要件はシステムが勝手に突破できない。未完了はINELIGIBLE。

## 2026-10-24 公開検索の観察（サンプル・網羅的SERP数値ではない）

- n8nとMakeの直接比較: SaaS MAP と TameshiTech に競合ページ。日本語で「使いやすさ」「料金」「MCP」まで比較済み。**競合ゼロではない**。ニッチなクエリのボリューム不明。
  - https://saasmap.jp/compare/n8n-vs-make
  - https://tameshitech.jp/n8n-vs-make/
- AI議事録全般: Uravation、GXO、AI Tool Lab、各種議事録専門サイトが比較/無料枠/価格のコンテンツを展開。**SERPに競合例が多数**。実測DA/DRや総競合サイト数は未取得。
  - https://uravation.com/media/ai-meeting-notetaker-comparison-2026/
  - https://gxo.co.jp/column/ai-meeting-minutes-tool-comparison-2026
  - https://aitoollab.net/articles/ai-meeting-tools-comparison-2026
- AIスライド比較: Gammaなど複数商材の比較サイトがある。ニッチな検索意図の余地はあるが実際のSERP占有率未計測。
  - https://mihata.jp/column/ai-slide-generation-comparison
- 音声生成ツール: ElevenLabsを含むAI音声の料金単位で比較するサイトがある。
  - https://subsc-navi.com/ai/ai-onsei-seisei-osusume/

**「競合はXX件」「月間検索数XXXX」「CVR X%」「記事を出せば売れる」という数字を出してはいけない。** 上記は発見例であり日本の検索競合全件・検索エンジンの実SERP Top10完全データではない。

## 候補と現状

| 候補 | 収益制度（公開確認） | 市場側の懸念 | MVP適合 | ステータス |
|---|---|---|---|---|
| n8n Cloud | 30% / 最初の12か月 | 開発者層・無料セルフホストへの流出・日本語検索需要不明 | 公式情報の価格比較可 | CANDIDATE |
| Make | 35% / 12か月（**登録起点**）、$100以上+有料紹介3人で支払い | 狭い検索需要、支払い到達条件 | 公式情報で比較可 | CANDIDATE |
| Notta | 新規有料契約30%（友達紹介20%と別制度） | 日本で広く訴求しやすい一方、議事録キーワードは激戦 | 公式料金/会議時間別試算 | CANDIDATE |
| Fireflies.ai | 最大30% / 12か月、90日cookie | 会議ツール競争激しい、日本語購買CVR不明 | 席数別試算 | CANDIDATE |
| ElevenLabs | 対象プラン22% / 12か月、Businessは11% | 低価格プランの絶対報酬は小さく、音声AI競合あり | クレジット/用途別試算 | CANDIDATE |
| Gamma | 公式アフィリエイト募集あり | 報酬率未確認。比較市場の競争と日本語CVR不明 | 公式で確認できる範囲の比較 | CANDIDATE |

公式規約:
- https://n8n.io/affiliates/
- https://help.make.com/affiliate-program
- https://www.notta.ai/en/affiliate
- https://fireflies.ai/affiliate
- https://elevenlabs.io/affiliates-terms
- https://help.gamma.app/en/articles/11048092-how-do-i-join-the-gamma-affiliate-program

## キーワード・競合の機械的調査手順

1. **カテゴリ横断:** 6候補→初期の上限3カテゴリを探索する。商材固定で記事量産しない。
2. **キーワード作成:** 各カテゴリ最低10件の**日本語購入意図あり**クエリ（「料金」「有料 無料 違い」「○○ vs △△」「法人 何人」「料金 計算」「クーポン」等）。情報収集意図だけのキーワードは低優先。
3. **SERP取得:** 適法な公式/契約検索APIで国=JP、言語=ja、スマホ/デスクトップ、取得日時、検索クエリ、自然検索Top10、掲載ドメイン・URL・順位を保存。APIが使えない場合は**UNKNOWN**。検索結果件数やWebサンプルだけを総競合数として扱わない。
4. **SERP分類:** 公式サイト、総合比較メディア、強い企業ドメイン、個人専門サイト、動画、掲示板、広告、SERP機能。各クエリの「勝てる余地」を調査。上位の有名ドメインとドメイン数だけで決めず、**意図適合と情報の不足**を判定。
5. **需要ソース:** Google Keyword Planner / Search Console / 有償SEO APIから得た検索量・表示データ。未取得はUNKNOWN。Google Trendsの指数を絶対検索量と誤認しない。
6. **収益源検査:** 公式の広告主規約・審査・日本居住/媒体許可・対象プラン・報酬額・否認条件・cookie・支払い閾値をDBへ。**未承認の紹介リンクは掲載しない**。
7. **収益期待値:** (実測があれば) 訪問数×実測CTA CTR×実測広告主CVR×承認率×承認後実効報酬。未観測部分はUNKNOWNのままにし、シナリオ計算は別表示。
8. **小規模探索:** 1カテゴリあたり最大3〜5高品質記事を作成・公開し、表示回数・対象ページ訪問・リンククリック・実際の承認額を観測。SEO初期は流入不足を認識。
9. **配分最適化:** 十分なサンプルがある商材を優先し、弱い商材は再設計または停止。少数の初期成果から有意差を断定しない。

## Opportunity score v1（事前評価。0〜5段階）

| 軸 | 重み | エビデンス |
|---|---:|---|
| 日本の検索需要・購買意図 | 25% | 購入意図クエリ・実際の検索量 |
| SEOでの獲得可能性 | 25% | 日本の検索結果上位10件の強さ・弱点・差別化余地 |
| 成約のしやすさ | 20% | 価格、無料→有料移行、言語、導入障壁。CVRがあれば実測CVR優先 |
| 承認後の収益性 | 20% | 公式報酬条件と実測の承認EPC |
| 無人自動化適性 | 10% | 情報公開、比較の独自性、API・媒体許可、更新負荷 |

- 5段階と重みは**運用上の設計値**で、調査済み市場の実績スコアではない。
- 未調査の要素は「0点」扱いせず**UNKNOWN**。確度を下げ、比較できるまで暫定順位として管理。
- 実運用の選定指標は最終的に**承認EPC・承認売上/1000対象訪問・原価差引の利益**へ移す。
- 競合の少なさと実需の小ささを混同しない。
- 報酬率が高いだけで上位にしない。単価・有料継続率・支払い閾値を分離。

## fail-closedポリシー

- 本人申請/審査が必要→申請がない間はoffer.status=PENDING。
- 事実出典・独自計算が不足→記事は公開しない。
- 外部の検索データ欠如→架空の検索数を採用しない。暫定探索に限る。
- program offer未承認→非アフィリエイト公式リンクまたはCTAなし。
- 人間承認ゼロの通常運営は維持。ただしアカウント規約と法的責任は変わらない。

## 初期の具体的な比較クエリ例

- n8n: 「n8n cloud セルフホスト 費用」「n8n make 10000実行 料金」
- Make: 「Make 無料 有料 違い」「Make n8n 比較 料金」
- Notta: 「Notta premium ビジネス 違い」「Notta 1時間 会議 無料 制限」
- Fireflies: 「Fireflies チーム 5人 料金」「Fireflies Notta 商談 議事録 比較」
- ElevenLabs: 「ElevenLabs API 料金 日本語」「ElevenLabs Creator Pro 違い」「AI 音声 商用 料金 比較」
- Gamma: 「Gamma AI PowerPoint 書き出し 有料」「Gamma Plus Pro 違い」

キーワードの実際の採用は日本語SERP・需要の確認後。候補として列挙しただけでランキング獲得可能という意味ではない。
