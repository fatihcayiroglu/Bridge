package com.bridge.app;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Android #209: DEBUG-only reduction of an ART ANR trace's "main" thread to
 * fixed categories. Whether the main thread was idle in its Looper, inside a
 * binder call, waiting for a lock, or running Bridge / Capacitor / WebView
 * code separates "the app blocked input" from "input never reached an idle
 * app". No frame, class, argument, path or user data is ever returned.
 */
final class AnrTraceClassifier {
    static final class Result {
        final String mainState;
        final String top;
        final String subsystem;

        Result(String mainState, String top, String subsystem) {
            this.mainState = mainState;
            this.top = top;
            this.subsystem = subsystem;
        }

        String marker() {
            return "mainState=" + mainState + " top=" + top + " subsystem=" + subsystem;
        }
    }

    private static final Pattern MAIN_HEADER =
            Pattern.compile("^\"main\" (?:daemon )?prio=\\d+ tid=\\d+ ([A-Za-z]+)");
    private static final Pattern FRAME = Pattern.compile("^\\s+at ([A-Za-z0-9_$.]+)\\(");
    private static final int MAX_FRAMES = 24;

    private AnrTraceClassifier() {}

    static Result classify(String trace) {
        if (trace == null) return new Result("missing", "unknown", "none");
        String[] lines = trace.split("\r?\n", -1);
        int start = -1;
        String state = null;
        for (int i = 0; i < lines.length; i++) {
            Matcher m = MAIN_HEADER.matcher(lines[i]);
            if (m.find()) {
                start = i + 1;
                state = m.group(1);
                break;
            }
        }
        if (start < 0) return new Result("missing", "unknown", "none");

        String firstFrame = null;
        String subsystem = null;
        boolean waitingToLock = false;
        boolean anyFrame = false;
        int frames = 0;
        for (int i = start; i < lines.length && frames < MAX_FRAMES; i++) {
            String line = lines[i];
            // A blank line or the next thread header ends the "main" block.
            if (line.isEmpty() || line.startsWith("\"")) break;
            if (line.trim().startsWith("- waiting to lock")) waitingToLock = true;
            Matcher f = FRAME.matcher(line);
            if (!f.find()) continue;
            frames++;
            anyFrame = true;
            String method = f.group(1);
            if (firstFrame == null) firstFrame = method;
            if (subsystem == null) subsystem = subsystemOf(method);
        }

        String top;
        if (!anyFrame) top = "unknown";
        else if ("Blocked".equals(state) || waitingToLock) top = "lock-wait";
        else if (firstFrame.equals("android.os.MessageQueue.nativePollOnce")) top = "idle-looper";
        else if (firstFrame.startsWith("android.os.BinderProxy.transact")) top = "binder-transaction";
        else if (firstFrame.equals("java.lang.Thread.sleep")) top = "sleep";
        else top = "running-code";
        return new Result(stateOf(state), top,
                subsystem != null ? subsystem : anyFrame ? "framework-only" : "none");
    }

    private static String stateOf(String state) {
        switch (state) {
            case "Runnable": case "Native": case "Blocked": case "Waiting":
            case "TimedWaiting": case "Sleeping": case "Suspended":
                return state;
            default:
                return "other";
        }
    }

    /** First non-framework owner of a frame, or null for framework/runtime frames. */
    private static String subsystemOf(String method) {
        if (method.startsWith("com.bridge.app.")) return "bridge";
        if (method.startsWith("com.getcapacitor.")) return "capacitor";
        if (method.startsWith("org.chromium.") || method.startsWith("com.android.webview.")
                || method.startsWith("android.webkit.")) return "webview";
        if (method.startsWith("androidx.")) return "androidx";
        if (method.startsWith("com.google.android.gms.")) return "gms";
        if (method.startsWith("android.") || method.startsWith("com.android.internal.")
                || method.startsWith("java.") || method.startsWith("javax.")
                || method.startsWith("dalvik.") || method.startsWith("libcore.")
                || method.startsWith("sun.") || method.startsWith("jdk.")) return null;
        return "other-app";
    }
}
