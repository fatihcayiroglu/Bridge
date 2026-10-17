package com.bridge.app;

// Android #209: DEBUG-ONLY, nonproduct WebView lifetime isolation.
// Run JavaScript-disabled local HTML navigation, then remove and destroy
// the WebView while keeping the same foreground Activity/process alive.
// No Bridge web assets, Capacitor plugins, network requests or font APIs.
public final class WebViewTeardownBaselineActivity extends android.app.Activity {
    private android.widget.FrameLayout root;
    private android.webkit.WebView view;
    private final android.os.Handler mainHandler =
            new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable teardown = () -> releaseWebView();

    @Override
    public void onCreate(android.os.Bundle state) {
        super.onCreate(state);
        root = new android.widget.FrameLayout(this);
        setContentView(root);
        view = new android.webkit.WebView(this);
        view.getSettings().setJavaScriptEnabled(false);
        root.addView(view);
        view.loadDataWithBaseURL(
                null, "<!doctype html><html><head></head><body></body></html>",
                "text/html", "UTF-8", null);
        // Sample once with navigation active, again after this callback.
        // The Activity stays alive throughout; no process kill or GMS changes.
        mainHandler.postDelayed(teardown, 3500L);
    }

    private void releaseWebView() {
        if (view == null) return;
        root.removeView(view);
        view.destroy();
        view = null;
        // Fixed, debug-only marker; no PID, user data, URLs or raw process data.
        android.util.Log.i("BridgeWebViewTeardown", "stage=destroyed");
    }

    @Override
    protected void onDestroy() {
        mainHandler.removeCallbacks(teardown);
        releaseWebView();
        super.onDestroy();
    }
}
