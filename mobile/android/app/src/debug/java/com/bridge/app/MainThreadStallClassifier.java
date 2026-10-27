package com.bridge.app;

/**
 * Android #209: DEBUG-only reduction of "what was the main thread doing during
 * a long dispatch?" to fixed categories. Pure (no Android calls) so it is JVM
 * tested. No class, method or other free text is ever returned.
 */
final class MainThreadStallClassifier {
    private MainThreadStallClassifier() {}

    /**
     * Innermost specific activity: the first frame (top of stack first) that
     * names a known kind of work; else a structural fallback; else "other".
     * An idle Looper poll on top means the thread was not busy.
     */
    static String where(StackTraceElement[] frames) {
        if (frames == null || frames.length == 0) return "none";
        StackTraceElement top = frames[0];
        if ("android.os.MessageQueue".equals(top.getClassName()) && "nativePollOnce".equals(top.getMethodName())) {
            return "idle";
        }
        for (StackTraceElement f : frames) {
            String kind = specific(f.getClassName(), f.getMethodName());
            if (kind != null) return kind;
        }
        for (StackTraceElement f : frames) {
            String kind = structural(f.getClassName(), f.getMethodName());
            if (kind != null) return kind;
        }
        return "other";
    }

    /** Outermost owner of the work (closest to the Looper): bridge, capacitor or webview. */
    static String via(StackTraceElement[] frames) {
        if (frames == null) return "none";
        for (int i = frames.length - 1; i >= 0; i--) {
            String owner = owner(frames[i].getClassName());
            if (owner != null) return owner;
        }
        return "none";
    }

    private static String owner(String c) {
        if (c.startsWith("com.bridge.")) return "bridge";
        if (c.startsWith("com.getcapacitor.")) return "capacitor";
        if (c.startsWith("org.chromium.") || c.startsWith("com.android.webview.") || c.startsWith("android.webkit.")) {
            return "webview";
        }
        return null;
    }

    private static String specific(String c, String m) {
        if ((c.equals("java.lang.Thread") && m.equals("sleep"))
                || (c.equals("android.os.SystemClock") && m.equals("sleep"))) return "sleep";
        if (c.equals("android.os.BinderProxy") && m.startsWith("transact")) return "binder";
        if (c.equals("dalvik.system.VMRuntime") || (c.equals("java.lang.Runtime") && m.contains("gc"))) return "gc";
        if (c.startsWith("java.io.") || c.startsWith("libcore.io.") || c.startsWith("android.database.sqlite.")
                || c.equals("android.app.SharedPreferencesImpl")) return "io";
        if (c.equals("android.graphics.Typeface") || c.startsWith("android.graphics.fonts.")
                || c.startsWith("androidx.core.provider.") || c.startsWith("androidx.emoji2.")) return "font";
        if (c.equals("java.lang.ClassLoader") || c.startsWith("dalvik.system.")) return "classload";
        if (c.equals("android.view.LayoutInflater")) return "inflate";
        String owner = owner(c);
        return owner;
    }

    private static String structural(String c, String m) {
        if (c.equals("android.graphics.HardwareRenderer") || c.equals("android.view.ThreadedRenderer")
                || c.equals("android.graphics.RenderNode") || (c.equals("android.view.ViewRootImpl") && m.startsWith("draw"))) {
            return "render";
        }
        if (c.equals("android.view.ViewRootImpl") && (m.startsWith("performTraversals")
                || m.startsWith("performMeasure") || m.startsWith("performLayout"))) return "layout";
        if (c.equals("android.view.Choreographer") && m.startsWith("doFrame")) return "frame";
        if (c.equals("android.app.ActivityThread") || c.equals("android.app.Instrumentation")
                || c.equals("android.app.Activity")) return "lifecycle";
        return null;
    }

    /**
     * Category of one Looper dispatch, from the printer line
     * ">>>>> Dispatching to Handler (target.Class) {hash} callback.Class: what".
     */
    static String message(String line) {
        if (line == null) return "unknown";
        int open = line.indexOf('(');
        int close = open < 0 ? -1 : line.indexOf(')', open);
        String target = open < 0 || close < 0 ? "" : line.substring(open + 1, close);
        int brace = line.indexOf('}', Math.max(close, 0));
        int colon = brace < 0 ? -1 : line.indexOf(':', brace);
        String callback = brace < 0 || colon < 0 ? "" : line.substring(brace + 1, colon).trim();
        if (target.equals("android.app.ActivityThread$H")) return "activity-thread";
        if (target.equals("android.view.Choreographer$FrameHandler")
                || callback.equals("android.view.Choreographer$FrameDisplayEventReceiver")) return "frame";
        if (target.startsWith("android.view.ViewRootImpl")) return "view-root";
        for (String c : new String[] {callback, target}) {
            String owner = owner(c);
            if (owner != null) return owner;
        }
        return "other";
    }

    /** The category with the most samples, or "unsampled". Ties keep the first. */
    static String dominant(String[] names, int[] counts) {
        int best = -1;
        for (int i = 0; i < counts.length; i++) {
            if (counts[i] > 0 && (best < 0 || counts[i] > counts[best])) best = i;
        }
        return best < 0 ? "unsampled" : names[best];
    }
}
