# 08. Distribution, Attribution & Analytics

## 初期集客

商材ジャンルは**未選定**。購入意図が強い具体的な検索クエリは、ジャンル選定後に作る。候補例として「格安SIM 20GB 料金 比較」「宅配買取 返送料無料」「資格名 通信講座 比較」「光回線 実質料金」を含めて調査するが、需要・競合はAPI/検索データ取得まで未確定。

コンテンツ形式: 出典に基づく比較表・ジャンル別の総額/条件シミュレーター・対象者別選び方。1記事を複数の媒体で単純大量転載せず、媒体の目的に合わせて編集する。

## 自動配信条件

- **独自ドメインのSEOサイト**: 記事の正本と許可された紹介リンクを掲載。公開gate全合格でデプロイ。RSS・サイトマップ・canonical更新。
- YouTube: 料金・選択基準を図解したスライド動画（実機レビューを装わない）。素材ライセンス、広告表示、公式API投稿権限がある場合のみ。条件がなければskip。
- Xなど: 比較表や公式価格変更の要約から自社記事へ誘導。API・自動化規約・投稿レートを検証し、宣伝のみのスパム連投を避ける。未確認なら停止。
- メール: 許諾を明示取得した購読者のみ、配信停止リンク等の法令対応が可能な場合だけ実装。

## 計測イベント

- page_view / scroll（適切なプライバシー設定を前提）
- affiliate_cta_impression
- affiliate_cta_click{page_id,offer_id,cta_id,channel}
- template_download{template_id,page_id}
- video_referral_click{video_id,destination}
- conversion_import{program_id,external_event_id,status,amount}
- payout_import{program_id,amount,paid_at}

クリック時に専用の自社短縮URLで無理に追跡せず、ASP条件に合わせる。サードパーティの広告トラッキングや同意要否は個別に確認する。

## KPI算式

- Outbound CTR = affiliate_cta_clicks / monetizable_article_sessions
- Approved conversion rate = approved_conversions / valid_affiliate_outbound_clicks（追跡可能な範囲のみ）
- Approved EPC = approved_commission_jpy / valid_affiliate_outbound_clicks
- Approved revenue per 1k targeted sessions = approved_commission_jpy / monetizable_article_sessions * 1000
- Operating profit estimate = approved_commission_jpy - attributable operating costs
- Cash flow = payouts_received - cash_expenses（承認売上とは別）

**重要:** ASPがpage/CTA単位のattributionを返さない場合、page別の収益を捏造しない。キャンペーン全体の総額のみ使い、按分はあくまで推定として表示。

## Growth Agentの改善ルール例

- 検索表示はあるがCTR低い: タイトルと説明文を見直す。
- 訪問はあるがCTA CTR低い: 比較表の配置・適合性を検証。
- CTAクリックがあるが成果なし: リンク有効性、紹介条件、訴求とランディング先の一致を検証。
- 成果発生はあるが承認率低い: 否認理由や案件条件を確認、弱い案件を停止。
- データ不足: 優劣の確定をしない。サンプル収集を続ける。

成果の良いテーマを増やす際も、独自の比較・計算・判断材料がない派生記事を大量生成しない。

## 収益源戦略

採択したジャンル内の複数承認案件を比較。ASPアカウントの審査が通り、媒体での紹介・日本在住の登録・支払条件・宣伝制限が確認できるまでは offer.active=false。報酬単価や継続率は媒体条件が変わるため、設計書では固定しない。

## 媒体の優先度

P0=独自サイトとGoogle検索。P1=公式API対応後のYouTube/X。P2=オプトインメール。noteは個人向け公式記事投稿APIの条件を満たさないため初期対象外。Qiita/Zennへの自動宣伝/記事転載も対象外。具体的な記事、CTA、配信形式は [13-editorial-and-channels](13-editorial-and-channels.md)。
## 商材・キーワード獲得の優先順位

`docs/15-market-validation.md` の市場調査を初回公開前に実行する。『競合が少ない』を検索結果の件数から推定しない。指定国/言語の購買キーワードのSERPを複数取得し、上位サイトの強さ・意図合致・独自比較の余地を定性/定量で計測する。記事数増加より案件別の承認EPCと対象訪問1000件あたりの承認報酬を重視。
