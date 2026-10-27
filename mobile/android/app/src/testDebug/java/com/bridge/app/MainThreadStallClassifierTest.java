package com.bridge.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import org.junit.Test;

/** #209: main-thread stall attribution is reduced to fixed categories only. */
public class MainThreadStallClassifierTest {
    private static StackTraceElement f(String cls, String method) {
        return new StackTraceElement(cls, method, null, -1);
    }

    @Test
    public void innermostSpecificWorkWins() {
        StackTraceElement[] webviewInOnCreate = {
            f("org.chromium.android_webview.AwContents", "<init>"),
            f("android.webkit.WebView", "<init>"),
            f("com.getcapacitor.Bridge", "initWebView"),
            f("com.bridge.app.MainActivity", "onCreate"),
            f("android.app.Activity", "performCreate"),
            f("android.app.ActivityThread", "handleLaunchActivity"),
            f("android.os.Looper", "loop"),
        };
        assertEquals("webview", MainThreadStallClassifier.where(webviewInOnCreate));
        assertEquals("bridge", MainThreadStallClassifier.via(webviewInOnCreate));
        assertEquals("sleep", MainThreadStallClassifier.where(new StackTraceElement[] {
            f("java.lang.Thread", "sleep"), f("android.os.SystemClock", "sleep"), f("com.bridge.app.X", "run")}));
        assertEquals("binder", MainThreadStallClassifier.where(new StackTraceElement[] {
            f("android.os.BinderProxy", "transactNative"), f("android.os.BinderProxy", "transact")}));
        assertEquals("io", MainThreadStallClassifier.where(new StackTraceElement[] {
            f("libcore.io.Linux", "read"), f("android.app.SharedPreferencesImpl", "awaitLoadedLocked")}));
        assertEquals("font", MainThreadStallClassifier.where(new StackTraceElement[] {
            f("android.graphics.Typeface", "create")}));
    }

    @Test
    public void structuralFallbackIdleAndEmpty() {
        assertEquals("render", MainThreadStallClassifier.where(new StackTraceElement[] {
            f("android.graphics.HardwareRenderer", "nSyncAndDrawFrame"), f("android.view.ViewRootImpl", "draw")}));
        assertEquals("layout", MainThreadStallClassifier.where(new StackTraceElement[] {
            f("android.widget.FrameLayout", "onMeasure"), f("android.view.ViewRootImpl", "performMeasure")}));
        assertEquals("idle", MainThreadStallClassifier.where(new StackTraceElement[] {
            f("android.os.MessageQueue", "nativePollOnce"), f("android.os.MessageQueue", "next")}));
        assertEquals("other", MainThreadStallClassifier.where(new StackTraceElement[] {f("com.example.Secret", "x")}));
        assertEquals("none", MainThreadStallClassifier.where(new StackTraceElement[0]));
        assertEquals("none", MainThreadStallClassifier.via(new StackTraceElement[] {f("com.example.Secret", "x")}));
    }

    @Test
    public void messageCategoriesFromTheLooperPrinterLine() {
        assertEquals("activity-thread", MainThreadStallClassifier.message(
            ">>>>> Dispatching to Handler (android.app.ActivityThread$H) {1a2b} null: 159"));
        assertEquals("frame", MainThreadStallClassifier.message(
            ">>>>> Dispatching to Handler (android.view.Choreographer$FrameHandler) {3c} "
                + "android.view.Choreographer$FrameDisplayEventReceiver@9: 0"));
        assertEquals("capacitor", MainThreadStallClassifier.message(
            ">>>>> Dispatching to Handler (android.os.Handler) {4d} com.getcapacitor.Bridge$$Lambda$1@5: 0"));
        assertEquals("other", MainThreadStallClassifier.message(
            ">>>>> Dispatching to Handler (android.os.Handler) {4d} private.example.Secret$1@5: 0"));
        assertEquals("unknown", MainThreadStallClassifier.message(null));
    }

    @Test
    public void markersCarryOnlyCategoriesAndBoundedNumbers() {
        String marker = MainThreadStallProbe.marker(357_000_000L, "frame", "webview", "capacitor", 123_456);
        assertEquals("event=stall ms=999999 msg=frame where=webview via=capacitor samples=9999", marker);
        assertFalse(marker.contains("Secret"));
        assertEquals("unsampled", MainThreadStallClassifier.dominant(new String[] {"a", "b"}, new int[] {0, 0}));
        assertEquals("b", MainThreadStallClassifier.dominant(new String[] {"a", "b"}, new int[] {1, 3}));
    }
}
