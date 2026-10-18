package com.bridge.app;

// Android #209: isolated DEBUG-ONLY baseline to distinguish the platform/native
// Activity process from the Capacitor BridgeActivity + WebView initialization.
// Never referenced by release code, never makes font/ContentResolver requests,
// never opens WebView or a user/account datastore. The emulator harness observes
// only allowlisted Android ActivityManager provider counts.
public final class FontBaselineActivity extends android.app.Activity {
    @Override
    public void onCreate(android.os.Bundle state) {
        super.onCreate(state);
        android.util.Log.i("BridgeFontBaseline", "native-only-activity-created");
    }
}
