package com.bridge.app;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Android #209: DEBUG-only reduction of "where is the FD00G finalization pass
 * stuck?" to fixed categories. Covers the pass thread, ART's FinalizerDaemon
 * (which runs finalize() methods) and an uncaught exception such as the
 * FinalizerWatchdogDaemon's TimeoutException. No frame, class, message or
 * other free text is ever returned.
 */
final class FinalizationStallProbe {
    // ART FinalizerWatchdogDaemon messages: "<class>.finalize() timed out after
    // N seconds", "<cleaner action class> timed out after N seconds", "Unknown
    // finalizer timed out", and "ReferenceQueueDaemon timed out ...".
    private static final Pattern FINALIZER_TIMEOUT =
            Pattern.compile("^([A-Za-z0-9_$.]{1,200}?)(?:\\.finalize\\(\\))? timed out after \\d{1,4} seconds?$");

    private FinalizationStallProbe() {}

    /** Where a thread is: inside which owner's finalize(), a binder call, GC, waiting, idle. */
    static String where(StackTraceElement[] frames) {
        if (frames == null || frames.length == 0) return "none";
        boolean binder = false;
        for (StackTraceElement f : frames) {
            if ("android.os.BinderProxy".equals(f.getClassName())
                    && f.getMethodName().startsWith("transact")) binder = true;
            if ("finalize".equals(f.getMethodName())) {
                return "finalizer-" + ownerOf(f.getClassName()) + (binder ? "+binder" : "");
            }
        }
        if (binder) return "binder";
        for (StackTraceElement f : frames) {
            String c = f.getClassName();
            String m = f.getMethodName();
            if (c.equals("java.lang.ref.FinalizerReference$Sentinel") && m.equals("awaitFinalization")) {
                return "await-finalization";
            }
            if ((c.equals("java.lang.Runtime") && (m.equals("gc") || m.equals("nativeGc")))
                    || c.equals("dalvik.system.VMRuntime") && m.equals("requestConcurrentGC")) {
                return "gc";
            }
            if (c.equals("java.lang.ref.ReferenceQueue") && m.startsWith("remove")) return "idle-queue";
        }
        return "other";
    }

    /** Category of the class whose finalize() is running. */
    static String ownerOf(String className) {
        if (className.equals("android.os.ParcelFileDescriptor")
                || className.equals("android.content.ContentResolver$ParcelFileDescriptorInner")) return "pfd";
        if (className.startsWith("android.database.")
                || className.equals("android.content.ContentResolver$CursorWrapperInner")) return "cursor";
        if (className.startsWith("org.chromium.") || className.startsWith("com.android.webview.")) return "webview";
        if (className.startsWith("com.bridge.app.")) return "bridge";
        if (className.startsWith("android.") || className.startsWith("com.android.internal.")
                || className.startsWith("java.") || className.startsWith("dalvik.")
                || className.startsWith("libcore.") || className.startsWith("sun.")) return "framework";
        return "other";
    }

    static String state(Thread.State state) {
        return state == null ? "missing" : state.name();
    }

    /**
     * Fixed marker body for a stall snapshot. ReferenceQueueDaemon is included
     * because it delivers runFinalization()'s sentinel to the FinalizerDaemon:
     * if it is stuck, the FinalizerDaemon looks idle while the pass waits.
     */
    static String stallMarker(Thread.State passState, StackTraceElement[] passFrames,
            Thread.State daemonState, StackTraceElement[] daemonFrames,
            Thread.State queueState, StackTraceElement[] queueFrames) {
        return "passThread=" + state(passState) + " passIn=" + where(passFrames)
                + " finalizerDaemon=" + state(daemonState)
                + " finalizerIn=" + (daemonState == null ? "none" : where(daemonFrames))
                + " refQueueDaemon=" + state(queueState)
                + " refQueueIn=" + (queueState == null ? "none" : where(queueFrames));
    }

    /** Fixed marker body for an uncaught exception about to kill the process. */
    static String uncaughtMarker(Throwable e) {
        if (e instanceof java.util.concurrent.TimeoutException && e.getMessage() != null) {
            String message = e.getMessage();
            if (message.startsWith("ReferenceQueueDaemon timed out")) {
                return "kind=refqueue-timeout owner=none";
            }
            if (message.equals("Unknown finalizer timed out")) {
                return "kind=finalizer-timeout owner=none";
            }
            Matcher m = FINALIZER_TIMEOUT.matcher(message);
            if (m.matches()) return "kind=finalizer-timeout owner=" + ownerOf(m.group(1));
        }
        return "kind=other owner=none";
    }
}
