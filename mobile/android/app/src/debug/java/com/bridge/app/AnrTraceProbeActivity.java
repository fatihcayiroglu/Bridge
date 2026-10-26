package com.bridge.app;

// Android #209: DEBUG-only, end-of-journey reader of this package's OWN fatal
// ANR records (ApplicationExitInfo REASON_ANR, Android 11+). Each trace is
// reduced in memory by AnrTraceClassifier; only fixed enums are logged,
// including separate operations for the top Java frame and first owner.
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
        int records = 0;
        boolean oldestBeforeStart = false;
        // Platform retention cap (AOSP default 16); -1 when not readable.
        int capacity = -1;
        try {
            android.content.res.Resources system = android.content.res.Resources.getSystem();
            int id = system.getIdentifier("config_app_exit_info_history_list_size", "integer", "android");
            if (id != 0) capacity = system.getInteger(id);
        } catch (RuntimeException e) {
            capacity = -1;
        }
        try {
            android.app.ActivityManager am = getSystemService(android.app.ActivityManager.class);
            // maxNum 0 = every retained record. Android keeps a bounded history
            // per package, so report whether it still reaches back before the
            // journey; if not, early in-journey exits may have been evicted.
            java.util.List<android.app.ApplicationExitInfo> exits =
                    am.getHistoricalProcessExitReasons(null, 0, 0);
            records = exits.size();
            for (android.app.ApplicationExitInfo exit : exits) {
                if (exit.getTimestamp() < since) oldestBeforeStart = true;
            }
            for (android.app.ApplicationExitInfo exit : exits) {
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
                        + " " + result.marker() + " " + result.operationMarker());
            }
        } catch (RuntimeException e) {
            android.util.Log.i(TAG, "stage=done supported=true error=true anrExits=" + anrs
                    + " records=" + records + " oldestBeforeStart=" + oldestBeforeStart
                    + " capacity=" + capacity);
            return;
        }
        android.util.Log.i(TAG, "stage=done supported=true error=false anrExits=" + anrs
                + " records=" + records + " oldestBeforeStart=" + oldestBeforeStart
                + " capacity=" + capacity);
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
