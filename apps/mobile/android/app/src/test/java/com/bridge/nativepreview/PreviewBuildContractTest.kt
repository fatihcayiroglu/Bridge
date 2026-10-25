package com.bridge.nativepreview

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Build-policy guards, not lifecycle or feature-parity acceptance. */
class PreviewBuildContractTest {
  @Test fun previewCannotReplaceTheCapacitorInstallation() {
    assertEquals("com.bridge.nativepreview", BuildConfig.APPLICATION_ID)
    assertNotEquals("com.bridge.app", BuildConfig.APPLICATION_ID)
  }

  @Test fun generatedConfigurationRequiresFabricAndHermes() {
    assertTrue(BuildConfig.IS_NEW_ARCHITECTURE_ENABLED)
    assertTrue(BuildConfig.IS_HERMES_ENABLED)
  }
}
