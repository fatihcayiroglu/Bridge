package com.bridge.app;

import com.getcapacitor.BridgeActivity;

/**
 * ════════════════════════════════════════════════════════════════════════════
 * BRIDGE ANDROID GİRİŞ NOKTASI
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Gövde KASITLI OLARAK küçüktür: ürün davranışı WebView katmanında
 * (`mobile/capacitor-bridge.ts`) yaşar. `BridgeActivity` yaşam döngüsünü,
 * eklenti köprüsünü ve WebView kurulumunu zaten yapar. Tek yerel ek (P4):
 * `BridgePushSupportPlugin` kaydı — aşağıdaki onCreate'e bakın.
 *
 * ── NEDEN JAVA, NEDEN KOTLIN DEĞİL (Final21, Faz 3) ────────────────────────
 * Burada eskiden `MainActivity.kt` vardı ve `app/build.gradle`
 * `apply plugin: 'kotlin-android'` diyordu. Ama `mobile/BUILD.md`de belgelenen
 * üretim adımı (`npx cap add android`) Capacitor 8'de JAVA tabanlı bir iskele
 * üretir ve kök `build.gradle`a Kotlin Gradle eklentisinin classpath'ini
 * KOYMAZ. Belgelenen yol harfiyen izlendiğinde derleme şununla duruyordu:
 *
 *     Plugin with id 'kotlin-android' not found.
 *     Android Gradle Plugin: project ':app' does not specify `compileSdk`
 *     (birincinin yan etkisi — kök değerlendirmesi yarıda kesildiği için
 *      `variables.gradle`taki ext hiç uygulanmıyordu)
 *
 * Yani depo, KULLANILMAYAN bir araç zincirine bağımlıydı: tek Kotlin dosyası
 * buydu ve içi boştu. Kotlin'i kaldırmak hiçbir davranış kaybettirmez, buna
 * karşılık belgelenen derleme yolunu ÇALIŞIR hâle getirir. Gerçekten Kotlin
 * native kod yazılacağı gün eklentiyi eklemek bilinçli bir adım olur.
 */
public class MainActivity extends BridgeActivity {

    /**
     * P4: local plugins are registered BEFORE the bridge is created in super.onCreate().
     * BridgePushSupport tells the web layer whether FCM is configured so it never calls
     * PushNotifications.register() on a build where that call crashes the process.
     */
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        // #209 A/B probe: debug-only, class-presence-only diagnostic.
        // Never call static EmojiCompat methods during observation; they can
        // initialize the class and contaminate FD01 attribution.
        // No compile-time emoji2 dependency or runtime font lookup is added.
        logEmojiStartup("before-super");
        registerPlugin(BridgePushSupportPlugin.class);
        super.onCreate(savedInstanceState);
        logEmojiStartup("after-super");
        // #209: WebView builds without the upstream fix (M117 branch below
        // 117.0.5938.29, trunk below 118.0.5971.0, most M116 builds and
        // everything older) leak a STABLE GMS FontsProvider reference (a
        // DEPENDENCY DIED kill path) until the leaked descriptor wrapper is
        // garbage-collected and finalized. Version-gated (all of M116 counts as
        // leaking); on fixed WebView only a user-agent check runs. See the class.
        if (getBridge() != null) {
            getBridge().addWebViewListener(new com.getcapacitor.WebViewListener() {
                @Override
                public void onPageLoaded(android.webkit.WebView webView) {
                    WebViewFontProviderRelease.scheduleAfterFirstPageLoad(MainActivity.this);
                }
            });
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        logEmojiStartup("resumed");
    }

    private void logEmojiStartup(String stage) {
        // Android #209 A/B experiment: reflection on a STATIC method can
        // initialize EmojiCompat even when isConfigured() reports false.
        // This diagnostic must not become the possible cause of the very
        // FontsProvider connection it is supposed to observe.
        //
        // Class.forName(..., false) checks availability WITHOUT class
        // initialization. Configuration status is intentionally UNKNOWN,
        // not reported as false; PID-filtered OS provider evidence remains
        // authoritative for the unchanged strict FD01 test.
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) == 0) {
            return;
        }
        boolean classPresent = false;
        try {
            Class.forName(
                    "androidx.emoji2.text.EmojiCompat", false, getClassLoader());
            classPresent = true;
        } catch (ClassNotFoundException | LinkageError | SecurityException ignored) {
            // Unavailable does not imply configured=false or provider-free.
        }
        android.util.Log.i("BridgeEmojiStartupProbe",
                "stage=" + stage + " classPresent=" + classPresent
                        + " configured=unknown");
    }
}
