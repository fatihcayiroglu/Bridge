package com.bridge.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** #209 SF06: only fixed CSS variants are injected, before the first </head>. */
public class WebViewBridgeContentBaselineActivityTest {
    @Test
    public void onlyKnownVariantsSelectCss() {
        assertEquals("none", WebViewBridgeContentBaselineActivity.knownVariant(null));
        assertEquals("none", WebViewBridgeContentBaselineActivity.knownVariant("none"));
        assertEquals("none", WebViewBridgeContentBaselineActivity.knownVariant("<script>"));
        assertNull(WebViewBridgeContentBaselineActivity.variantCss("none"));
        assertEquals("no-filters", WebViewBridgeContentBaselineActivity.knownVariant("no-filters"));
        assertTrue(WebViewBridgeContentBaselineActivity.variantCss("no-filters").contains("filter:none!important"));
        assertTrue(WebViewBridgeContentBaselineActivity.variantCss("no-shadows").contains("box-shadow:none!important"));
        String effects = WebViewBridgeContentBaselineActivity.variantCss("no-effects");
        assertTrue(effects.contains("filter:none!important") && effects.contains("box-shadow:none!important")
                && effects.contains("animation:none!important"));
    }

    @Test
    public void styleGoesBeforeTheFirstHeadClose() {
        assertEquals("<html><head><title>t</title><style data-bridge-sf06>x</style></head><body></body></html>",
                WebViewBridgeContentBaselineActivity.inject("<html><head><title>t</title></head><body></body></html>", "x"));
        assertEquals("<style data-bridge-sf06>x</style><p>no head</p>",
                WebViewBridgeContentBaselineActivity.inject("<p>no head</p>", "x"));
    }
}
