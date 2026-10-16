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
        // #209: debug-only, fixed-shape diagnostic. Probe the optional
        // EmojiCompat class WITHOUT depending on it or initializing it.
        // Prior direct EmojiCompat.isConfigured() broke compileDebugJavaWithJavac
        // because emoji2 isn't even on this build's compile classpath.
        logEmojiStartup("before-super");
        registerPlugin(BridgePushSupportPlugin.class);
        super.onCreate(savedInstanceState);
        logEmojiStartup("after-super");
    }

    @Override
    public void onResume() {
        super.onResume();
        logEmojiStartup("resumed");
    }

    private void logEmojiStartup(String stage) {
        // Only observe class availability. Class.forName(..., false) does not
        // initialize the class or invoke downloadable-font code. No emoji2
        // dependency is added to debug OR release just to make diagnostics run.
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) == 0) {
            return;
        }
        boolean classPresent = false;
        String configured = "unknown";
        try {
            // The AndroidX public isConfigured() API observes initialization
            // without requesting a font download. Use reflection because
            // emoji2 is present at runtime but absent from compileClasspath.
            // Class lookup alone does not initialize the optional class.
            Class<?> emoji = Class.forName(
                    "androidx.emoji2.text.EmojiCompat", false, getClassLoader());
            classPresent = true;
            Object state = emoji.getMethod("isConfigured").invoke(null);
            if (state instanceof Boolean) {
                configured = ((Boolean) state) ? "true" : "false";
            }
        } catch (ReflectiveOperationException | LinkageError | SecurityException e) {
            // Unavailable != false. Preserve this as an unknown diagnostic.
        }
        android.util.Log.i("BridgeEmojiStartupProbe",
                "stage=" + stage + " classPresent=" + classPresent
                        + " configured=" + configured);
    }
}
