#!/usr/bin/env bash
set -Eeuo pipefail

npx jest \
  tests/badges.test.ts \
  tests/discover2.test.ts \
  tests/mediasoup-handlers.test.ts \
  tests/webauthn.test.ts \
  tests/stage-socket.test.ts \
  tests/federation-social.test.ts \
  tests/httpSignature.test.ts \
  --runInBand \
  --forceExit
