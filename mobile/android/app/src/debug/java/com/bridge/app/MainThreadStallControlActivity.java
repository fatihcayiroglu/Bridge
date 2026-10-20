package com.bridge.app;

// Android #209 AN00: DEBUG-ONLY deterministic ANR control. Right after its
// first traversal (the window exists and is about to receive focus, as at a
// cold start's first frame) it blocks its own main thread once, for a bounded
// time, so the emulator harness can observe how Android declares, shows and
// ends an input ANR on this image: when the ANR is declared, whether the ANR
// dialog outlives the stall, and what a HOME press then does to the process.
// No Bridge code, no WebView, no I/O. Fixed log markers only.
public final class MainThreadStallControlActivity extends android.app.Activity {
    static final String LOG_TAG = "BridgeStallControl";
    static final long MIN_STALL_MS = 1_000L;
    static final long MAX_STALL_MS = 30_000L;

    static long boundedStallMs(long requested) {
        return Math.max(MIN_STALL_MS, Math.min(MAX_STALL_MS, requested));
    }

    @Override
    protected void onCreate(android.os.Bundle state) {
        super.onCreate(state);
        final long stallMs = boundedStallMs(getIntent().getLongExtra("stallMs", 7_000L));
        getWindow().getDecorView().post(() -> {
            android.util.Log.i(LOG_TAG, "stage=stall-begin stallMs=" + stallMs);
            android.os.SystemClock.sleep(stallMs);
            android.util.Log.i(LOG_TAG, "stage=stall-end");
        });
    }
}
