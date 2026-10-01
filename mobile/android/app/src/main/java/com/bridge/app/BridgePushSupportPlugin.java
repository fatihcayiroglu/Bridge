package com.bridge.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.lang.reflect.Method;
import java.util.List;

/**
 * P4 — IS FCM ACTUALLY CONFIGURED IN THIS APK?
 *
 * MEASURED (Android 14 emulator, debug APK built the documented way, no google-services.json —
 * the default for a self-hosted build): once the notification permission is granted, the bridge's
 * PushNotifications.register() reached FirebaseMessaging.getInstance() and the app DIED:
 *
 *   IllegalStateException: Default FirebaseApp is not initialized in this process
 *     at com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin.register
 *
 * On Android 12 and older the notification permission is granted by default, so every launch
 * would crash. JavaScript cannot see whether Firebase was bundled, so this plugin answers the
 * question natively. Reflection keeps the app free of a compile-time Firebase dependency: the
 * class is present through the push plugin, and FirebaseApp.getApps(context) is empty exactly
 * when FirebaseInitProvider found no configuration.
 */
@CapacitorPlugin(name = "BridgePushSupport")
public class BridgePushSupportPlugin extends Plugin {

    @PluginMethod
    public void status(PluginCall call) {
        JSObject result = new JSObject();
        boolean available = false;
        String reason = "firebase_not_configured";
        try {
            Class<?> firebaseApp = Class.forName("com.google.firebase.FirebaseApp");
            Method getApps = firebaseApp.getMethod("getApps", android.content.Context.class);
            Object apps = getApps.invoke(null, getContext());
            available = apps instanceof List && !((List<?>) apps).isEmpty();
            if (available) reason = "ok";
        } catch (ClassNotFoundException missing) {
            reason = "firebase_not_bundled";
        } catch (Throwable error) {
            reason = "firebase_check_failed";
        }
        result.put("available", available);
        result.put("reason", reason);
        call.resolve(result);
    }
}
