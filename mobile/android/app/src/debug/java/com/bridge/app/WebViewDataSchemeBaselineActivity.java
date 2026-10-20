package com.bridge.app;

// Android #209: DEBUG-ONLY non-network data:-scheme navigation control.
// Distinct from loadDataWithBaseURL(null, ...), whose base URL is about:blank.
// No Bridge/Capacitor assets, no script execution, fonts API, or GMS calls.
// This is a measurement, never a substitute for strict FD01 or ANR01.
public final class WebViewDataSchemeBaselineActivity extends android.app.Activity {
    private android.webkit.WebView view;

    @Override
    public void onCreate(android.os.Bundle state) {
        super.onCreate(state);
        view = new android.webkit.WebView(this);
        setContentView(view);
        view.getSettings().setJavaScriptEnabled(false);
        final String document = "<!doctype html><html><head></head><body></body></html>";
        final String encoded = android.util.Base64.encodeToString(
                document.getBytes(java.nio.charset.StandardCharsets.US_ASCII),
                android.util.Base64.NO_WRAP);
        view.loadData(encoded, "text/html", "base64");
    }

    @Override
    protected void onDestroy() {
        if (view != null) {
            view.destroy();
            view = null;
        }
        super.onDestroy();
    }
}
