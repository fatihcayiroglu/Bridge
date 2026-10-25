package com.bridge.nativepreview

/** Test evidence contains enums/booleans only, never package names or UI text. */
enum class NativeForeground(val wire: String) {
    PREVIEW("preview"), LAUNCHER("launcher"), SYSTEM_UI("system-ui"),
    PERMISSION_CONTROLLER("permission-controller"), ANDROID_SYSTEM("android-system"),
    TEST_RUNNER("test-runner"), INPUT_METHOD("input-method"), SETTINGS("settings"),
    SETUP("setup"), OTHER("other"), UNAVAILABLE("unavailable");

    companion object {
        fun fromPackage(value: String?): NativeForeground = when (value) {
            null -> UNAVAILABLE
            "com.bridge.nativepreview" -> PREVIEW
            "com.google.android.apps.nexuslauncher", "com.android.launcher3", "com.android.launcher" -> LAUNCHER
            "com.android.systemui" -> SYSTEM_UI
            "com.android.permissioncontroller", "com.google.android.permissioncontroller" -> PERMISSION_CONTROLLER
            "android" -> ANDROID_SYSTEM
            "com.bridge.nativepreview.test", "androidx.test.services", "androidx.test.orchestrator" -> TEST_RUNNER
            "com.google.android.inputmethod.latin", "com.android.inputmethod.latin" -> INPUT_METHOD
            "com.android.settings" -> SETTINGS
            "com.google.android.setupwizard", "com.android.provision", "com.google.android.apps.restore" -> SETUP
            else -> OTHER
        }
    }
}

enum class NativeSystemAlert(val wire: String) {
    ANR("anr"), CRASH("crash"), OTHER("other"), NONE("none"), UNAVAILABLE("unavailable");

    companion object {
        fun fromTitle(value: String?): NativeSystemAlert = when {
            value == null -> NONE
            value.contains("isn't responding", ignoreCase = true) ||
                value.contains("isn’t responding", ignoreCase = true) ||
                value.contains("not responding", ignoreCase = true) -> ANR
            value.contains("keeps stopping", ignoreCase = true) ||
                value.contains("has stopped", ignoreCase = true) -> CRASH
            else -> OTHER
        }
    }
}

enum class NativeInputLabel(val wire: String) {
    EXACT("exact"), INCLUDES_LABEL("includes-label"), MISSING("missing"), UNAVAILABLE("unavailable");

    companion object {
        fun fromDescription(value: String?): NativeInputLabel = when {
            value == null -> UNAVAILABLE
            value == "Server address" -> EXACT
            value.contains("Server address") -> INCLUDES_LABEL
            else -> MISSING
        }
    }
}

enum class NativeStartupFailure(val wire: String) {
    SCREEN_UNAVAILABLE("screen-unavailable"), KEYGUARD_NOT_UNLOCKED("keyguard-not-unlocked"),
    FORM_NOT_VISIBLE("form-not-visible");
}

data class NativeStartupObservation(
    val screenOn: Boolean?, val keyguardLocked: Boolean?, val foreground: NativeForeground,
    val headingVisible: Boolean?, val editTextVisible: Boolean?, val inputByIdVisible: Boolean?,
    val inputLabel: NativeInputLabel,
    val systemAlert: NativeSystemAlert = NativeSystemAlert.UNAVAILABLE,
) {
    fun report(failure: NativeStartupFailure): String =
        "startup=${failure.wire};screen-on=${value(screenOn)};keyguard-locked=${value(keyguardLocked)};" +
        "foreground=${foreground.wire};heading-visible=${value(headingVisible)};" +
        "edit-text-visible=${value(editTextVisible)};input-id-visible=${value(inputByIdVisible)};" +
        "input-label=${inputLabel.wire};system-alert=${systemAlert.wire}"

    private fun value(flag: Boolean?): String = flag?.toString() ?: "unknown"
}
