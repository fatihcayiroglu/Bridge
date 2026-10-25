package com.bridge.nativepreview

import org.junit.Assert.*
import org.junit.Test

class NativeStartupObservationTest {
    @Test fun privatePackageAndDescriptionCannotEnterEvidence() {
        val privatePackage = "private.customer.application"
        val privateDescription = "Server address, private.internal.host"
        val observation = NativeStartupObservation(true, false,
            NativeForeground.fromPackage(privatePackage), null, true, true, true,
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
        assertEquals(NativeForeground.UNAVAILABLE, NativeForeground.fromPackage(null))
    }

    @Test fun processObservationExportsOnlyBooleansAndKeepsFailureStatus() {
        val processAlive = NativeStartupObservation(true, false, NativeForeground.OTHER,
            true, false, false, false, NativeInputLabel.UNAVAILABLE)
            .report(NativeStartupFailure.FORM_NOT_VISIBLE)
        val processAbsent = NativeStartupObservation(true, false, NativeForeground.OTHER,
            false, false, false, false, NativeInputLabel.UNAVAILABLE)
            .report(NativeStartupFailure.FORM_NOT_VISIBLE)
        assertTrue(processAlive.contains("target-process-alive=true"))
        assertTrue(processAbsent.contains("target-process-alive=false"))
        assertTrue(processAlive.contains("startup=form-not-visible"))
        assertTrue(processAbsent.contains("startup=form-not-visible"))
        assertFalse(processAlive.contains("pidof"))
        assertFalse(processAbsent.contains("pidof"))
    }

    @Test fun distinguishesMissingAccessibleLabelFromComposedAndExactLabels() {
        assertEquals(NativeInputLabel.EXACT, NativeInputLabel.fromDescription("Server address"))
        assertEquals(NativeInputLabel.INCLUDES_LABEL, NativeInputLabel.fromDescription("Server address, https://chat.example.com"))
        assertEquals(NativeInputLabel.MISSING, NativeInputLabel.fromDescription("private-account-value"))
        assertEquals(NativeInputLabel.UNAVAILABLE, NativeInputLabel.fromDescription(null))
    }

    @Test fun missingPlatformObservationsStayUnknownAndCannotImplySuccess() {
        val observation = NativeStartupObservation(null, null, NativeForeground.UNAVAILABLE,
            null, null, null, null, NativeInputLabel.UNAVAILABLE)
        val report = observation.report(NativeStartupFailure.KEYGUARD_NOT_UNLOCKED)
        assertTrue(report.contains("startup=keyguard-not-unlocked"))
        assertTrue(report.contains("screen-on=unknown"))
        assertTrue(report.contains("keyguard-locked=unknown"))
        assertTrue(report.contains("foreground=unavailable"))
        assertTrue(report.contains("target-process-alive=unknown"))
        assertFalse(report.contains("PASS"))
    }
}
