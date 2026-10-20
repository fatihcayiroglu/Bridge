package com.bridge.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** #209: the release must run on leaking WebView builds only, never on unknown ones. */
public class WebViewFontProviderReleaseTest {
    private static String ua(String chrome) {
        return "Mozilla/5.0 (Linux; Android 14; sdk_gphone64_x86_64 Build/UE1A.230829.036.A1; wv) "
                + "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/" + chrome
                + " Mobile Safari/537.36";
    }

    @Test
    public void leakingBuildsBeforeTheUpstreamFix() {
        // API 34 Google APIs emulator image used by CI.
        assertTrue(WebViewFontProviderRelease.isLeakingChromium(ua("113.0.5672.136")));
        assertTrue(WebViewFontProviderRelease.isLeakingChromium(ua("116.0.5845.96")));
        assertTrue(WebViewFontProviderRelease.isLeakingChromium(ua("117.0.5938.0")));
        // Last unfixed builds, verified by tag on the M117 branch and on trunk.
        assertTrue(WebViewFontProviderRelease.isLeakingChromium(ua("117.0.5938.28")));
        assertTrue(WebViewFontProviderRelease.isLeakingChromium(ua("118.0.5970.0")));
        assertTrue(WebViewFontProviderRelease.isLeakingChromium(ua("118.0.5950.3")));
        assertTrue(WebViewFontProviderRelease.isLeakingChromium(ua("117.0.5900.12")));
        // Older than any build read; assumed to leak (an extra GC is harmless).
        assertTrue(WebViewFontProviderRelease.isLeakingChromium(ua("83.0.4103.106")));
        // Trunk before the fix, on an M118 version number.
        assertTrue(WebViewFontProviderRelease.isLeakingChromium(ua("118.0.5939.0")));
    }

    @Test
    public void m116IsTreatedAsLeakingEvenWhereABackportLanded() {
        // Read by tag: .140 to .153 lack the fix; .124, .163 and .188 carry a
        // backport. The gate does not track patch-level backports on M116.
        assertTrue(WebViewFontProviderRelease.isLeakingChromium(ua("116.0.5845.140")));
        assertTrue(WebViewFontProviderRelease.isLeakingChromium(ua("116.0.5845.153")));
        assertTrue(WebViewFontProviderRelease.isLeakingChromium(ua("116.0.5845.124")));
        assertTrue(WebViewFontProviderRelease.isLeakingChromium(ua("116.0.5845.188")));
    }

    @Test
    public void reducedUserAgentsErrOnTheLeakingSideBelowM119() {
        // A reduced user agent hides the build and patch numbers.
        assertTrue(WebViewFontProviderRelease.isLeakingChromium(ua("117.0.0.0")));
        assertTrue(WebViewFontProviderRelease.isLeakingChromium(ua("118.0.0.0")));
        assertFalse(WebViewFontProviderRelease.isLeakingChromium(ua("119.0.0.0")));
        assertFalse(WebViewFontProviderRelease.isLeakingChromium(ua("119.0.6045.0")));
    }

    @Test
    public void fixedBuildsAreLeftAlone() {
        // First fixed builds on the M117 branch and on trunk.
        assertFalse(WebViewFontProviderRelease.isLeakingChromium(ua("117.0.5938.29")));
        assertFalse(WebViewFontProviderRelease.isLeakingChromium(ua("118.0.5971.0")));
        assertFalse(WebViewFontProviderRelease.isLeakingChromium(ua("117.0.5938.60")));
        assertFalse(WebViewFontProviderRelease.isLeakingChromium(ua("117.0.5938.140")));
        assertFalse(WebViewFontProviderRelease.isLeakingChromium(ua("118.0.5993.0")));
        // API 35 Google APIs emulator image.
        assertFalse(WebViewFontProviderRelease.isLeakingChromium(ua("124.0.6367.219")));
        assertFalse(WebViewFontProviderRelease.isLeakingChromium(ua("141.0.7390.122")));
    }

    @Test
    public void unknownOrMalformedUserAgentsAreNotAffected() {
        assertFalse(WebViewFontProviderRelease.isLeakingChromium(null));
        assertFalse(WebViewFontProviderRelease.isLeakingChromium(""));
        assertFalse(WebViewFontProviderRelease.isLeakingChromium("Mozilla/5.0 (Linux; Android 14; wv)"));
        assertFalse(WebViewFontProviderRelease.isLeakingChromium(ua("113")));
        assertFalse(WebViewFontProviderRelease.isLeakingChromium(ua("113.0.5672")));
        assertFalse(WebViewFontProviderRelease.isLeakingChromium(ua("abc.0.5672.136")));
        assertFalse(WebViewFontProviderRelease.isLeakingChromium(
                ua("113.0.5672.136").replace("Chrome/", "HeadlessChrome/")));
        assertFalse(WebViewFontProviderRelease.isLeakingChromium(ua("99999.0.5672.136")));
    }
}
