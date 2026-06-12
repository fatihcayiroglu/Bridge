#!/bin/bash
# Fix imports from .js to .ts

# Find and replace .js imports with .ts in all TypeScript files
find client/js -name "*.ts" -type f | while read file; do
  # Replace imports that point to .js files
  sed -i '' "s/from '\(\..*\)\.js'/from '\1.ts'/g" "$file"
  sed -i '' 's/from "\(\..*\)\.js"/from "\1.ts"/g' "$file"
done

echo "✅ Fixed .js to .ts imports"
