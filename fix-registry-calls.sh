#!/bin/bash
# Fix BridgeRegistry.register() calls - replace }; with });

for file in client/js/{threads,mobile,slash,discover,federation-modal,federation-ui}.ts; do
  if [[ -f "$file" ]]; then
    # Fix BridgeRegistry.register calls with }; endings
    sed -i '' "/BridgeRegistry.register/,/^  };$/s/};$/});/" "$file"
  fi
done

echo "✅ Fixed BridgeRegistry.register() calls"
