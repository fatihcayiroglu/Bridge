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
      // Apple's hasFocus describes UI focus; typeText independently requires
      // keyboard focus. Observe the former without assuming equivalence.
      // The genuine key event and exact reflected value below are required.
      print("BRIDGE_NATIVE_JOURNEY_ACTION=input-focus-observe")
      let focusReady = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
        input.hasFocus
      }, object: input)
      let uiFocusObserved = XCTWaiter.wait(for: [focusReady], timeout: 5) == .completed
      print("BRIDGE_NATIVE_UI_FOCUS=\(uiFocusObserved)")
      let current = input.value as? String ?? ""
      // The initial value is a placeholder; delete only an actual URL value.
      if current != "https://chat.example.com" {
        print("BRIDGE_NATIVE_JOURNEY_ACTION=input-clear")
        // Clearing a prior controlled value is also an asynchronous native
        // keyboard journey. Never race the next address against unacknowledged
        // delete events; a missing reflection is a genuine first failure.
        var deletionRemaining = Array(current)
        while !deletionRemaining.isEmpty {
          let deletionCount = 1
          let deletionBurst = String(repeating: XCUIKeyboardKey.delete.rawValue,
                                     count: deletionCount)
          input.typeText(deletionBurst)
          deletionRemaining.removeLast(deletionCount)
          let expectedRemainder = String(deletionRemaining)
          print("BRIDGE_NATIVE_JOURNEY_ACTION=input-clear-verify")
          let reflectedClear = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let observed = input.value as? String ?? ""
            return observed == expectedRemainder ||
                   (expectedRemainder.isEmpty && observed == "https://chat.example.com")
          }, object: input)
          XCTAssertEqual(XCTWaiter.wait(for: [reflectedClear], timeout: 2), .completed,
                         "Server field did not reflect keyboard delete")
        }
      }
      print("BRIDGE_NATIVE_JOURNEY_ACTION=input-type")
      // React Native's controlled TextInput needs to reflect EACH native
      // key before the next key. Four-key bursts lost events on the exact CI
      // head; send each physical keyboard character once and fail on the
      // first missing reflection. No retry, paste, injection or JS shortcut.
      var acceptedPrefix = ""
      for character in address {
        input.typeText(String(character))
        acceptedPrefix.append(character)
        let expectedPrefix = acceptedPrefix
        let reflectedKey = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
          input.value as? String == expectedPrefix
        }, object: input)
        let keyResult = XCTWaiter.wait(for: [reflectedKey], timeout: 2)
        XCTAssertEqual(keyResult, .completed,
                       "Server field did not reflect keyboard character")
        if keyResult == .completed && acceptedPrefix.count == 1 {
          print("BRIDGE_NATIVE_KEYBOARD_INPUT=first-character-verified;ui-focus=\(input.hasFocus)")
        }
      }
      print("BRIDGE_NATIVE_JOURNEY_ACTION=input-verify")
      let typedValue = input.value as? String
      if typedValue != address {
        let shape: String
        if let value = typedValue {
          if value.isEmpty { shape = "empty" }
          else if value == "https://chat.example.com" { shape = "placeholder" }
          else if value == current { shape = "unchanged" }
          else if address.hasPrefix(value) { shape = "expected-prefix" }
          else if address.hasSuffix(value) { shape = "expected-suffix" }
          else { shape = "other" }
        } else { shape = "not-string" }
        // Observe asynchronous reflection without changing the failing value
        // being asserted. No key is retyped and no submission is retried.
        let reflected = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
          input.value as? String == address
        }, object: input)
        let settled = XCTWaiter.wait(for: [reflected], timeout: 5) == .completed
        let length = min(typedValue?.count ?? 0, 256)
        print("BRIDGE_NATIVE_INPUT_VALUE=\(shape);length=\(length);expected-length=\(min(address.count, 256));settled=\(settled)")
      }
      XCTAssertEqual(typedValue, address, "Server address edit did not replace the entire input")
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
    // iOS may suspend a correctly backgrounded process. Both observed states
    // are real background states; foreground, unknown and terminated still fail.
    let background = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      let state = app.state
      return state == .runningBackground || state == .runningBackgroundSuspended
    }, object: app)
    let backgroundObserved = XCTWaiter.wait(for: [background], timeout: 5) == .completed
    reportObservedState()
    let stateAfterHome = app.state
    let stillBackground = stateAfterHome == .runningBackground ||
                          stateAfterHome == .runningBackgroundSuspended
    XCTAssertTrue(backgroundObserved && stillBackground,
                  "App did not remain in a genuine background or suspended state after Home")
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
