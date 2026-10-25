# Bridge native preview

Single React Native New Architecture application for Android and iOS. This is
an isolated P8 preview (`com.bridge.nativepreview`), not the production Capacitor
application. It currently implements server verification only.

See [P8 migration and acceptance ledger](../../docs/P8_REACT_NATIVE_MIGRATION.md)
for tool versions, commands, evidence boundaries and all remaining parity work.

Install dependencies with `npm ci` in this directory. On macOS, use Ruby 3.3,
`bundle install`, then `cd ios && bundle exec pod install`. Start Metro with
`npm start`; use `npm run android` or `npm run ios` from a second terminal.
No production credentials or signing keys are needed for the preview.
