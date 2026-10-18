package com.bridge.app;

// Android #209 / FD00P: isolated DEBUG-only AppCompat Activity control.
// This Activity does not construct a WebView, create Capacitor plugins,
// load Bridge JS, request emoji fonts, or access any user/account data.
// It distinguishes AppCompat's Activity startup from a plain Android
// Activity (FD00) and direct android.webkit.WebView startup (FD00C/A/N/W).
// No test is passed/waived based on this measurement.
public final class AppCompatBaselineActivity extends androidx.appcompat.app.AppCompatActivity {
    @Override
    public void onCreate(android.os.Bundle state) {
        super.onCreate(state);
        // Deliberately no content view, WebView, or font API call.
    }
}
