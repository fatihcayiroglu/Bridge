import XCTest

/// Native accessibility controls only. The endpoint is the real Bridge server.
final class ServerConnectionJourneyTests: XCTestCase {
  func testConnectRejectInsecureAddressAndResume() throws {
    continueAfterFailure = false
    print("BRIDGE_NATIVE_JOURNEY_STAGE=launch")
    let app = XCUIApplication(bundleIdentifier: "com.bridge.nativepreview")
    func reportObservedState() {
      let state: String
      switch app.state {
      case .unknown: state = "unknown"
      case .notRunning: state = "not-running"
      case .runningBackgroundSuspended: state = "background-suspended"
      case .runningBackground: state = "background"
      case .runningForeground: state = "foreground"
      @unknown default: state = "unknown"
      }
      print("BRIDGE_NATIVE_APP_STATE=\(state)")
    }
    func reportState(_ matched: Bool) -> Bool {
      reportObservedState()
      return matched
    }
    func reportMissingForm() {
      guard app.state == .runningForeground else {
        print("BRIDGE_NATIVE_INPUT_KIND=unavailable")
        print("BRIDGE_NATIVE_SURFACE=unavailable")
        return
      }
      let candidate = app.descendants(matching: .any)["server-url-input"].firstMatch
      let kind: String
      if !candidate.exists { kind = "missing" }
      else {
        switch candidate.elementType {
        case .textField: kind = "text-field"
        case .secureTextField: kind = "secure-field"
        case .textView: kind = "text-view"
        default: kind = "other"
        }
      }
      print("BRIDGE_NATIVE_INPUT_KIND=\(kind)")
      let surface: String
      if app.staticTexts["Connect to your server"].exists { surface = "form" }
      else if app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Unable to resolve module")).firstMatch.exists { surface = "module-error" }
      else if app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Could not connect to development server")).firstMatch.exists { surface = "metro-error" }
      else if app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "ReferenceError")).firstMatch.exists { surface = "reference-error" }
      else if app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "TypeError")).firstMatch.exists { surface = "type-error" }
      else { surface = "other" }
      print("BRIDGE_NATIVE_SURFACE=\(surface)")
    }
    print("BRIDGE_NATIVE_JOURNEY_ACTION=app-launch")
    app.launch()
    reportObservedState()
    let input = app.textFields["server-url-input"]
    print("BRIDGE_NATIVE_JOURNEY_ACTION=form-wait")
    let formMatches = input.waitForExistence(timeout: 60)
    reportObservedState()
    if !formMatches {
      print("BRIDGE_NATIVE_JOURNEY_ACTION=form-observation")
      reportMissingForm()
    }
    XCTAssertTrue(formMatches, "Native form did not launch")
    print("BRIDGE_NATIVE_JOURNEY_ACTION=renderer-check")
    XCTAssertEqual(app.webViews.count, 0, "Primary renderer must not be a WebView")

    func connect(_ address: String) {
      print("BRIDGE_NATIVE_JOURNEY_ACTION=input-focus")
      input.tap()
      print("BRIDGE_NATIVE_JOURNEY_ACTION=keyboard-wait")
      let keyboard = app.keyboards.firstMatch
      XCTAssertTrue(keyboard.waitForExistence(timeout: 5), "Software keyboard is not visible")
      print("BRIDGE_NATIVE_JOURNEY_ACTION=keyboard-geometry")
      let visibleInput = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
        input.isHittable && input.frame.maxY <= keyboard.frame.minY
      }, object: input)
      XCTAssertEqual(XCTWaiter.wait(for: [visibleInput], timeout: 5), .completed,
                     "Server field is covered by software keyboard")
      let current = input.value as? String ?? ""
      // The initial value is a placeholder; delete only an actual URL value.
      if current != "https://chat.example.com" {
        print("BRIDGE_NATIVE_JOURNEY_ACTION=input-clear")
        input.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
      }
      print("BRIDGE_NATIVE_JOURNEY_ACTION=input-type")
      input.typeText(address)
      print("BRIDGE_NATIVE_JOURNEY_ACTION=input-verify")
      XCTAssertEqual(input.value as? String, address, "Server address edit did not replace the entire input")
      print("BRIDGE_NATIVE_JOURNEY_ACTION=input-submit")
      input.typeText("\n")
    }

    print("BRIDGE_NATIVE_JOURNEY_STAGE=connect")
    connect("HTTP://127.0.0.1:3000/ignored")
    let success = app.staticTexts["connection-success"]
    print("BRIDGE_NATIVE_JOURNEY_ACTION=liveness-wait")
    XCTAssertTrue(success.waitForExistence(timeout: 15), "Real Bridge liveness failed")
    XCTAssertEqual(success.label, "Server verified")
    XCTAssertTrue(app.staticTexts["http://127.0.0.1:3000"].exists)

    print("BRIDGE_NATIVE_JOURNEY_STAGE=background")
    XCUIDevice.shared.press(.home)
    XCTAssertTrue(reportState(app.wait(for: .runningBackground, timeout: 5)))
    print("BRIDGE_NATIVE_JOURNEY_STAGE=resume")
    app.activate()
    XCTAssertTrue(reportState(app.wait(for: .runningForeground, timeout: 10)))
    XCTAssertTrue(success.exists, "Connection state disappeared on a resident resume")
    // This tests resident state, not process-death recovery or background sockets.

    print("BRIDGE_NATIVE_JOURNEY_STAGE=insecure-input")
    connect("http://insecure.example")
    let error = app.staticTexts["connection-error"]
    XCTAssertTrue(error.waitForExistence(timeout: 5))
    XCTAssertEqual(error.label, "Use HTTPS to protect your connection.")
    XCTAssertFalse(success.exists, "Stale verification survived an address change")

    print("BRIDGE_NATIVE_JOURNEY_STAGE=unavailable-input")
    connect("http://127.0.0.1:1")
    let unavailable = NSPredicate(format: "label == %@", "The server could not be reached. Check the address and connection.")
    expectation(for: unavailable, evaluatedWith: error)
    waitForExpectations(timeout: 15)
    XCTAssertEqual(app.webViews.count, 0)
    print("BRIDGE_NATIVE_JOURNEY_STAGE=complete")
  }
}
