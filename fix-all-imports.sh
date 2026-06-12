#!/bin/bash
# Fix all core module imports - add -svelte suffix where needed

cd client/js

# List of modules that need -svelte suffix
MODULES=(
  "socket"
  "group-dm-core"
  "error-boundary"
  "state"
  "theme"
  "globals"
  "onboarding-wizard"
  "onboarding"
  "mobile-ux"
  "a11y-wcag-aa"
  "stage-video-grid"
  "boost"
  "desktop-voice-bar"
  "boost-ui"
  "spotify-widget"
  "e2ee-toggle"
  "analytics-dashboard"
  "announcement-ui"
  "settings-modal-voice"
)

for file in *.ts core/**/*.ts; do
  if [[ ! -f "$file" ]]; then continue; fi
  
  for module in "${MODULES[@]}"; do
    # Replace ./core/module.ts with ./core/module-svelte.ts (if not already)
    sed -i '' "s|from '['\'']\./core/${module}\.ts['\'']\"|from './core/${module}-svelte.ts'|g" "$file"
    sed -i '' "s|from \"./core/${module}\.ts\"|from \"./core/${module}-svelte.ts\"|g" "$file"
    
    # Also replace ./core/module.js with ./core/module-svelte.ts
    sed -i '' "s|from '['\'']\./core/${module}\.js['\'']\"|from './core/${module}-svelte.ts'|g" "$file"
    sed -i '' "s|from \"./core/${module}\.js\"|from \"./core/${module}-svelte.ts\"|g" "$file"
    
    # Replace imports without from (like import './core/module.js')
    sed -i '' "s|import '['\'']\./core/${module}\.js['\'']\"|import './core/${module}-svelte.ts'|g" "$file"
    sed -i '' "s|import \"./core/${module}\.js\"|import \"./core/${module}-svelte.ts\"|g" "$file"
  done
done

echo "✅ Fixed all core module imports"
