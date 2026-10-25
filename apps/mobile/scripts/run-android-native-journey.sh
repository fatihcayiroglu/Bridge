#!/usr/bin/env bash
set -euo pipefail

# reactivecircus/android-emulator-runner executes separate script lines in
# independent shells. Keep directory changes, adb reverse and test assertions
# in this single shell so the Gradle wrapper path is never lost.
adb reverse tcp:8081 tcp:8081
cd apps/mobile/android
./gradlew --no-daemon -PreactNativeArchitectures=x86_64 :app:connectedDebugAndroidTest
python3 ../scripts/verify_native_results.py --junit-dir app/build/outputs/androidTest-results/connected --expected 1
