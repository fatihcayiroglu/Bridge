package com.bridge.app;

// #209 debug-only differential: WebView attached to the Activity window, but
// NO page navigation, JavaScript enablement, Bridge assets or Capacitor plugins.
// Compare isolated FD00C (constructor only), FD00A (attached, no load), FD00W.
public final class WebViewAttachedBaselineActivity extends android.app.Activity {
    private android.webkit.WebView view;

    @Override
    public void onCreate(android.os.Bundle state) {
        super.onCreate(state);
        view = new android.webkit.WebView(this);
        setContentView(view);
        // No page navigation; only window attachment is under test.
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
