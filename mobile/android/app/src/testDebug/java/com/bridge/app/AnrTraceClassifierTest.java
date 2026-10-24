package com.bridge.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import org.junit.Test;

/** #209: ANR main-thread classification is enum-only and fails closed. */
public class AnrTraceClassifierTest {
    private static String trace(String header, String... frames) {
        StringBuilder sb = new StringBuilder()
                .append("----- pid 7066 at 2026-10-17 13:57:23.302 -----\n")
                .append("Cmd line: com.bridge.app.debug\n\n")
                .append("\"Signal Catcher\" daemon prio=10 tid=2 Runnable\n")
                .append("  at com.bridge.app.SecretSignalFrame.ignored(Native method)\n\n")
                .append(header).append('\n')
                .append("  | group=\"main\" sCount=1 ucsCount=0 flags=1 obj=0x72a6c4b8 self=0xb400007a8c8a6380\n")
                .append("  | sysTid=7066 nice=-10 cgrp=top-app sched=0/0 handle=0x7bbf8364f8\n")
                .append("  native: #00 pc 00000000000a33b8  /apex/com.android.runtime/lib64/bionic/libc.so (__epoll_pwait+8)\n");
        for (String frame : frames) sb.append(frame).append('\n');
        return sb.append("\n\"RenderThread\" prio=7 tid=14 Native\n")
                .append("  at com.bridge.app.AfterMainBlock.ignored(Native method)\n").toString();
    }

    @Test
    public void idleLooperMeansTheMainThreadWasNotBlocked() {
        AnrTraceClassifier.Result r = AnrTraceClassifier.classify(trace(
                "\"main\" prio=5 tid=1 Native",
                "  at android.os.MessageQueue.nativePollOnce(Native method)",
                "  at android.os.MessageQueue.next(MessageQueue.java:335)",
                "  at android.os.Looper.loopOnce(Looper.java:161)",
                "  at android.app.ActivityThread.main(ActivityThread.java:7872)",
                "  at com.android.internal.os.ZygoteInit.main(ZygoteInit.java:936)"));
        assertEquals("mainState=Native top=idle-looper subsystem=framework-only nativeHint=libc", r.marker());
    }

    @Test
    public void appBinderCallAndLockWaitAreAttributedToTheirOwner() {
        AnrTraceClassifier.Result binder = AnrTraceClassifier.classify(trace(
                "\"main\" prio=5 tid=1 Native",
                "  at android.os.BinderProxy.transactNative(Native method)",
                "  at android.os.BinderProxy.transact(BinderProxy.java:584)",
                "  at android.app.IActivityManager$Stub$Proxy.getRunningAppProcesses(IActivityManager.java:5163)",
                "  at com.getcapacitor.plugin.Example.load(Example.java:42)",
                "  at com.bridge.app.MainActivity.onCreate(MainActivity.java:47)"));
        assertEquals("mainState=Native top=binder-transaction subsystem=capacitor nativeHint=libc", binder.marker());

        AnrTraceClassifier.Result lock = AnrTraceClassifier.classify(trace(
                "\"main\" prio=5 tid=1 Blocked",
                "  at org.chromium.android_webview.AwContents.onFocusChanged(AwContents.java:2711)",
                "  - waiting to lock <0x0a1b2c3d> (a java.lang.Object) held by thread 31",
                "  at android.webkit.WebView.onFocusChanged(WebView.java:3211)"));
        assertEquals("mainState=Blocked top=lock-wait subsystem=webview nativeHint=libc", lock.marker());
    }

    @Test
    public void bridgeCodeRunningOnMainIsReported() {
        AnrTraceClassifier.Result r = AnrTraceClassifier.classify(trace(
                "\"main\" prio=5 tid=1 Runnable",
                "  at java.util.HashMap.resize(HashMap.java:710)",
                "  at com.bridge.app.SomeWork.run(SomeWork.java:10)"));
        assertEquals("mainState=Runnable top=running-code subsystem=bridge nativeHint=libc", r.marker());
    }

    @Test
    public void missingOrForeignInputFailsClosedWithoutLeakingFrames() {
        assertEquals("mainState=missing top=unknown subsystem=none nativeHint=none",
                AnrTraceClassifier.classify(null).marker());
        assertEquals("mainState=missing top=unknown subsystem=none nativeHint=none",
                AnrTraceClassifier.classify("\"main-ish\" prio=5 tid=1 Native\n  at a.b(c)").marker());
        AnrTraceClassifier.Result odd = AnrTraceClassifier.classify(trace(
                "\"main\" prio=5 tid=1 WaitingForGcToComplete"));
        assertEquals("mainState=other top=unknown subsystem=none nativeHint=libc", odd.marker());
        String marker = AnrTraceClassifier.classify(trace("\"main\" prio=5 tid=1 Native",
                "  at com.secret.Customer.token(Customer.java:1)")).marker();
        assertEquals("mainState=Native top=running-code subsystem=other-app nativeHint=libc", marker);
        assertFalse(marker.contains("secret") || marker.contains("Customer") || marker.contains("7066"));
    }

    @Test
    public void nativeFramesProduceOnlyBoundedLibraryHints() {
        String raw = trace("\"main\" prio=5 tid=1 Native",
                "  native: #01 pc 0000000000001000  /apex/com.android.art/lib64/libart.so (art::WaitForGcToComplete+12)",
                "  native: #02 pc 0000000000001000  /data/app/private/libwebviewchromium.so (secret+12)",
                "  at android.webkit.WebView.loadUrl(WebView.java:10)");
        String marker = AnrTraceClassifier.classify(raw).marker();
        assertEquals("mainState=Native top=running-code subsystem=webview nativeHint=art", marker);
        assertFalse(marker.contains("data/app") || marker.contains("secret") || marker.contains("WaitForGc"));

        String spoofed = trace("\"main\" prio=5 tid=1 Native",
                "  native: #01 pc 0000000000001000 /data/app/libart.so.evil (secret)",
                "  at android.app.ActivityThread.main(ActivityThread.java:10)");
        assertEquals("mainState=Native top=running-code subsystem=framework-only nativeHint=libc",
                AnrTraceClassifier.classify(spoofed).marker());
    }
}
