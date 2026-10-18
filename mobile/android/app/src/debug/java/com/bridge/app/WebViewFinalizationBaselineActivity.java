package com.bridge.app;

// Android #209: DEBUG-only causal control for the FontsProvider stable ref.
// Same inert about:blank WebView as WebViewBaselineActivity (FD00W), but the
// WebView stays attached, navigated and strongly referenced for the whole
// Activity lifetime. After a fixed delay, run the PRODUCTION finalization
// pass off the main thread. A stable ref that disappears while this WebView
// is alive was held by unreachable garbage, not by the live WebView.
// No Bridge web assets, Capacitor plugins, JavaScript, network or GMS calls.
public final class WebViewFinalizationBaselineActivity extends android.app.Activity {
    private android.webkit.WebView view;
    private final android.os.Handler mainHandler =
            new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable finalizationPass = this::startFinalizationPass;

    @Override
    public void onCreate(android.os.Bundle state) {
        super.onCreate(state);
        view = new android.webkit.WebView(this);
        setContentView(view);
        view.loadUrl("about:blank");
        // The harness samples before this (stable ref expected on WebView 113)
        // and again > 1 s after the marker (ActivityThread's retain window).
        mainHandler.postDelayed(finalizationPass, 6000L);
    }

    private void startFinalizationPass() {
        final boolean attached = view != null && view.isAttachedToWindow();
        Thread worker = new Thread(() -> {
            WebViewFontProviderRelease.runFinalizationPass();
            // Fixed, debug-only marker; no PID, user data, URLs or raw process data.
            android.util.Log.i("BridgeWebViewFinalization",
                    "stage=finalized webViewAttached=" + attached);
        }, "BridgeWebViewFinalization");
        worker.setDaemon(true);
        worker.start();
    }

    @Override
    protected void onDestroy() {
        mainHandler.removeCallbacks(finalizationPass);
        if (view != null) {
            view.destroy();
            view = null;
        }
        super.onDestroy();
    }
}
