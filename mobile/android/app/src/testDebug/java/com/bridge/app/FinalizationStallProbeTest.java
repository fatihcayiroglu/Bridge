package com.bridge.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import java.util.concurrent.TimeoutException;
import org.junit.Test;

/** #209 FD00G: stall/uncaught classification is enum-only and fails closed. */
public class FinalizationStallProbeTest {
    private static StackTraceElement f(String cls, String method) {
        return new StackTraceElement(cls, method, "X.java", 1);
    }

    @Test
    public void passThreadWaitingForFinalizersAndDaemonInsidePfdBinderCall() {
        StackTraceElement[] pass = {
            f("java.lang.Object", "wait"),
            f("java.lang.ref.FinalizerReference$Sentinel", "awaitFinalization"),
            f("java.lang.ref.FinalizerReference", "finalizeAllEnqueued"),
            f("java.lang.Runtime", "runFinalization"),
            f("com.bridge.app.WebViewFontProviderRelease", "runFinalizationPass"),
        };
        StackTraceElement[] daemon = {
            f("android.os.BinderProxy", "transactNative"),
            f("android.os.BinderProxy", "transact"),
            f("android.app.IActivityManager$Stub$Proxy", "refContentProvider"),
            f("android.app.ActivityThread", "releaseProvider"),
            f("android.content.ContentResolver$ParcelFileDescriptorInner", "releaseResources"),
            f("android.os.ParcelFileDescriptor", "finalize"),
            f("java.lang.Daemons$FinalizerDaemon", "doFinalize"),
        };
        StackTraceElement[] queueIdle = {
            f("java.lang.Object", "wait"),
            f("java.lang.Daemons$ReferenceQueueDaemon", "runInternal"),
        };
        assertEquals("passThread=WAITING passIn=await-finalization finalizerDaemon=RUNNABLE"
                + " finalizerIn=finalizer-pfd+binder refQueueDaemon=WAITING refQueueIn=other",
                FinalizationStallProbe.stallMarker(Thread.State.WAITING, pass, Thread.State.RUNNABLE, daemon,
                        Thread.State.WAITING, queueIdle));
    }

    @Test
    public void idleDaemonGcAndMissingThreadsAreDistinct() {
        StackTraceElement[] idle = {
            f("java.lang.Object", "wait"),
            f("java.lang.ref.ReferenceQueue", "remove"),
            f("java.lang.Daemons$FinalizerDaemon", "runInternal"),
        };
        StackTraceElement[] gc = { f("java.lang.Runtime", "nativeGc"), f("java.lang.Runtime", "gc") };
        assertEquals("passThread=RUNNABLE passIn=gc finalizerDaemon=WAITING finalizerIn=idle-queue"
                + " refQueueDaemon=missing refQueueIn=none",
                FinalizationStallProbe.stallMarker(Thread.State.RUNNABLE, gc, Thread.State.WAITING, idle, null, null));
        assertEquals("passThread=missing passIn=none finalizerDaemon=missing finalizerIn=none"
                + " refQueueDaemon=missing refQueueIn=none",
                FinalizationStallProbe.stallMarker(null, null, null, null, null, null));
        assertEquals("finalizer-webview",
                FinalizationStallProbe.where(new StackTraceElement[] {
                    f("org.chromium.base.Secret", "finalize") }));
        assertEquals("finalizer-other",
                FinalizationStallProbe.where(new StackTraceElement[] { f("com.customer.Secret", "finalize") }));
    }

    @Test
    public void finalizerWatchdogTimeoutIsRecognisedWithoutLeakingTheClass() {
        assertEquals("kind=finalizer-timeout owner=pfd", FinalizationStallProbe.uncaughtMarker(
                new TimeoutException("android.os.ParcelFileDescriptor.finalize() timed out after 10 seconds")));
        String other = FinalizationStallProbe.uncaughtMarker(
                new TimeoutException("com.customer.Secret.finalize() timed out after 10 seconds"));
        assertEquals("kind=finalizer-timeout owner=other", other);
        assertFalse(other.contains("customer") || other.contains("Secret"));
        // Other real ART watchdog message forms.
        assertEquals("kind=finalizer-timeout owner=none", FinalizationStallProbe.uncaughtMarker(
                new TimeoutException("Unknown finalizer timed out")));
        assertEquals("kind=finalizer-timeout owner=framework", FinalizationStallProbe.uncaughtMarker(
                new TimeoutException("libcore.util.NativeAllocationRegistry$CleanerThunk timed out after 10 seconds")));
        assertEquals("kind=refqueue-timeout owner=none", FinalizationStallProbe.uncaughtMarker(
                new TimeoutException("ReferenceQueueDaemon timed out while targeting com.secret.Thing")));
        assertEquals("kind=other owner=none",
                FinalizationStallProbe.uncaughtMarker(new IllegalStateException("token=secret")));
        assertEquals("kind=other owner=none",
                FinalizationStallProbe.uncaughtMarker(new TimeoutException(null)));
    }
}
