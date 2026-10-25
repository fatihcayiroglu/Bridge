package com.bridge.nativepreview

/** Test evidence contains enums/booleans only, never package names or UI text. */
enum class NativeForeground(val wire: String) {
    PREVIEW("preview"), LAUNCHER("launcher"), SYSTEM_UI("system-ui"),
    PERMISSION_CONTROLLER("permission-controller"), OTHER("other"), UNAVAILABLE("unavailable");

    companion object {
        fun fromPackage(value: String?): NativeForeground = when (value) {
            null -> UNAVAILABLE
            "com.bridge.nativepreview" -> PREVIEW
            "com.google.android.apps.nexuslauncher", "com.android.launcher3", "com.android.launcher" -> LAUNCHER
            "com.android.systemui" -> SYSTEM_UI
            "com.android.permissioncontroller", "com.google.android.permissioncontroller" -> PERMISSION_CONTROLLER
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
) {
    fun report(failure: NativeStartupFailure): String =
        "startup=${failure.wire};screen-on=${value(screenOn)};keyguard-locked=${value(keyguardLocked)};" +
        "foreground=${foreground.wire};heading-visible=${value(headingVisible)};" +
        "edit-text-visible=${value(editTextVisible)};input-id-visible=${value(inputByIdVisible)};" +
        "input-label=${inputLabel.wire}"

    private fun value(flag: Boolean?): String = flag?.toString() ?: "unknown"
}
