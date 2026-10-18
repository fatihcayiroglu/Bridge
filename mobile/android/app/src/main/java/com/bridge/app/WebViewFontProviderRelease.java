package com.bridge.app;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.os.SystemClock;
import android.util.Log;
import android.webkit.WebSettings;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Android #209: release a STABLE Google Play Services FontsProvider reference
 * that older Android System WebView builds leak into the app process.
 *
 * <p>Upstream mechanism (verified against source, not inferred from timing):
 * <ol>
 *   <li>On renderer start, Blink's {@code FontUniqueNameLookupAndroid::Init}
 *       asks the browser side to {@code FetchAllFontFiles} (Google Sans,
 *       Noto Color Emoji Compat) from {@code com.google.android.gms.fonts}.</li>
 *   <li>Chromium's {@code AndroidFontLookupImpl.tryFetchFont} opens the font
 *       with {@code ContentResolver.openFileDescriptor}. AOSP returns a
 *       {@code ParcelFileDescriptorInner} that holds a STABLE provider
 *       reference until {@code releaseResources()} runs.</li>
 *   <li>Before Chromium 117.0.5938.60 that wrapper went straight to
 *       {@code CoreImpl.wrapFileDescriptor}, which calls {@code detachFd()}.
 *       For a wrapping descriptor AOSP's {@code detachFd()} delegates to the
 *       inner descriptor and never calls the wrapper's
 *       {@code releaseResources()}; only {@code finalize()} does. The stable
 *       reference therefore lives until the unreachable wrapper is garbage
 *       collected and finalized. 117.0.5938.60+ dups the descriptor and closes
 *       the original immediately (verified: absent at 117.0.5938.0, present
 *       at 117.0.5938.60).</li>
 *   <li>While any stable reference exists, ActivityManager kills the app with
 *       {@code REASON_DEPENDENCY_DIED} if the providing GMS process dies
 *       ({@code ContentProviderHelper.removeDyingProviderLocked}); unstable-only
 *       clients are merely notified.</li>
 * </ol>
 *
 * <p>The wrapper is already garbage: Bridge holds nothing and changes no
 * provider, GMS or WebView state. Running the finalizer that AOSP itself
 * relies on simply ends the exposure window early instead of "whenever the
 * next GC happens", which in an idle app can be the rest of the process
 * lifetime. Up-to-date WebView never reaches this code.
 */
final class WebViewFontProviderRelease {
    static final String LOG_TAG = "BridgeFontRefRelease";
    static final String GMS_FONTS_AUTHORITY = "com.google.android.gms.fonts";

    /** After the first page load: once for the renderer's prefetch, once as a backstop. */
    static final long[] PASS_DELAYS_MS = { 1_500L, 8_500L };

    private static final Pattern CHROME_VERSION =
            Pattern.compile("\\bChrome/(\\d{1,4})\\.(\\d{1,4})\\.(\\d{1,6})\\.(\\d{1,6})\\b");
    private static final AtomicBoolean SCHEDULED = new AtomicBoolean(false);

    private WebViewFontProviderRelease() {}

    /**
     * True only for Chromium builds that predate the upstream fix. Unknown or
     * non-Chromium user agents return false: no action without positive
     * identification.
     */
    static boolean isLeakingChromium(String userAgent) {
        if (userAgent == null) return false;
        Matcher m = CHROME_VERSION.matcher(userAgent);
        if (!m.find()) return false;
        try {
            return isLeakingChromium(Integer.parseInt(m.group(1)), Integer.parseInt(m.group(3)),
                    Integer.parseInt(m.group(4)));
        } catch (NumberFormatException e) {
            return false;
        }
    }

    static boolean isLeakingChromium(int major, int build, int patch) {
        if (major != 117) return major < 117;
        // The fix landed on the M117 branch between 117.0.5938.0 and .60.
        return build < 5938 || (build == 5938 && patch < 60);
    }

    /**
     * Schedule the release passes once per process, off the main thread.
     * Call on the main thread after the first page load, so the renderer
     * prefetch has started; later calls are no-ops.
     */
    static void scheduleAfterFirstPageLoad(Context context) {
        if (!SCHEDULED.compareAndSet(false, true)) return;
        final Context app = context.getApplicationContext();
        final boolean debuggable = isDebuggable(app);
        String userAgent;
        try {
            userAgent = WebSettings.getDefaultUserAgent(app);
        } catch (RuntimeException e) {
            userAgent = null;
        }
        if (!isLeakingChromium(userAgent)) {
            marker(debuggable, "stage=skipped reason=webview-not-affected");
            return;
        }
        Thread worker = new Thread(() -> {
            // No provider means WebView cannot have acquired it either.
            if (app.getPackageManager().resolveContentProvider(GMS_FONTS_AUTHORITY, 0) == null) {
                marker(debuggable, "stage=skipped reason=provider-unavailable");
                return;
            }
            for (int i = 0; i < PASS_DELAYS_MS.length; i++) {
                SystemClock.sleep(PASS_DELAYS_MS[i]);
                runFinalizationPass();
                marker(debuggable, "stage=released pass=" + (i + 1));
            }
        }, LOG_TAG);
        worker.setDaemon(true);
        worker.setPriority(Thread.MIN_PRIORITY);
        worker.start();
    }

    /**
     * Collect and finalize unreachable objects. Twice, because a finalizable
     * object needs one GC to be discovered and its finalizer to run before
     * anything it alone kept alive can be reclaimed. Blocks the caller: never
     * call on the main thread.
     */
    static void runFinalizationPass() {
        Runtime.getRuntime().gc();
        System.runFinalization();
        Runtime.getRuntime().gc();
        System.runFinalization();
    }

    private static boolean isDebuggable(Context context) {
        return (context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    /** Fixed debug-only markers for the emulator harness; no PIDs, URLs or user data. */
    private static void marker(boolean debuggable, String message) {
        if (debuggable) Log.i(LOG_TAG, message);
    }
}
