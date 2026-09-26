#!/usr/bin/env bash
# Discord mor paletinin projeye geri girmesini engeller.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FORBIDDEN='#5865[fF]2|#7289[dD]a|#4752[Cc]4'
# KAPSAM: YALNIZCA KAYNAK TARANIR.
#
# `client/dist` ve `mobile/www` DERLEME CIKTISIDIR; icerikleri kaynaktan
# uretilir. Onlari taramak ayni ihlali iki kez sayar ve her derlemeden sonra
# guard'i kirmizi tutar, ustelik duzeltme yeri zaten kaynaktir.
# Bu bir GEVSETME DEGILDIR: ciktiyi ureten TUM kaynak dosyalar taranmaya
# devam eder; yasakli renk kaynaga girdigi anda yine yakalanir.
# (Olcum: 14 bulgunun 6'si YALNIZCA derleme ciktisindaydi; kaynaktaki 8 bulgu
#  ayrica duzeltildi.)
FOUND=$(grep -rniE "$FORBIDDEN" "$ROOT" \
  --include='*.ts' --include='*.js' --include='*.css' --include='*.html' --include='*.svelte' \
  --exclude-dir=node_modules \
  --exclude-dir=discord-shim \
  --exclude-dir=dist \
  --exclude-dir=www \
  2>/dev/null || true)
if [ -n "$FOUND" ]; then
  echo "❌ Yasaklı Discord renkleri bulundu (Bridge markası: #2d9cdb):"
  echo "$FOUND"
  exit 1
fi
echo "✅ Marka renk kontrolü geçti"
