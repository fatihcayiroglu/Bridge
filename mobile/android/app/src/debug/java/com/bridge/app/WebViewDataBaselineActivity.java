package com.bridge.app;

// #209: DEBUG-ONLY local-document counterfactual to about:blank navigation.
// No Bridge assets, no JS, no network, no Capacitor. Android WebView creates a
// minimal inline HTML document through loadDataWithBaseURL(). Compare FD00D
// against FD00W (loadUrl("about:blank")) and FD00C/A (no navigation).
// Measured only; must never substitute for the strict FD01 gate.
public final class WebViewDataBaselineActivity extends android.app.Activity {
    private android.webkit.WebView view;

    @Override
    public void onCreate(android.os.Bundle state) {
        super.onCreate(state);
        view = new android.webkit.WebView(this);
        setContentView(view);
        view.getSettings().setJavaScriptEnabled(false);
        view.loadDataWithBaseURL(
                null, "<!doctype html><html><head></head><body></body></html>",
                "text/html", "UTF-8", null);
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
