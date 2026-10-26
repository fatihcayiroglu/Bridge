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

    @Test
    public void constructorFramesMustNotBeSkippedWhenFindingTheFirstOwner() {
        String raw = trace("\"main\" prio=5 tid=1 Runnable",
                "  at com.getcapacitor.Bridge.<init>(Bridge.java:222)",
                "  at com.bridge.app.MainActivity.onCreate(MainActivity.java:49)");
        assertEquals("mainState=Runnable top=running-code subsystem=capacitor nativeHint=libc",
                AnrTraceClassifier.classify(raw).marker());
    }

    @Test
    public void operationsSeparateTheTopJavaFrameFromTheFirstOwner() {
        AnrTraceClassifier.Result r = AnrTraceClassifier.classify(trace(
                "\"main\" prio=5 tid=1 Runnable",
                "  at java.lang.Class.classForName(Native method)",
                "  at java.lang.Class.forName(Class.java:454)",
                "  at com.getcapacitor.PluginManager.loadPluginClasses(PluginManager.java:33)",
                "  at com.getcapacitor.BridgeActivity.onCreate(BridgeActivity.java:36)"));
        assertEquals("topOperation=class-load ownerOperation=capacitor-plugins", r.operationMarker());

        AnrTraceClassifier.Result reflection = AnrTraceClassifier.classify(trace(
                "\"main\" prio=5 tid=1 Runnable",
                "  at java.lang.reflect.Constructor.newInstance0(Native method)",
                "  at com.getcapacitor.PluginHandle.load(PluginHandle.java:104)",
                "  at com.getcapacitor.Bridge.<init>(Bridge.java:231)"));
        assertEquals("topOperation=reflection ownerOperation=capacitor-plugins", reflection.operationMarker());
    }

    @Test
    public void webViewConstructionIsNotReportedAsItsCapacitorCaller() {
        AnrTraceClassifier.Result r = AnrTraceClassifier.classify(trace(
                "\"main\" prio=5 tid=1 Runnable",
                "  at android.webkit.WebView.<init>(WebView.java:350)",
                "  at com.getcapacitor.Bridge.initWebView(Bridge.java:587)"));
        assertEquals("mainState=Runnable top=running-code subsystem=webview nativeHint=libc", r.marker());
        assertEquals("topOperation=webview-init ownerOperation=webview-init", r.operationMarker());
    }

    @Test
    public void assetReadingAndScriptCreationKeepTheirSeparateRoles() {
        AnrTraceClassifier.Result r = AnrTraceClassifier.classify(trace(
                "\"main\" prio=5 tid=1 Native",
                "  at android.content.res.AssetManager$AssetInputStream.read(AssetManager.java:611)",
                "  at com.getcapacitor.JSExport.getFilesContent(JSExport.java:108)",
                "  at com.getcapacitor.Bridge.loadWebView(Bridge.java:265)"));
        assertEquals("topOperation=asset-read ownerOperation=capacitor-script", r.operationMarker());
    }

    @Test
    public void lifecycleAndMessageDispatchRemainDistinct() {
        AnrTraceClassifier.Result lifecycle = AnrTraceClassifier.classify(trace(
                "\"main\" prio=5 tid=1 Runnable",
                "  at com.getcapacitor.Bridge.onResume(Bridge.java:1353)",
                "  at com.getcapacitor.BridgeActivity.onResume(BridgeActivity.java:98)",
                "  at com.bridge.app.MainActivity.onResume(MainActivity.java:70)"));
        assertEquals("topOperation=capacitor-lifecycle ownerOperation=capacitor-lifecycle", lifecycle.operationMarker());
        AnrTraceClassifier.Result dispatch = AnrTraceClassifier.classify(trace(
                "\"main\" prio=5 tid=1 Runnable",
                "  at com.getcapacitor.MessageHandler.postMessage(MessageHandler.java:52)",
                "  at android.os.Handler.dispatchMessage(Handler.java:106)"));
        assertEquals("topOperation=capacitor-message ownerOperation=capacitor-message", dispatch.operationMarker());
    }

    @Test
    public void unknownOrSimilarMethodNamesNeverGainAnAllowlistedOperation() {
        for (String method : new String[] {
                "com.secret.Customer.token", "com.getcapacitor.Bridge.loadWebViewSecret",
                "com.getcapacitor.SecretBridge.loadWebView", "com.getcapacitor.Bridge.evil$loadWebView",
                "android.os.BinderProxy.transactSecret"}) {
            AnrTraceClassifier.Result r = AnrTraceClassifier.classify(trace(
                    "\"main\" prio=5 tid=1 Runnable",
                    "  at " + method + "(/private/customer/token.java:123)",
                    "  at com.getcapacitor.Bridge.loadWebView(Bridge.java:265)"));
            assertEquals("running-code", r.top);
            assertEquals("other", r.topOperation);
            // Framework-only first frame: the next frame is the first owner.
            assertEquals(method.startsWith("android.") ? "capacitor-build" : "other", r.ownerOperation);
            assertFalse(r.operationMarker().contains("secret") || r.operationMarker().contains("Secret")
                    || r.operationMarker().contains("Customer") || r.operationMarker().contains("private"));
        }
    }

    @Test
    public void constructorFramesCountTowardTheExistingScanLimit() {
        StringBuilder frames = new StringBuilder();
        for (int i = 0; i < 24; i++) frames.append("  at java.lang.Fixture.<init>(Fixture.java:1)\n");
        AnrTraceClassifier.Result beyondLimit = AnrTraceClassifier.classify(trace(
                "\"main\" prio=5 tid=1 Runnable", frames.toString()
                        + "  at com.getcapacitor.Bridge.<init>(Bridge.java:222)"));
        assertEquals("framework-only", beyondLimit.subsystem);
        assertEquals("topOperation=constructor ownerOperation=none", beyondLimit.operationMarker());
        AnrTraceClassifier.Result atLimit = AnrTraceClassifier.classify(trace(
                "\"main\" prio=5 tid=1 Runnable", frames.substring(frames.indexOf("\n") + 1)
                        + "  at com.getcapacitor.Bridge.<init>(Bridge.java:222)"));
        assertEquals("capacitor", atLimit.subsystem);
        assertEquals("topOperation=constructor ownerOperation=capacitor-build", atLimit.operationMarker());
    }

    @Test
    public void emptyAndNativeOnlyTracesHaveNoJavaOperation() {
        assertEquals("topOperation=none ownerOperation=none", AnrTraceClassifier.classify(null).operationMarker());
        assertEquals("topOperation=none ownerOperation=none", AnrTraceClassifier.classify(trace(
                "\"main\" prio=5 tid=1 Native")).operationMarker());
        AnrTraceClassifier.Result idle = AnrTraceClassifier.classify(trace(
                "\"main\" prio=5 tid=1 Native",
                "  at android.os.MessageQueue.nativePollOnce(Native method)"));
        assertEquals("topOperation=looper ownerOperation=none", idle.operationMarker());
    }

    @Test
    public void hardwareRendererJavaOperationsAreNotLostAsOther() {
        String[][] methods = {
            { "nCreateRootRenderNode", "renderer-init" },
            { "nCreateProxy", "renderer-init" },
            { "nSetSurface", "surface-setup" },
            { "nSetSurfaceControl", "surface-setup" },
            { "nAllocateBuffers", "buffer-allocate" },
            { "nSyncAndDrawFrame", "frame-sync" }
        };
        for (String[] method : methods) {
            AnrTraceClassifier.Result r = AnrTraceClassifier.classify(trace(
                    "\"main\" prio=5 tid=1 Native",
                    "  at android.graphics.HardwareRenderer." + method[0] + "(Native method)",
                    "  at android.view.ThreadedRenderer.initialize(ThreadedRenderer.java:1)"));
            assertEquals(method[0], method[1], r.topOperation);
            assertEquals("framework-only", r.subsystem);
            assertEquals("none", r.ownerOperation);
        }
    }

    @Test
    public void sameTraceKeepsMainProxyAndRenderContextOperationsSeparate() {
        // Synthetic ART-format fixture, not a claim about the retained ANR.
        String raw = "\"main\" prio=5 tid=1 Native\n"
                + "  native: #00 pc 00001000 /apex/bionic/libc.so (__futex_wait+8)\n"
                + "  native: #01 pc 00002000 /system/lib64/libhwui.so (android::uirenderer::renderthread::RenderProxy::setSurface(ANativeWindow*, bool)+80)\n"
                + "  at android.graphics.HardwareRenderer.nSetSurface(Native method)\n\n"
                + "\"RenderThread\" daemon prio=7 tid=14 Native\n"
                + "  native: #00 pc 00001000 /apex/bionic/libc.so (__futex_wait+8)\n"
                + "  native: #01 pc 00003000 /system/lib64/libhwui.so (android::uirenderer::renderthread::RenderThread::requireGlContext()+12)\n\n"
                + "\"private-worker\" prio=5 tid=99 Native\n"
                + "  native: #00 pc 00004000 /private/libhwui.so (android::uirenderer::renderthread::RenderProxy::syncAndDrawFrame()+4)\n";
        AnrTraceClassifier.Result main = AnrTraceClassifier.classify(raw);
        AnrTraceClassifier.Result render = AnrTraceClassifier.classifyRenderThread(raw);
        assertEquals("surface-setup", main.topOperation);
        assertEquals("none", main.ownerOperation);
        assertEquals("unknown", render.top); // No Java frame: never infer Java work or idle.
        assertEquals("mainNativeOperation=surface-setup renderState=Native renderNativeHint=graphics renderNativeOperation=context-init",
                main.graphicsMarker(render));
    }

    @Test
    public void nativeOperationNeedsExactLibraryAndDemangledMethodBoundary() {
        for (String frame : new String[] {
                "/private/libhwui.so.evil (android::uirenderer::renderthread::RenderProxy::setSurface()+8)",
                "/private/libwebviewchromium.so (android::uirenderer::renderthread::RenderProxy::setSurface()+8)",
                "/private/libhwui.so (evil::android::uirenderer::renderthread::RenderProxy::setSurface()+8)",
                "/private/libhwui.so (android::uirenderer::renderthread::RenderProxy::setSurfaceSecret()+8)",
                "/private/libhwui.so (secret(android::uirenderer::renderthread::RenderProxy::setSurface()+8))",
                "/private/libhwui.so (android::uirenderer::renderthread::RenderProxy::setSurface<Secret>()+8)",
                "/private/libhwui.so (private-customer@example.test+8)"
        }) {
            AnrTraceClassifier.Result r = AnrTraceClassifier.classify(trace(
                    "\"main\" prio=5 tid=1 Native", "  native: #01 pc 00001000 " + frame));
            assertEquals(frame, "graphics".equals(r.nativeHint) ? "other" : "none", r.nativeOperation);
            String marker = r.graphicsMarker(AnrTraceClassifier.classifyRenderThread(null));
            assertFalse(marker.contains("private") || marker.contains("Secret") || marker.contains("android::"));
        }
    }

    @Test
    public void nativeOperationsDoNotEscapeTheFrameOrThreadScanLimits() {
        StringBuilder raw = new StringBuilder("\"main\" prio=5 tid=1 Native\n");
        for (int i = 0; i < 24; i++) raw.append("  native: #00 pc 00001000 /apex/bionic/libc.so (__futex_wait+8)\n");
        String operation = "  native: #24 pc 00002000 /system/lib64/libhwui.so (android::uirenderer::renderthread::RenderProxy::syncAndDrawFrame()+8)\n";
        assertEquals("none", AnrTraceClassifier.classify(raw + operation).nativeOperation);
        String atLimit = raw.substring(0, raw.lastIndexOf("  native:")) + operation;
        assertEquals("frame-sync", AnrTraceClassifier.classify(atLimit).nativeOperation);
        assertEquals("none", AnrTraceClassifier.classify(raw + "\n\"RenderThread\" prio=7 tid=14 Native\n" + operation).nativeOperation);
        assertEquals("frame-sync", AnrTraceClassifier.classifyRenderThread(raw + "\n\"RenderThread\" prio=7 tid=14 Native\n" + operation).nativeOperation);
    }

    @Test
    public void rendererDiagnosticsRequireItsExactThreadAndPreserveMissing() {
        for (String header : new String[] { "\"RenderThread-2\" prio=7 tid=14 Native",
                "\"OtherRenderThread\" prio=7 tid=14 Native", "\"main\" prio=5 tid=1 Native" }) {
            AnrTraceClassifier.Result r = AnrTraceClassifier.classifyRenderThread(trace(header,
                    "  native: #01 pc 00002000 /system/lib64/libhwui.so (android::uirenderer::renderthread::EglManager::swapBuffers()+8)"));
            // The shared trace fixture has a later real RenderThread, but no native frame in it.
            assertEquals("none", r.nativeOperation);
            assertEquals("none", r.nativeHint);
        }
        AnrTraceClassifier.Result missing = AnrTraceClassifier.classifyRenderThread(null);
        assertEquals("mainNativeOperation=none renderState=missing renderNativeHint=none renderNativeOperation=none",
                AnrTraceClassifier.classify(null).graphicsMarker(missing));
        assertEquals("missing", AnrTraceClassifier.classifyRenderThread("\"RenderThread-2\" prio=7 tid=14 Native\n").mainState);
    }

    @Test
    public void nativeContextSwapAndFenceAreContextNotProofOfBlockedTopFrame() {
        String[][] cases = {
            { "renderthread::RenderThread::requireVkContext", "context-init" },
            { "renderthread::EglManager::swapBuffers", "buffer-swap" },
            { "skiapipeline::SkiaVulkanPipeline::swapBuffers", "buffer-swap" },
            { "renderthread::EglManager::fenceWait", "fence-wait" },
            { "skiapipeline::SkiaOpenGLPipeline::draw", "frame-draw" },
            { "ThreadBase::threadLoop", "render-loop" }
        };
        for (String[] operation : cases) {
            String raw = "\"RenderThread\" prio=7 tid=14 Native\n"
                    + "  native: #00 pc 00001000 /apex/bionic/libc.so (__futex_wait+8)\n"
                    + "  native: #01 pc 00002000 /system/lib64/libhwui.so (android::uirenderer::" + operation[0] + "()+8)\n"
                    + "  native: #02 pc 00003000 /system/lib64/libhwui.so (android::uirenderer::renderthread::RenderProxy::syncAndDrawFrame()+8)\n";
            AnrTraceClassifier.Result r = AnrTraceClassifier.classifyRenderThread(raw);
            assertEquals(operation[0], operation[1], r.nativeOperation);
            assertEquals("unknown", r.top);
            assertEquals("none", r.topOperation);
        }
        assertEquals("other", AnrTraceClassifier.classify(trace("\"main\" prio=5 tid=1 Native",
                "  at android.graphics.HardwareRenderer.nSetSurfaceSecret(Native method)")).topOperation);
    }

    @Test
    public void staticInitializersAndUnknownConstructorsStayFixedCategories() {
        AnrTraceClassifier.Result initializer = AnrTraceClassifier.classify(trace(
                "\"main\" prio=5 tid=1 Runnable",
                "  at com.getcapacitor.PrivateInitializer.<clinit>(/private/secret:42)",
                "  at com.bridge.app.MainActivity.onCreate(MainActivity.java:49)"));
        assertEquals("capacitor", initializer.subsystem);
        assertEquals("topOperation=class-init ownerOperation=class-init", initializer.operationMarker());
        AnrTraceClassifier.Result unknown = AnrTraceClassifier.classify(trace(
                "\"main\" prio=5 tid=1 Runnable",
                "  at com.secret.Customer.<init>(/private/secret:42)"));
        assertEquals("other-app", unknown.subsystem);
        assertEquals("topOperation=constructor ownerOperation=constructor", unknown.operationMarker());
    }
}
