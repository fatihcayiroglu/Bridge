#!/usr/bin/env bash
# scripts/cleanup-compiled-js.sh
# client/js/ altındaki derlenmiş .js dosyalarını git'ten kaldırır.
# .gitignore zaten bunları engeller; bu script geçmiş commitlerdeki
# izlemeyi durdurur. Bir kez çalıştırılır.
#
# Kullanım:
#   bash scripts/cleanup-compiled-js.sh

set -e

echo "client/js/**/*.js dosyaları git takibinden kaldırılıyor..."

git ls-files --error-unmatch 'client/js/**/*.js' 2>/dev/null || {
  echo "Zaten izlenmiyor veya bu dosyalar git'te yok. Çıkılıyor."
  exit 0
}

# rnnoise-worklet.js elle yazılmış — izlenmeye devam etsin
git rm --cached -r --quiet 'client/js/*.js' 2>/dev/null || true
git rm --cached -r --quiet 'client/js/**/*.js' 2>/dev/null || true

# Elle yazılmış olanı geri ekle
git add -f client/js/core/rnnoise-worklet.js 2>/dev/null || true

echo ""
echo "Tamamlandı. Şimdi commit at:"
echo "  git commit -m 'chore: compiled JS files removed from tracking (use npm run build)'"
echo ""
echo "Dikkat: Bu işlem diğer branch'lerde merge conflict yaratabilir."
echo "Tüm branch'lerde 'git pull --rebase' önerilir."
