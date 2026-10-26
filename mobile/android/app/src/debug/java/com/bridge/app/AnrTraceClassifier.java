package com.bridge.app;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Android #209: DEBUG-only reduction of an ART ANR trace's "main" thread to
 * fixed categories: idle in its Looper, inside a binder call, waiting for a
 * lock, or running Bridge / Capacitor / WebView code. These describe the
 * sampled stack, not the cause or duration of an ANR.
 * No frame, class, argument, path or user data is ever returned.
 */
final class AnrTraceClassifier {
    static final class Result {
        final String mainState;
        final String top;
        final String subsystem;
        final String nativeHint;
        final String topOperation;
        final String ownerOperation;

        Result(String mainState, String top, String subsystem, String nativeHint,
                String topOperation, String ownerOperation) {
            this.mainState = mainState;
            this.top = top;
            this.subsystem = subsystem;
            this.nativeHint = nativeHint;
            this.topOperation = topOperation;
            this.ownerOperation = ownerOperation;
        }

        String marker() {
            return "mainState=" + mainState + " top=" + top + " subsystem=" + subsystem
                    + " nativeHint=" + nativeHint;
        }

        String operationMarker() {
            return "topOperation=" + topOperation + " ownerOperation=" + ownerOperation;
        }
    }

    private static final Pattern MAIN_HEADER =
            Pattern.compile("^\"main\" (?:daemon )?prio=\\d+ tid=\\d+ ([A-Za-z]+)");
    // ART uses <init>/<clinit> for constructors/static initializers. Skipping
    // those frames can falsely attribute their work to a deeper caller.
    private static final Pattern FRAME = Pattern.compile(
            "^\\s+at ([A-Za-z0-9_$.]+\\.(?:[A-Za-z0-9_$]+|<init>|<clinit>))\\(");
    private static final int MAX_FRAMES = 24;
    private static final int MAX_NATIVE_FRAMES = 24;

    private AnrTraceClassifier() {}

    static Result classify(String trace) {
        if (trace == null) return missing();
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
        if (start < 0) return missing();

        String firstFrame = null;
        String subsystem = null;
        String ownerOperation = "none";
        boolean waitingToLock = false;
        boolean anyFrame = false;
        int frames = 0;
        int nativeFrames = 0;
        String nativeHint = "none";
        for (int i = start; i < lines.length && frames < MAX_FRAMES; i++) {
            String line = lines[i];
            // A blank line or the next thread header ends the "main" block.
            if (line.isEmpty() || line.startsWith("\"")) break;
            if (line.trim().startsWith("- waiting to lock")) waitingToLock = true;
            // ART writes native #nn frames before Java `at` frames. Reduce
            // library basenames to fixed categories, never log the original
            // path, symbol, offset, method or line (any may carry user data).
            // The first recognized non-libc library is a *hint*, not proof
            // that it caused the ANR. Only inspect this main-thread block.
            if (nativeFrames < MAX_NATIVE_FRAMES && line.matches("^\\s*(?:native: )?#\\d{2}\\s+.*")) {
                nativeFrames++;
                String category = nativeLibraryHint(line);
                if (!"none".equals(category) && ("none".equals(nativeHint)
                        || "libc".equals(nativeHint))) nativeHint = category;
            }
            Matcher f = FRAME.matcher(line);
            if (!f.find()) continue;
            frames++;
            anyFrame = true;
            String method = f.group(1);
            if (firstFrame == null) firstFrame = method;
            if (subsystem == null) {
                subsystem = subsystemOf(method);
                if (subsystem != null) ownerOperation = operationOf(method);
            }
        }

        String top;
        if (!anyFrame) top = "unknown";
        else if ("Blocked".equals(state) || waitingToLock) top = "lock-wait";
        else if (firstFrame.equals("android.os.MessageQueue.nativePollOnce")) top = "idle-looper";
        else if (firstFrame.equals("android.os.BinderProxy.transact")
                || firstFrame.equals("android.os.BinderProxy.transactNative")) top = "binder-transaction";
        else if (firstFrame.equals("java.lang.Thread.sleep")) top = "sleep";
        else top = "running-code";
        return new Result(stateOf(state), top,
                subsystem != null ? subsystem : anyFrame ? "framework-only" : "none",
                nativeHint, operationOf(firstFrame), ownerOperation);
    }

    private static Result missing() {
        return new Result("missing", "unknown", "none", "none", "none", "none");
    }

    /**
     * Fixed operation categories for the FIRST Java frame and the FIRST
     * non-framework owner, independently. An ancestor is context, never proof
     * that it blocked input. Unknown methods stay "other"; do not export them
     * or infer operations from arbitrary method-name substrings. Capacitor
     * entries were checked against the lockfile's @capacitor/android 8.4.3.
     */
    private static String operationOf(String method) {
        if (method == null) return "none";
        switch (method) {
            case "android.os.MessageQueue.nativePollOnce": return "looper";
            case "android.os.BinderProxy.transact":
            case "android.os.BinderProxy.transactNative": return "binder";
            case "java.lang.Thread.sleep": return "sleep";
            case "java.lang.Object.wait": return "monitor-wait";
            case "java.lang.Class.forName":
            case "java.lang.Class.classForName":
            case "java.lang.ClassLoader.loadClass":
            case "dalvik.system.BaseDexClassLoader.findClass":
            case "dalvik.system.DexPathList.findClass": return "class-load";
            case "java.lang.reflect.Method.invoke":
            case "java.lang.reflect.Constructor.newInstance":
            case "java.lang.reflect.Constructor.newInstance0":
            case "java.lang.Class.newInstance": return "reflection";
            case "android.content.res.AssetManager.open":
            case "android.content.res.AssetManager.openNonAsset":
            case "android.content.res.AssetManager$AssetInputStream.read": return "asset-read";
            case "android.webkit.WebView.<init>":
            case "android.webkit.WebView.ensureProviderCreated":
            case "android.webkit.WebView.getFactory":
            case "android.webkit.WebViewFactory.getProvider":
            case "android.webkit.WebSettings.getDefaultUserAgent": return "webview-init";
            case "android.webkit.WebView.loadUrl":
            case "android.webkit.WebView.loadDataWithBaseURL": return "webview-load";
            case "android.webkit.WebView.onFocusChanged":
            case "android.webkit.WebView.onWindowFocusChanged": return "webview-focus";
            case "com.getcapacitor.Bridge.<init>":
            case "com.getcapacitor.Bridge$Builder.<init>":
            case "com.getcapacitor.Bridge$Builder.create":
            case "com.getcapacitor.BridgeActivity.<init>":
            case "com.getcapacitor.BridgeActivity.load":
            case "com.getcapacitor.Bridge.initWebView":
            case "com.getcapacitor.Bridge.loadWebView": return "capacitor-build";
            case "com.getcapacitor.Bridge.registerAllPlugins":
            case "com.getcapacitor.Bridge.registerPlugin":
            case "com.getcapacitor.Bridge.registerPlugins":
            case "com.getcapacitor.Bridge.registerPluginInstance":
            case "com.getcapacitor.Bridge.registerPluginInstances":
            case "com.getcapacitor.PluginManager.loadPluginClasses":
            case "com.getcapacitor.PluginHandle.<init>":
            case "com.getcapacitor.PluginHandle.load":
            case "com.getcapacitor.PluginHandle.loadInstance":
            case "com.getcapacitor.PluginHandle.indexMethods": return "capacitor-plugins";
            case "com.getcapacitor.Bridge.getJSInjector":
            case "com.getcapacitor.JSExport.getBridgeJS":
            case "com.getcapacitor.JSExport.getPluginJS":
            case "com.getcapacitor.JSExport.getFilesContent": return "capacitor-script";
            case "com.getcapacitor.BridgeActivity.onCreate":
            case "com.getcapacitor.BridgeActivity.onStart":
            case "com.getcapacitor.BridgeActivity.onRestart":
            case "com.getcapacitor.BridgeActivity.onResume":
            case "com.getcapacitor.BridgeActivity.onPause":
            case "com.getcapacitor.BridgeActivity.onStop":
            case "com.getcapacitor.BridgeActivity.onDestroy":
            case "com.getcapacitor.Bridge.onStart":
            case "com.getcapacitor.Bridge.onRestart":
            case "com.getcapacitor.Bridge.onResume":
            case "com.getcapacitor.Bridge.onPause":
            case "com.getcapacitor.Bridge.onStop":
            case "com.getcapacitor.Bridge.onDestroy": return "capacitor-lifecycle";
            case "com.getcapacitor.MessageHandler.postMessage":
            case "com.getcapacitor.MessageHandler.sendResponseMessage":
            case "com.getcapacitor.MessageHandler.callPluginMethod":
            case "com.getcapacitor.Bridge.callPluginMethod": return "capacitor-message";
            case "com.bridge.app.MainActivity.onCreate":
            case "com.bridge.app.MainActivity.onResume": return "bridge-lifecycle";
            default:
                if (method.endsWith(".<init>")) return "constructor";
                if (method.endsWith(".<clinit>")) return "class-init";
                return "other";
        }
    }

    private static String nativeLibraryHint(String line) {
        // Match the basename + .so boundary, not an arbitrary substring
        // (e.g. libart.so.evil must not be accepted as libart.so).
        if (line.matches(".*[/ ]libwebviewchromium\\.so(?:\\s|\\().*")) return "webview";
        if (line.matches(".*[/ ]libbinder(?:_ndk)?\\.so(?:\\s|\\().*")) return "binder";
        if (line.matches(".*[/ ]libhwui\\.so(?:\\s|\\().*")) return "graphics";
        if (line.matches(".*[/ ]libart\\.so(?:\\s|\\().*")) return "art";
        if (line.matches(".*[/ ]libandroid_runtime\\.so(?:\\s|\\().*")) return "android-runtime";
        if (line.matches(".*[/ ]libc\\.so(?:\\s|\\().*")) return "libc";
        return "none";
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
