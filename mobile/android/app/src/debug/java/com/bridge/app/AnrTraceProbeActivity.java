package com.bridge.app;

// Android #209: DEBUG-only, end-of-journey reader of this package's OWN fatal
// ANR records (ApplicationExitInfo REASON_ANR, Android 11+). Each trace is
// reduced in memory by AnrTraceClassifier; only fixed enums are logged.
// The trace itself, PIDs, timestamps and process names never leave this
// process. Started by the harness with --el sinceEpochMs <device ms>.
public final class AnrTraceProbeActivity extends android.app.Activity {
    private static final String TAG = "BridgeAnrTraceProbe";
    private static final int MAX_EXITS = 5;
    private static final int MAX_TRACE_CHARS = 1 << 20;

    @Override
    public void onCreate(android.os.Bundle state) {
        super.onCreate(state);
        final long since = getIntent().getLongExtra("sinceEpochMs", Long.MAX_VALUE);
        Thread worker = new Thread(() -> {
            probe(since);
            runOnUiThread(this::finish);
        }, TAG);
        worker.setDaemon(true);
        worker.start();
    }

    private void probe(long since) {
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.R) {
            android.util.Log.i(TAG, "stage=done supported=false anrExits=0");
            return;
        }
        int anrs = 0;
        try {
            android.app.ActivityManager am = getSystemService(android.app.ActivityManager.class);
            for (android.app.ApplicationExitInfo exit : am.getHistoricalProcessExitReasons(null, 0, 16)) {
                if (exit.getReason() != android.app.ApplicationExitInfo.REASON_ANR
                        || exit.getTimestamp() < since) continue;
                if (++anrs > MAX_EXITS) continue;
                String trace = null;
                try (java.io.InputStream in = exit.getTraceInputStream()) {
                    if (in != null) trace = readBounded(in);
                } catch (java.io.IOException | RuntimeException e) {
                    trace = null;
                }
                AnrTraceClassifier.Result result = AnrTraceClassifier.classify(trace);
                android.util.Log.i(TAG, "stage=exit traceAvailable=" + (trace != null)
                        + " " + result.marker());
            }
        } catch (RuntimeException e) {
            android.util.Log.i(TAG, "stage=done supported=true error=true anrExits=" + anrs);
            return;
        }
        android.util.Log.i(TAG, "stage=done supported=true error=false anrExits=" + anrs);
    }

    private static String readBounded(java.io.InputStream in) throws java.io.IOException {
        java.io.Reader reader = new java.io.InputStreamReader(in, java.nio.charset.StandardCharsets.UTF_8);
        StringBuilder out = new StringBuilder();
        char[] buf = new char[8192];
        int n;
        while (out.length() < MAX_TRACE_CHARS && (n = reader.read(buf)) > 0) {
            out.append(buf, 0, Math.min(n, MAX_TRACE_CHARS - out.length()));
        }
        return out.toString();
    }
}
