# Cashflow Manager on Cloudflare Workers

Cloudflare Workers + D1 で動作する、社内向けキャッシュフロー管理アプリです。

## 機能
- メール/パスワード認証（ログイン/ログアウト）
- 月ごとの入金・出金予定の登録
- 予定行の順番入れ替え（上へ/下へ）
- 並び順に応じた累計表示
- ヘッダーに月次サマリー（入金合計・出金合計・差引）

## 1. 依存インストール
```bash
npm install
```

## 2. D1 データベース作成
```bash
npx wrangler d1 create cashflow_db
```

実行結果に表示される `database_id` を `wrangler.jsonc` の以下に反映:
- `d1_databases[0].database_id`

## 3. マイグレーション適用
適用順序（推奨）:
1. ローカルで先に適用・動作確認
2. 問題なければ本番へ同じ migration を適用

ローカル:
```bash
npm run d1:migrate:local
```

リモート:
```bash
npm run d1:migrate
```

本番運用向けの `0002_cashflow_hardening.sql` では、以下を追加しています。
- `cashflow_entries.deleted_at`（論理削除の準備列）
- `cashflow_entry_audits`（INSERT/UPDATE/DELETE の監査ログ）
- `updated_at` 自動更新トリガ
- 月次検索の式インデックス（`substr(scheduled_date, 1, 7)`）

既存APIとの互換性維持のため、現状アプリは `deleted_at` を参照していません（従来どおり物理データを取得）。将来、論理削除を有効化する場合は、アプリ側クエリに `deleted_at IS NULL` 条件を追加してください。

監査ログ運用（`cashflow_entry_audits`）:
- 保存期間の目安は 180 日（要件に応じて 90/365 日で調整）
- 月1回の定期削除例: `DELETE FROM cashflow_entry_audits WHERE changed_at < datetime('now', '-180 days');`
- 容量増対策として「保持期間で削除」を基本とし、必要なら月次でCSV退避してから削除

migration 適用ミス時のロールバック/復旧:
1. まず本番DBをバックアップ（エクスポート）して現状保全
2. 問題 migration の修正は「打ち消し用 migration（例: 0003_*）」を追加して前進復旧
3. 直接の履歴書き換え（過去 migration の編集・再適用）は避ける
4. ローカルで `d1:migrate:local` で再現確認後、本番に適用

### 楽々販売CSVの大量取込運用（実務手順）
前提:
- 本番投入前に最新バックアップ取得
- 取込対象CSVは「日付・金額・取引先キー」の必須列を事前検証

手順:
1. `migrate` 実行: 先に `npm run d1:migrate:local` で確認し、問題なければ `npm run d1:migrate` を実行
2. `dry-run` 実行: 取込スクリプトをドライランで実行し、件数・不正行件数・想定投入件数を確認
3. `import` 実行: ドライラン結果が許容範囲なら本取込を実行（ログは実行日時付きで保存）
4. `sync-entries` 実行: 取込後に集計/関連テーブル同期を実施し、月次件数と金額合計を突合

### 運用クイックチェック（local/remote差分・ユーザー/組織切り分け）
1. 適用先DBの取り違え確認（local/remote件数差分）
```bash
npm run d1:count:entries:local
npm run d1:count:entries:remote
```
`entries_count` が想定とズレる場合、`--local` / `--remote` の実行先誤りを最優先で確認してください。

2. 組織メンバー構成の確認（local/remote）
```bash
npm run d1:count:org-members:local
npm run d1:count:org-members:remote
```
同じ `organization_id` に想定ユーザーが所属していない場合、同一組織でのデータ共有は成立しません。

3. ユーザー/組織単位のトラブルシュートSQL（必要時に実行）
```sql
-- ユーザーと所属組織
SELECT u.id AS user_id, u.email, u.organization_id
FROM users u
ORDER BY u.id;

-- 組織メンバー一覧
SELECT om.organization_id, om.user_id, u.email, om.role
FROM organization_members om
JOIN users u ON u.id = om.user_id
ORDER BY om.organization_id, om.user_id;

-- 組織別のエントリ件数
SELECT organization_id, COUNT(*) AS entries_count
FROM cashflow_entries
WHERE deleted_at IS NULL
GROUP BY organization_id
ORDER BY organization_id;
```

エラー時対応:
- 形式エラー（列不足/日付不正）: CSV修正後、`dry-run` から再実行
- 制約エラー（重複/外部キー）: 重複キー一覧を出力し、元データまたはマスタ修正後に再実行
- タイムアウト/中断: 取込済みキーを基準に未処理分のみ再投入（全量再投入しない）

再実行方針:
- 冪等キー（例: `source_file + line_no` または取引ID）で重複登録を防止
- 再実行は必ず `dry-run` を挟み、差分件数が想定どおりか確認してから `import`
- 障害復旧時は「ロールバックより前進復旧」を優先し、必要に応じて補正CSVを別バッチで投入

## 4. ローカル起動
```bash
npm run dev
```

起動後、`http://127.0.0.1:8787` を開き、`/register` でユーザー作成後にログインしてください。

## 5. デプロイ
```bash
npm run deploy
```

## 補足
- パスワードは PBKDF2(SHA-256) でハッシュ化して保存します。
- セッションは D1 の `sessions` テーブルで管理しています。
- 金額は円の整数前提です。

## パスワード再設定トークン運用（0008）
`0008_password_reset_tokens.sql` で `password_reset_tokens` テーブルを追加します。

カラム:
- `token_hash`: 平文トークンは保存せず、ハッシュのみ保持（`UNIQUE`）
- `user_id`: 対象ユーザー
- `expires_at`: 失効時刻（UTC）
- `used_at`: 使用済み時刻（未使用は `NULL`）
- `created_at`: 発行時刻（UTC）

安全な失効設計:
- 検証条件は必ず `used_at IS NULL AND expires_at > datetime('now')` を同時に満たすこと
- 再設定成功時は同一トークン行の `used_at=datetime('now')` を即時更新してワンタイム化
- 平文トークンはDB保存しない（メール送信と照合はハッシュ化して実施）

実装時の想定クエリ（例）:
```sql
-- 発行（事前に token_hash を生成）
INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
VALUES (?, ?, datetime('now', '+30 minutes'));

-- 検証（有効トークンのみ取得）
SELECT id, user_id
FROM password_reset_tokens
WHERE token_hash = ?
  AND used_at IS NULL
  AND expires_at > datetime('now')
LIMIT 1;

-- 使用済み化（ワンタイム保証）
UPDATE password_reset_tokens
SET used_at = datetime('now')
WHERE id = ?
  AND used_at IS NULL;
```

定期クリーンアップ（推奨: 日次）:
```sql
DELETE FROM password_reset_tokens
WHERE used_at IS NOT NULL
   OR expires_at <= datetime('now', '-7 days');
```

運用メモ:
- トークンTTLの目安は 30 分（要件に応じて 15〜60 分で調整）
- 同一ユーザーに短時間で複数発行される想定で、利用時は「提示トークン一致」を唯一の照合キーにする
- 監査観点が必要なら、削除前に別テーブルへ退避する
