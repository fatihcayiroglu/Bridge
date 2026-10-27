package com.bridge.app;

import android.net.Uri;
import android.os.SystemClock;
import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

// #209: DEBUG-only control. Bridge's own packaged web content (assets/public,
// the same files Capacitor serves) in a plain WebView, WITHOUT Capacitor, its
// bridge or plugins. Comparing its cold-start main-thread stalls with
// MainActivity's (SF05) separates the cost of Bridge's page from the cost of
// Capacitor start-up. Same https://localhost origin as Capacitor; anything not
// in the packaged assets falls through to the WebView's normal loading.
public final class WebViewBridgeContentBaselineActivity extends android.app.Activity {
    static final String TAG = "BridgeContentControl";
    // #209 SF06: optional first-screen CSS effect classes disabled from the
    // very first parse (a <style> injected into the served index.html), so a
    // cold start can be compared with and without them. Fixed names only.
    static final String EXTRA_VARIANT = "variant";
    static final String FILTERS = "*,*::before,*::after{filter:none!important;"
            + "backdrop-filter:none!important;-webkit-backdrop-filter:none!important}";
    static final String SHADOWS = "*,*::before,*::after{box-shadow:none!important;text-shadow:none!important}";
    static final String TEXT_CLIP = "*,*::before,*::after{-webkit-background-clip:border-box!important;"
            + "background-clip:border-box!important;-webkit-text-fill-color:currentColor!important}";
    static final String ANIMATIONS = "*,*::before,*::after{animation:none!important;transition:none!important}";
    static final String EFFECTS = FILTERS + SHADOWS + TEXT_CLIP + ANIMATIONS;
    private WebView view;

    /** CSS for a known variant; null for "none" or anything unknown. */
    static String variantCss(String variant) {
        if ("no-filters".equals(variant)) return FILTERS;
        if ("no-shadows".equals(variant)) return SHADOWS;
        if ("no-text-clip".equals(variant)) return TEXT_CLIP;
        if ("no-animations".equals(variant)) return ANIMATIONS;
        if ("no-effects".equals(variant)) return EFFECTS;
        return null;
    }

    static String knownVariant(String variant) {
        return variantCss(variant) != null ? variant : "none";
    }

    /** Inserts the style before the first </head>, else at the start. */
    static String inject(String html, String css) {
        String style = "<style data-bridge-sf06>" + css + "</style>";
        int head = html.indexOf("</head>");
        return head >= 0 ? html.substring(0, head) + style + html.substring(head) : style + html;
    }

    @Override
    public void onCreate(android.os.Bundle state) {
        super.onCreate(state);
        final long startedAt = SystemClock.uptimeMillis();
        final String variant = knownVariant(getIntent() == null ? null : getIntent().getStringExtra(EXTRA_VARIANT));
        final String css = variantCss(variant);
        Log.i(TAG, "event=variant name=" + variant);
        view = new WebView(this);
        view.getSettings().setJavaScriptEnabled(true);
        view.getSettings().setDomStorageEnabled(true);
        view.setWebViewClient(new WebViewClient() {
            private boolean reported;

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (!"https".equals(url.getScheme()) || !"localhost".equals(url.getHost())) return null;
                String path = url.getPath();
                if (path == null || path.isEmpty() || "/".equals(path)) path = "/index.html";
                if (path.contains("..")) return null;
                try {
                    InputStream asset = getAssets().open("public" + path);
                    if (css != null && "/index.html".equals(path)) {
                        String html = new String(readAll(asset), StandardCharsets.UTF_8);
                        asset = new ByteArrayInputStream(inject(html, css).getBytes(StandardCharsets.UTF_8));
                    }
                    return new WebResourceResponse(mimeOf(path), null, asset);
                } catch (IOException missing) {
                    return null;
                }
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                if (reported) return;
                reported = true;
                // Fixed format, numbers only.
                Log.i(TAG, "event=page-finished ms=" + Math.min(SystemClock.uptimeMillis() - startedAt, 999_999L));
            }
        });
        setContentView(view);
        view.loadUrl("https://localhost/");
    }

    static byte[] readAll(InputStream in) throws IOException {
        try (InputStream source = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16_384];
            int read;
            while ((read = source.read(buffer)) != -1) {
                if (out.size() + read > 4 * 1024 * 1024) throw new IOException("index.html too large");
                out.write(buffer, 0, read);
            }
            return out.toByteArray();
        }
    }

    static String mimeOf(String path) {
        String p = path.toLowerCase(java.util.Locale.ROOT);
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json") || p.endsWith(".webmanifest")) return "application/json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".webp")) return "image/webp";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".woff")) return "font/woff";
        if (p.endsWith(".wasm")) return "application/wasm";
        return "application/octet-stream";
    }

    @Override
    protected void onDestroy() {
        if (view != null) {
            view.destroy();
            view = null;
        }
        super.onDestroy();
    }
}
