package com.bridge.app;

// Android #209: DEBUG-only causal control for the FontsProvider stable ref.
// Same inert about:blank WebView as WebViewBaselineActivity (FD00W), but the
// WebView stays attached, navigated and strongly referenced for the whole
// Activity lifetime. After a fixed delay, run the PRODUCTION finalization
// pass off the main thread. A stable ref that disappears while this WebView
// is alive was held by unreachable garbage, not by the live WebView.
// No Bridge web assets, Capacitor plugins, JavaScript, network or GMS calls.
public final class WebViewFinalizationBaselineActivity extends android.app.Activity {
    // Fixed, debug-only markers; no PID, user data, URLs or raw process data.
    // scheduled -> started -> finalized tells "never ran" from "blocked in
    // the pass" from "log not captured" when the harness misses a marker.
    private static final String TAG = "BridgeFinalizeProbe";
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
        android.util.Log.i(TAG, "stage=scheduled");
    }

    private void startFinalizationPass() {
        final boolean attached = view != null && view.isAttachedToWindow();
        android.util.Log.i(TAG, "stage=started webViewAttached=" + attached);
        Thread worker = new Thread(() -> {
            long started = android.os.SystemClock.elapsedRealtime();
            WebViewFontProviderRelease.runFinalizationPass();
            long passMs = android.os.SystemClock.elapsedRealtime() - started;
            android.util.Log.i(TAG, "stage=finalized passMs=" + Math.min(passMs, 999_999L));
        }, "BridgeFinalize");
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
