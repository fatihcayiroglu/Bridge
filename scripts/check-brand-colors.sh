#!/usr/bin/env bash
# Discord mor paletinin projeye geri girmesini engeller.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FORBIDDEN='#5865[fF]2|#7289[dD]a|#4752[Cc]4'
FOUND=$(grep -rniE "$FORBIDDEN" "$ROOT" \
  --include='*.ts' --include='*.js' --include='*.css' --include='*.html' --include='*.svelte' \
  --exclude-dir=node_modules \
  --exclude-dir=discord-shim \
  2>/dev/null || true)
if [ -n "$FOUND" ]; then
  echo "❌ Yasaklı Discord renkleri bulundu (Bridge markası: #2d9cdb):"
  echo "$FOUND"
  exit 1
fi
echo "✅ Marka renk kontrolü geçti"
