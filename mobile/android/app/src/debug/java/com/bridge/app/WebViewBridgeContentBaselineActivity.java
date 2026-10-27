package com.bridge.app;

import android.net.Uri;
import android.os.SystemClock;
import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.IOException;

// #209: DEBUG-only control. Bridge's own packaged web content (assets/public,
// the same files Capacitor serves) in a plain WebView, WITHOUT Capacitor, its
// bridge or plugins. Comparing its cold-start main-thread stalls with
// MainActivity's (SF05) separates the cost of Bridge's page from the cost of
// Capacitor start-up. Same https://localhost origin as Capacitor; anything not
// in the packaged assets falls through to the WebView's normal loading.
public final class WebViewBridgeContentBaselineActivity extends android.app.Activity {
    static final String TAG = "BridgeContentControl";
    private WebView view;

    @Override
    public void onCreate(android.os.Bundle state) {
        super.onCreate(state);
        final long startedAt = SystemClock.uptimeMillis();
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
                    return new WebResourceResponse(mimeOf(path), null, getAssets().open("public" + path));
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
