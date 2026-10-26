package com.bridge.app;

import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.util.Printer;

/**
 * Android #209: DEBUG-only. CS01's Choreographer evidence (SF01) showed
 * main-thread stalls of up to 357 frames at every cold start; Choreographer
 * cannot say what the thread was doing. For the first {@link WINDOW_MS} of a
 * process this times every main-Looper dispatch and, while one runs past
 * {@link SAMPLE_AFTER_MS}, samples the main thread's stack every
 * {@link SAMPLE_EVERY_MS}. Dispatches of at least {@link REPORT_MS} are logged
 * as fixed categories only (see {@link MainThreadStallClassifier}).
 *
 * Perturbation: the Looper printer builds a string per message while
 * installed, and stack sampling briefly suspends the main thread. Both are
 * bounded to the window and are debug-only; the measurement is an upper
 * bound on, not an exact copy of, release behaviour.
 */
final class MainThreadStallProbe {
    static final String TAG = "BridgeStallProbe";
    static final long WINDOW_MS = 90_000L;
    static final long REPORT_MS = 250L;
    static final long SAMPLE_AFTER_MS = 100L;
    static final long SAMPLE_EVERY_MS = 50L;
    static final String[] KINDS = {
        "sleep", "binder", "gc", "io", "font", "classload", "inflate", "webview", "capacitor", "bridge",
        "render", "layout", "frame", "lifecycle", "other", "idle", "none",
    };

    private static final Object LOCK = new Object();
    private static volatile long dispatchStart; // 0 while the main thread is between messages
    private static String dispatchCategory = "unknown";
    private static final int[] whereCounts = new int[KINDS.length];
    private static final int[] viaCounts = new int[4]; // bridge, capacitor, webview, none
    private static int stalls;
    private static long maxMs;
    private static boolean installed;

    private MainThreadStallProbe() {}

    static void install() {
        synchronized (LOCK) {
            if (installed) return;
            installed = true;
        }
        final Looper main = Looper.getMainLooper();
        final Thread mainThread = main.getThread();
        final long installedAt = SystemClock.uptimeMillis();
        main.setMessageLogging(new Printer() {
            @Override
            public void println(String line) {
                if (line == null) return;
                if (line.startsWith(">>>>> Dispatching")) {
                    synchronized (LOCK) {
                        dispatchCategory = MainThreadStallClassifier.message(line);
                        java.util.Arrays.fill(whereCounts, 0);
                        java.util.Arrays.fill(viaCounts, 0);
                    }
                    dispatchStart = SystemClock.uptimeMillis();
                } else if (line.startsWith("<<<<< Finished")) {
                    long start = dispatchStart;
                    dispatchStart = 0;
                    if (start == 0) return;
                    long ms = SystemClock.uptimeMillis() - start;
                    if (ms >= REPORT_MS) report(ms);
                    if (SystemClock.uptimeMillis() - installedAt > WINDOW_MS) uninstall(main);
                }
            }
        });
        Thread sampler = new Thread(() -> {
            while (SystemClock.uptimeMillis() - installedAt <= WINDOW_MS + 5_000L) {
                SystemClock.sleep(SAMPLE_EVERY_MS);
                long start = dispatchStart;
                if (start == 0 || SystemClock.uptimeMillis() - start < SAMPLE_AFTER_MS) continue;
                StackTraceElement[] frames;
                try {
                    frames = mainThread.getStackTrace();
                } catch (RuntimeException e) {
                    continue;
                }
                String where = MainThreadStallClassifier.where(frames);
                String via = MainThreadStallClassifier.via(frames);
                synchronized (LOCK) {
                    if (dispatchStart != start) continue; // that dispatch already ended
                    whereCounts[index(where)]++;
                    viaCounts["bridge".equals(via) ? 0 : "capacitor".equals(via) ? 1 : "webview".equals(via) ? 2 : 3]++;
                }
            }
        }, "BridgeStallProbe");
        sampler.setDaemon(true);
        sampler.setPriority(Thread.MAX_PRIORITY);
        sampler.start();
        Log.i(TAG, "event=installed windowMs=" + WINDOW_MS + " reportMs=" + REPORT_MS);
    }

    private static int index(String kind) {
        for (int i = 0; i < KINDS.length; i++) if (KINDS[i].equals(kind)) return i;
        return index("other");
    }

    private static void report(long ms) {
        String line;
        synchronized (LOCK) {
            stalls++;
            maxMs = Math.max(maxMs, ms);
            int samples = 0;
            for (int c : whereCounts) samples += c;
            line = marker(ms, dispatchCategory,
                    MainThreadStallClassifier.dominant(KINDS, whereCounts),
                    MainThreadStallClassifier.dominant(new String[] {"bridge", "capacitor", "webview", "none"}, viaCounts),
                    samples);
        }
        Log.i(TAG, line);
    }

    /** Fixed-format, categories and numbers only. */
    static String marker(long ms, String msg, String where, String via, int samples) {
        return "event=stall ms=" + Math.min(ms, 999_999L) + " msg=" + msg + " where=" + where
                + " via=" + via + " samples=" + Math.min(samples, 9_999);
    }

    private static void uninstall(Looper main) {
        main.setMessageLogging(null);
        synchronized (LOCK) {
            Log.i(TAG, "event=uninstalled stalls=" + stalls + " maxMs=" + Math.min(maxMs, 999_999L));
        }
    }
}
