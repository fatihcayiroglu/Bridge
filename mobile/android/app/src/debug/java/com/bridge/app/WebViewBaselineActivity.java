package com.bridge.app;

// #209: separate the Android framework baseline from a minimal WebView startup.
// This is a DEBUG-only diagnostic component. It never loads Bridge content,
// enables JavaScript, accesses the network, or creates Capacitor plugins.
public final class WebViewBaselineActivity extends android.app.Activity {
    private android.webkit.WebView view;

    @Override
    public void onCreate(android.os.Bundle state) {
        super.onCreate(state);
        view = new android.webkit.WebView(this);
        setContentView(view);
        view.loadUrl("about:blank");
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
