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
        registerPlugin(BridgePushSupportPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
