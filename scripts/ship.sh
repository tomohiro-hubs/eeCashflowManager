#!/usr/bin/env bash
#
# ship.sh - 変更をまとめて「デプロイ → コミット → push → PR作成 → マージ」する
#
# 使い方:
#   ./scripts/ship.sh "コミットメッセージ"
#
# オプション:
#   --no-deploy    本番デプロイ(npm run deploy)をスキップ
#   --no-merge     PRのマージをスキップ（PR作成まで）
#   --no-pr        PR作成・マージをスキップ（push まで）
#   --yes, -y      各ステップの確認プロンプトを省略して自動実行
#
# 例:
#   ./scripts/ship.sh "fix: ボタンの並び順を調整"
#   ./scripts/ship.sh --no-merge "wip: 表示調整"
#   ./scripts/ship.sh -y "fix: 微修正"
#
set -euo pipefail

BASE_BRANCH="main"
DO_DEPLOY=1
DO_PR=1
DO_MERGE=1
ASSUME_YES=0
MSG=""

# --- 引数解析 ---
while [ $# -gt 0 ]; do
  case "$1" in
    --no-deploy) DO_DEPLOY=0 ;;
    --no-merge)  DO_MERGE=0 ;;
    --no-pr)     DO_PR=0; DO_MERGE=0 ;;
    --yes|-y)    ASSUME_YES=1 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    -*)
      echo "不明なオプション: $1" >&2; exit 1 ;;
    *)
      if [ -z "$MSG" ]; then MSG="$1"; else
        echo "引数が多すぎます。コミットメッセージは引用符で囲んでください。" >&2; exit 1
      fi ;;
  esac
  shift
done

# リポジトリのルートへ移動
cd "$(git rev-parse --show-toplevel)"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"

# --- 確認ヘルパー ---
confirm() {
  [ "$ASSUME_YES" = "1" ] && return 0
  printf "%s [y/N]: " "$1"
  read -r ans
  case "$ans" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

echo "▶ ブランチ: $BRANCH  →  ベース: $BASE_BRANCH"

if [ "$BRANCH" = "$BASE_BRANCH" ]; then
  echo "⚠ 現在 $BASE_BRANCH にいます。作業ブランチで実行してください。" >&2
  exit 1
fi

# --- 1) デプロイ ---
if [ "$DO_DEPLOY" = "1" ]; then
  if confirm "① 本番へデプロイ (npm run deploy) しますか？"; then
    npm run deploy
    echo "✅ デプロイ完了"
  else
    echo "⏭ デプロイをスキップしました"
  fi
fi

# --- 2) コミット ---
# 追跡済みファイルの変更のみステージ（.bak や未追跡ファイルは対象外）
git add -u
if git diff --cached --quiet; then
  echo "ℹ コミットする変更がありません（コミットはスキップ）"
else
  if [ -z "$MSG" ]; then
    echo "コミットメッセージが未指定です。第1引数に指定してください。" >&2
    exit 1
  fi
  git status --short
  if confirm "② 上記の変更をコミットしますか？"; then
    git commit -m "$MSG" -m "" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
    echo "✅ コミット完了"
  else
    echo "中止しました。"; exit 1
  fi
fi

# --- 3) push ---
if confirm "③ origin/$BRANCH へ push しますか？"; then
  git push origin "$BRANCH"
  echo "✅ push 完了"
else
  echo "中止しました。"; exit 1
fi

# --- 4) PR 作成（既存があれば再利用） ---
if [ "$DO_PR" = "1" ]; then
  PR_NUM="$(gh pr list --head "$BRANCH" --base "$BASE_BRANCH" --state open --json number --jq '.[0].number' 2>/dev/null || true)"
  if [ -n "${PR_NUM:-}" ] && [ "$PR_NUM" != "null" ]; then
    echo "ℹ 既存のオープンPR #$PR_NUM を利用します"
  else
    if confirm "④ $BASE_BRANCH への PR を作成しますか？"; then
      TITLE="${MSG:-$BRANCH の変更}"
      PR_NUM="$(gh pr create --base "$BASE_BRANCH" --head "$BRANCH" \
        --title "$TITLE" \
        --body "$(printf '%s\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)' "${MSG:-自動作成されたPR}")" \
        | grep -oE '[0-9]+$' | tail -1)"
      echo "✅ PR #$PR_NUM を作成しました"
    else
      echo "PR作成をスキップしました。"; exit 0
    fi
  fi

  # --- 5) マージ ---
  if [ "$DO_MERGE" = "1" ] && [ -n "${PR_NUM:-}" ]; then
    if confirm "⑤ PR #$PR_NUM を $BASE_BRANCH にマージしますか？"; then
      gh pr merge "$PR_NUM" --merge
      echo "✅ PR #$PR_NUM をマージしました"
    else
      echo "⏭ マージをスキップしました（PR #$PR_NUM は未マージ）"
    fi
  fi
fi

echo "🎉 完了"
