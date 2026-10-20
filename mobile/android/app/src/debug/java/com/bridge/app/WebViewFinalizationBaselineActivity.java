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
    // the pass" from "log not captured"; stalled/uncaught say where it stuck
    // or why the process is about to die; instance exposes a relaunch.
    private static final String TAG = "BridgeFinalizeProbe";
    private static final java.util.concurrent.atomic.AtomicInteger INSTANCES =
            new java.util.concurrent.atomic.AtomicInteger();
    private android.webkit.WebView view;
    private final android.os.Handler mainHandler =
            new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable finalizationPass = this::startFinalizationPass;
    private final java.util.concurrent.atomic.AtomicBoolean finalized =
            new java.util.concurrent.atomic.AtomicBoolean();
    private volatile Thread worker;
    private final Runnable stallCheck = this::reportStall;

    @Override
    public void onCreate(android.os.Bundle state) {
        super.onCreate(state);
        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try {
                android.util.Log.i(TAG, "stage=uncaught " + FinalizationStallProbe.uncaughtMarker(error));
            } finally {
                // Android's own handler records the crash and kills the process.
                if (previous != null) previous.uncaughtException(thread, error);
            }
        });
        view = new android.webkit.WebView(this);
        setContentView(view);
        view.loadUrl("about:blank");
        // The harness samples before this (stable ref expected on WebView 113)
        // and again > 1 s after the marker (ActivityThread's retain window).
        mainHandler.postDelayed(finalizationPass, 6000L);
        android.util.Log.i(TAG, "stage=scheduled instance=" + INSTANCES.incrementAndGet());
    }

    private void startFinalizationPass() {
        final boolean attached = view != null && view.isAttachedToWindow();
        android.util.Log.i(TAG, "stage=started webViewAttached=" + attached);
        Thread pass = new Thread(() -> {
            long started = android.os.SystemClock.elapsedRealtime();
            WebViewFontProviderRelease.runFinalizationPass();
            long passMs = android.os.SystemClock.elapsedRealtime() - started;
            finalized.set(true);
            android.util.Log.i(TAG, "stage=finalized passMs=" + Math.min(passMs, 999_999L));
        }, "BridgeFinalize");
        pass.setDaemon(true);
        worker = pass;
        pass.start();
        // Inside FinalizerWatchdog's 10 s limit, so a stuck finalizer is
        // still on the FinalizerDaemon stack when we look.
        mainHandler.postDelayed(stallCheck, 5000L);
    }

    private void reportStall() {
        if (finalized.get()) return;
        Thread.State passState = null;
        StackTraceElement[] passFrames = null;
        Thread.State daemonState = null;
        StackTraceElement[] daemonFrames = null;
        Thread.State queueState = null;
        StackTraceElement[] queueFrames = null;
        for (java.util.Map.Entry<Thread, StackTraceElement[]> e : Thread.getAllStackTraces().entrySet()) {
            Thread t = e.getKey();
            if (t == worker) {
                passState = t.getState();
                passFrames = e.getValue();
            } else if ("FinalizerDaemon".equals(t.getName())) {
                daemonState = t.getState();
                daemonFrames = e.getValue();
            } else if ("ReferenceQueueDaemon".equals(t.getName())) {
                queueState = t.getState();
                queueFrames = e.getValue();
            }
        }
        android.util.Log.i(TAG, "stage=stalled " + FinalizationStallProbe.stallMarker(
                passState, passFrames, daemonState, daemonFrames, queueState, queueFrames));
    }

    @Override
    protected void onDestroy() {
        mainHandler.removeCallbacks(finalizationPass);
        mainHandler.removeCallbacks(stallCheck);
        if (view != null) {
            view.destroy();
            view = null;
        }
        super.onDestroy();
    }
}
