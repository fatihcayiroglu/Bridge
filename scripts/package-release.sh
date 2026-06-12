#!/usr/bin/env bash
# Dağıtım zip'i oluşturur — node_modules ve gizli dosyalar hariç.
# Yerel geliştirme klasörüne dokunmaz (sadece OS artıklarını temizler).
#
# Kullanım:
#   ./scripts/package-release.sh
#   ./scripts/package-release.sh ~/Desktop/bridge_s107.zip

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$(dirname "$ROOT")/bridge_s107.zip}"
NAME="$(basename "$ROOT")"

echo "📦 Paketleniyor: $NAME → $OUT"

# Zip öncesi hafif temizlik (node_modules'a dokunma)
find "$ROOT" -name '.DS_Store' -delete 2>/dev/null || true
find "$ROOT" -name '._*' -delete 2>/dev/null || true

cd "$(dirname "$ROOT")"
rm -f "$OUT"

zip -r "$OUT" "$NAME" \
  -x "*/node_modules/*" \
  -x "*/.DS_Store" \
  -x "*/._*" \
  -x "*/__MACOSX/*" \
  -x "*/coverage/*" \
  -x "*/.nyc_output/*" \
  -x "*/server/dist/*" \
  -x "*/client/dist/*" \
  -x "*/electron/dist/*" \
  -x "*/.env" \
  -x "*/.env.local" \
  -x "*/.env.production" \
  -x "*/.env.*.local" \
  -x "*/server/uploads/*" \
  -x "*/server/uploads/_quarantine/*" \
  -x "*/.git/*" \
  -x "*/npm-debug.log*" \
  -x "*/yarn-error.log*" \
  -x "*/logs/*" \
  -x "*.log" \
  -x "*.zip"

# .gitkeep dosyalarını zip'e ekle (uploads boş klasör yapısı)
if [ -f "$ROOT/server/uploads/.gitkeep" ]; then
  zip -u "$OUT" "$NAME/server/uploads/.gitkeep" "$NAME/server/uploads/_quarantine/.gitkeep" 2>/dev/null || true
fi

SIZE="$(du -sh "$OUT" | cut -f1)"
echo "✅ Tamam: $OUT ($SIZE)"
echo "   Kurulum: DISTRIBUTION.md dosyasına bakın"
