package com.bridge.nativepreview

import android.content.Intent
import android.content.Context
import android.app.KeyguardManager
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Assert.*
import org.junit.Test

/** Actual native UI and Bridge HTTP server; no JS bridge commands or injected replies. */
class ServerConnectionJourneyTest {
    @Test
    fun connectRejectInsecureAddressAndResumeInSameProcess() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val device = UiDevice.getInstance(instrumentation)
        val context = instrumentation.context
        val target = instrumentation.targetContext
        requireStartup(observe { device.isScreenOn } == true, NativeStartupFailure.SCREEN_UNAVAILABLE, device, target)
        requireStartup(observe { (target.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager)?.isKeyguardLocked } == false,
            NativeStartupFailure.KEYGUARD_NOT_UNLOCKED, device, target)
        val intent = context.packageManager.getLaunchIntentForPackage(APP_ID)
        assertNotNull("Preview app must be installed", intent)
        context.startActivity(intent!!.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val formVisible = device.wait(Until.hasObject(By.desc("Server address")), 60_000)
        requireStartup(formVisible == true, NativeStartupFailure.FORM_NOT_VISIBLE, device, target)
        assertFalse("Primary renderer must not be a WebView", device.hasObject(By.clazz("android.webkit.WebView")))
        val pid = processId(device)

        fun connect(address: String) {
            val field = device.findObject(By.desc("Server address"))
                ?: throw AssertionError("Native address field disappeared")
            field.text = address
            val button = device.findObject(By.desc("Connect"))
                ?: throw AssertionError("Native connect button disappeared")
            button.click()
        }

        // Android emulator loopback is explicitly development-only. This is the
        // actual Bridge backend started by CI, not a fixture liveness endpoint.
        connect("HTTP://10.0.2.2:3000/ignored")
        assertTrue("Real Bridge liveness failed", device.wait(Until.hasObject(By.text("Server verified")), 15_000))
        assertTrue(device.hasObject(By.text("http://10.0.2.2:3000")))
        assertEquals(pid, processId(device))

        device.pressHome()
        assertTrue("App did not leave foreground", device.wait(Until.gone(By.desc("Server address")), 5_000))
        context.startActivity(intent)
        assertTrue(device.wait(Until.hasObject(By.text("Server verified")), 10_000))
        assertEquals("Resume relaunched the process", pid, processId(device))

        connect("http://insecure.example")
        assertTrue(device.wait(Until.hasObject(By.text("Use HTTPS to protect your connection.")), 5_000))
        assertFalse("Stale verified state survived a changed target", device.hasObject(By.text("Server verified")))

        connect("http://10.0.2.2:1")
        assertTrue(device.wait(Until.hasObject(By.text("The server could not be reached. Check the address and connection.")), 15_000))
        assertEquals(pid, processId(device))
        assertFalse(device.hasObject(By.clazz("android.webkit.WebView")))
    }

    private fun processId(device: UiDevice): String {
        val pid = device.executeShellCommand("pidof $APP_ID").trim()
        assertTrue("Target process is absent or ambiguous", pid.matches(Regex("[0-9]+")))
        return pid
    }

    private fun requireStartup(condition: Boolean, failure: NativeStartupFailure, device: UiDevice, context: Context) {
        if (condition) return
        val foreground = try { NativeForeground.fromPackage(device.currentPackageName) }
            catch (_: RuntimeException) { NativeForeground.UNAVAILABLE }
        val label = try { NativeInputLabel.fromDescription(device.findObject(By.res("server-url-input"))?.contentDescription) }
            catch (_: RuntimeException) { NativeInputLabel.UNAVAILABLE }
        // Do not export the PID or the foreground package: only whether the
        // target process exists while the 60-second form assertion fails.
        val targetProcessAlive: Boolean? = try {
            device.executeShellCommand("pidof $APP_ID").trim().isNotEmpty()
        } catch (_: Exception) { null }
        val state = NativeStartupObservation(
            observe { device.isScreenOn },
            observe { (context.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager)?.isKeyguardLocked },
            foreground, targetProcessAlive, observe { device.hasObject(By.text("Connect to your server")) },
            observe { device.hasObject(By.clazz("android.widget.EditText")) },
            observe { device.hasObject(By.res("server-url-input")) }, label,
        )
        throw AssertionError("Native startup acceptance failed; " + state.report(failure))
    }

    private fun observe(read: () -> Boolean?): Boolean? = try { read() } catch (_: RuntimeException) { null }

    companion object { private const val APP_ID = "com.bridge.nativepreview" }
}
