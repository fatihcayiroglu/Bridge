package com.bridge.app;

import com.getcapacitor.BridgeActivity;

/**
 * ════════════════════════════════════════════════════════════════════════════
 * BRIDGE ANDROID GİRİŞ NOKTASI
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Gövde KASITLI OLARAK boştur: tüm ürün davranışı WebView katmanında
 * (`mobile/capacitor-bridge.ts`) yaşar. `BridgeActivity` yaşam döngüsünü,
 * eklenti köprüsünü ve WebView kurulumunu zaten yapar.
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
}
