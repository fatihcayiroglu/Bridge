import XCTest

/// Native accessibility controls only. The endpoint is the real Bridge server.
final class ServerConnectionJourneyTests: XCTestCase {
  func testConnectRejectInsecureAddressAndResume() throws {
    continueAfterFailure = false
    let app = XCUIApplication(bundleIdentifier: "com.bridge.nativepreview")
    app.launch()
    let input = app.textFields["server-url-input"]
    XCTAssertTrue(input.waitForExistence(timeout: 60), "Native form did not launch")
    XCTAssertEqual(app.webViews.count, 0, "Primary renderer must not be a WebView")

    func connect(_ address: String) {
      input.tap()
      let current = input.value as? String ?? ""
      // The initial value is a placeholder; delete only an actual URL value.
      if current != "https://chat.example.com" {
        input.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
      }
      input.typeText(address + "\n")
    }

    connect("HTTP://127.0.0.1:3000/ignored")
    let success = app.staticTexts["connection-success"]
    XCTAssertTrue(success.waitForExistence(timeout: 15), "Real Bridge liveness failed")
    XCTAssertEqual(success.label, "Server verified")
    XCTAssertTrue(app.staticTexts["http://127.0.0.1:3000"].exists)

    XCUIDevice.shared.press(.home)
    XCTAssertTrue(app.wait(for: .runningBackground, timeout: 5))
    app.activate()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
    XCTAssertTrue(success.exists, "Connection state disappeared on a resident resume")
    // This tests resident state, not process-death recovery or background sockets.

    connect("http://insecure.example")
    let error = app.staticTexts["connection-error"]
    XCTAssertTrue(error.waitForExistence(timeout: 5))
    XCTAssertEqual(error.label, "Use HTTPS to protect your connection.")
    XCTAssertFalse(success.exists, "Stale verification survived an address change")

    connect("http://127.0.0.1:1")
    let unavailable = NSPredicate(format: "label == %@", "The server could not be reached. Check the address and connection.")
    expectation(for: unavailable, evaluatedWith: error)
    waitForExpectations(timeout: 15)
    XCTAssertEqual(app.webViews.count, 0)
  }
}
