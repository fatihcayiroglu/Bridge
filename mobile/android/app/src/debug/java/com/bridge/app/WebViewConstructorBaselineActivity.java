package com.bridge.app;

// #209: isolate the WebView CONSTRUCTOR from navigation and attachment.
// Debug-only. No JS, URL request, setContentView or Capacitor/plugin startup.
// A separate force-stopped launch of WebViewBaselineActivity loads about:blank.
public final class WebViewConstructorBaselineActivity extends android.app.Activity {
    private android.webkit.WebView view;

    @Override
    public void onCreate(android.os.Bundle state) {
        super.onCreate(state);
        view = new android.webkit.WebView(this);
        // Deliberately don't attach the view or navigate anywhere.
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
