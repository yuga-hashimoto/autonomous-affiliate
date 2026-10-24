# 08. Distribution, Attribution & Analytics

## 初期集客

検索需要が明確なクエリを優先:
- 「n8n Make 比較」
- 「n8n cloud self host 違い」
- 「Make 無料プラン 制限」
- 「n8n AI 自動化 使い方」
- 「Make n8n 実行回数 料金」

これは**仮説キーワード**。需要・競合はAPI/検索データを取得して検証するまで確定ではない。

コンテンツ形式: 比較表、料金シミュレーター、再現可能な無料テンプレート、障害検証、公式仕様の差分。1記事を複数の媒体で単純大量転載せず、媒体の目的に合わせて編集する。

## 自動配信条件

- SEOサイト: 公開gate全合格でデプロイ。RSS・サイトマップ・canonical更新。
- YouTube: 動画の素材ライセンス、実測と一致したナレーション、広告表示、API投稿権限がある場合のみ。条件がなければ投稿をskip。
- Xなど: API・自動化規約・投稿レートを検証し、宣伝のみのスパム連投を避ける。未確認なら停止。
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

成果の良いテーマを増やす際も独自の実測がない派生記事を大量生成しない。

## 収益源戦略

最初は2サービス以下で深い検証。ASPアカウントの審査が通り、媒体での紹介・日本在住の登録・支払条件・宣伝制限が確認できるまでは offer.active=false。報酬単価や継続率は媒体条件が変わるため、設計書では固定しない。
