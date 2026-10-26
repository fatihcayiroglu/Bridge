package com.bridge.app;

// CR00: DEBUG-only calibration of the failure-evidence pipeline. Invoked only
// after product journeys, never the launcher. Finishes before throwing so a
// background Java crash can terminate without an interactive crash dialog.
// No Bridge/WebView, account data, network, arbitrary extras or user messages.
public final class JavaCrashControlActivity extends android.app.Activity {
    @Override
    protected void onCreate(android.os.Bundle state) {
        super.onCreate(state);
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
            throw new IllegalStateException("Bridge debug Java crash control");
        }, 500L);
        finish();
    }
}
