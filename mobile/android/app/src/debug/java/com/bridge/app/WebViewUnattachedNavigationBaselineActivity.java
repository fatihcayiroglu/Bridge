package com.bridge.app;

// #209 DEBUG-only differential: load about:blank without attaching WebView.
// Construction is FD00C, attachment without navigation is FD00A, both are
// FD00N's separate force-stopped controls. This never runs in release builds.
public final class WebViewUnattachedNavigationBaselineActivity extends android.app.Activity {
    private android.webkit.WebView view;

    @Override
    public void onCreate(android.os.Bundle state) {
        super.onCreate(state);
        view = new android.webkit.WebView(this);
        // Intentionally navigate but never setContentView(view).
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
