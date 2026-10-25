package com.bridge.nativepreview

import org.junit.Assert.*
import org.junit.Test

class NativeStartupObservationTest {
    @Test fun privatePackageAndDescriptionCannotEnterEvidence() {
        val privatePackage = "private.customer.application"
        val privateDescription = "Server address, private.internal.host"
        val observation = NativeStartupObservation(true, false,
            NativeForeground.fromPackage(privatePackage), true, true, true,
            NativeInputLabel.fromDescription(privateDescription))
        val report = observation.report(NativeStartupFailure.FORM_NOT_VISIBLE)
        assertFalse(report.contains(privatePackage))
        assertFalse(report.contains(privateDescription))
        assertFalse(report.contains("private"))
        assertTrue(report.contains("foreground=other"))
        assertTrue(report.contains("input-label=includes-label"))
        assertTrue(report.length < 300)
    }

    @Test fun classifiesKnownForegroundPackagesWithoutEmittingTheirNames() {
        assertEquals(NativeForeground.PREVIEW, NativeForeground.fromPackage("com.bridge.nativepreview"))
        assertEquals(NativeForeground.LAUNCHER, NativeForeground.fromPackage("com.android.launcher3"))
        assertEquals(NativeForeground.SYSTEM_UI, NativeForeground.fromPackage("com.android.systemui"))
        assertEquals(NativeForeground.PERMISSION_CONTROLLER, NativeForeground.fromPackage("com.android.permissioncontroller"))
        assertEquals(NativeForeground.ANDROID_SYSTEM, NativeForeground.fromPackage("android"))
        assertEquals(NativeForeground.TEST_RUNNER, NativeForeground.fromPackage("com.bridge.nativepreview.test"))
        assertEquals(NativeForeground.INPUT_METHOD, NativeForeground.fromPackage("com.google.android.inputmethod.latin"))
        assertEquals(NativeForeground.SETTINGS, NativeForeground.fromPackage("com.android.settings"))
        assertEquals(NativeForeground.SETUP, NativeForeground.fromPackage("com.google.android.setupwizard"))
        assertEquals(NativeForeground.UNAVAILABLE, NativeForeground.fromPackage(null))
    }

    @Test fun classifiesSystemAlertsWithoutPublishingTheirPrivateAppTitles() {
        for ((title, expected) in listOf(
            "Private medical app isn't responding" to NativeSystemAlert.ANR,
            "Private account app isn’t responding" to NativeSystemAlert.ANR,
            "Private app keeps stopping" to NativeSystemAlert.CRASH,
            "Private app has stopped" to NativeSystemAlert.CRASH,
            "Private account action" to NativeSystemAlert.OTHER,
            null to NativeSystemAlert.NONE,
        )) {
            val alert = NativeSystemAlert.fromTitle(title)
            assertEquals(expected, alert)
            val report = NativeStartupObservation(true, false, NativeForeground.ANDROID_SYSTEM,
                false, false, false, NativeInputLabel.UNAVAILABLE, alert)
                .report(NativeStartupFailure.FORM_NOT_VISIBLE)
            assertFalse(report.contains("Private"))
            assertTrue(report.contains("system-alert=${expected.wire}"))
        }
    }

    @Test fun distinguishesMissingAccessibleLabelFromComposedAndExactLabels() {
        assertEquals(NativeInputLabel.EXACT, NativeInputLabel.fromDescription("Server address"))
        assertEquals(NativeInputLabel.INCLUDES_LABEL, NativeInputLabel.fromDescription("Server address, https://chat.example.com"))
        assertEquals(NativeInputLabel.MISSING, NativeInputLabel.fromDescription("private-account-value"))
        assertEquals(NativeInputLabel.UNAVAILABLE, NativeInputLabel.fromDescription(null))
    }

    @Test fun missingPlatformObservationsStayUnknownAndCannotImplySuccess() {
        val observation = NativeStartupObservation(null, null, NativeForeground.UNAVAILABLE,
            null, null, null, NativeInputLabel.UNAVAILABLE)
        val report = observation.report(NativeStartupFailure.KEYGUARD_NOT_UNLOCKED)
        assertTrue(report.contains("startup=keyguard-not-unlocked"))
        assertTrue(report.contains("screen-on=unknown"))
        assertTrue(report.contains("keyguard-locked=unknown"))
        assertTrue(report.contains("foreground=unavailable"))
        assertFalse(report.contains("PASS"))
    }
}
