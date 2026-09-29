import XCTest

/// Visual-gate driver for PR-1: launches the app in each required appearance
/// and size, exercises the one navigation pairing has, and attaches a
/// screenshot per state to the test run for `docs/audit/ios-shots/`.
///
/// Screenshot names follow `<screen>-<state>-<light|dark>`; non-390 pt
/// devices carry their width (`-375`), and the accessibility type-size runs
/// carry `-xxxl`.
final class PairingUITests: XCTestCase {
    private func launch(appearance: String, typeSize: String? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["UB_APPEARANCE"] = appearance
        // Pairing screens are the subject, whatever the device remembers.
        app.launchEnvironment["UB_RESET_PAIRING"] = "1"
        if let typeSize {
            app.launchEnvironment["UB_TYPE_SIZE"] = typeSize
        }
        // System alerts that slip through (Keychain "Save Password", camera
        // consent) must not wedge a leg — answer them and carry on.
        addUIInterruptionMonitor(withDescription: "system alerts") { alert in
            for label in ["Not Now", "Allow", "OK"] where alert.buttons[label].exists {
                alert.buttons[label].tap()
                return true
            }
            return false
        }
        app.launch()
        return app
    }

    /// `-390` is the default-size tag's home; other widths carry their width.
    /// The app under test's frame reports the device points width — the test
    /// runner's own `UIScreen` does not.
    private func suffix(appearance: String, typeSize: String?, app: XCUIApplication) -> String {
        let width = Int(app.frame.width.rounded())
        var name = appearance
        if width != 390 { name += "-\(width)" }
        if typeSize != nil { name += "-xxxl" }
        return name
    }

    private func shot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        // The simulator shares the host filesystem: drop the PNG on /tmp so
        // the shot survives Xcode pruning the xcresult. The caller copies
        // them to docs/audit/ios-shots/PR-2/.
        let dir = URL(fileURLWithPath: "/tmp/ub-shots", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? shot.pngRepresentation.write(to: dir.appendingPathComponent(name + ".png"))
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// The full pairing pass: empty state, then the manual-entry push with
    /// its disabled Connect.
    private func pairingShots(appearance: String, typeSize: String? = nil) {
        let app = launch(appearance: appearance, typeSize: typeSize)
        XCTAssertTrue(app.staticTexts["Connect to your Mac"].waitForExistence(timeout: 10))
        let suffix = suffix(appearance: appearance, typeSize: typeSize, app: app)
        XCTAssertTrue(app.staticTexts["On your Mac, open Settings, then Devices."].exists)
        XCTAssertTrue(app.buttons["Enter manually"].exists)
        shot("pairing-empty-\(suffix)")

        app.buttons["Enter manually"].tap()
        XCTAssertTrue(app.textFields["Mac address"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.secureTextFields["Pairing token"].exists)
        XCTAssertFalse(app.buttons["Connect"].isEnabled)
        shot("pairing-manual-\(suffix)")

        // Connect stays disabled until both fields hold text (design 1.1).
        // The focused field shows its ink edge and 3 pt ring; the filled
        // fields enable Connect with the keyboard still up. The ready
        // capture itself lives in `manualReadyShots` — XCTest censors the
        // secure field's bullets, so only the framebuffer capture is real
        // evidence of the filled state.
        app.textFields["Mac address"].tap()
        shot("pairing-manual-focused-\(suffix)")
        app.typeText("example.internal")
        XCTAssertFalse(app.buttons["Connect"].isEnabled)
        app.secureTextFields["Pairing token"].tap()
        app.typeText("ub_pair_token_test")
        XCTAssertTrue(app.buttons["Connect"].isEnabled)
    }

    /// XCTest screenshots censor `isSecureTextEntry` content — the field
    /// renders masked bullets fine (a `simctl io` framebuffer capture shows
    /// them), but the captured PNG shows nothing. States that evidence the
    /// filled token field therefore capture host-side: `shot()` writes the
    /// censored PNG + attachment, the `.hold-<name>` sentinel asks the gate
    /// script's watcher to overwrite the PNG with a framebuffer capture,
    /// and `.done-<name>` releases the test. Without the watcher the
    /// XCTest file stands as the fallback.
    private func hostShot(_ name: String, _ app: XCUIApplication) {
        shot(name)
        let dir = URL(fileURLWithPath: "/tmp/ub-shots", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? Data().write(to: dir.appendingPathComponent(".hold-" + name))
        let done = dir.appendingPathComponent(".done-" + name)
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline, !FileManager.default.fileExists(atPath: done.path) {
            usleep(300_000)
        }
        try? FileManager.default.removeItem(at: done)
    }

    /// The keyboard covers the button row in framebuffer captures; Return
    /// resigns the field without scrolling content.
    private func dismissKeyboard(_ app: XCUIApplication) {
        guard app.keyboards.firstMatch.exists else { return }
        for name in ["return", "Return", "Done", "done"] {
            let key = app.keyboards.buttons[name]
            if key.exists {
                key.tap()
                break
            }
        }
        _ = app.keyboards.firstMatch.waitForNonExistence(timeout: 6)
    }

    /// The filled-token state (1.1): masked bullets, enabled Connect.
    private func manualReadyShots(appearance: String, typeSize: String? = nil) {
        let app = launch(appearance: appearance, typeSize: typeSize)
        XCTAssertTrue(app.buttons["Enter manually"].waitForExistence(timeout: 10))
        app.buttons["Enter manually"].tap()
        XCTAssertTrue(app.textFields["Mac address"].waitForExistence(timeout: 5))
        app.textFields["Mac address"].tap()
        app.typeText("example.internal")
        app.secureTextFields["Pairing token"].tap()
        app.typeText("ub_pair_token_test")
        dismissKeyboard(app)
        XCTAssertTrue(app.buttons["Connect"].isEnabled)
        hostShot(
            "pairing-manual-ready-\(suffix(appearance: appearance, typeSize: typeSize, app: app))",
            app
        )
        app.terminate()
    }

    /// The pushed manual screen's `.failed` state: a refused loopback port
    /// fails the exchange fast; the error copy sits inline under Connect.
    private func manualFailedShots(appearance: String) {
        let app = launch(appearance: appearance)
        XCTAssertTrue(app.buttons["Enter manually"].waitForExistence(timeout: 10))
        app.buttons["Enter manually"].tap()
        XCTAssertTrue(app.textFields["Mac address"].waitForExistence(timeout: 5))
        app.textFields["Mac address"].tap()
        app.typeText("http://127.0.0.1:1")
        app.secureTextFields["Pairing token"].tap()
        app.typeText("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
        dismissKeyboard(app)
        app.buttons["manual-connect"].tap()
        // .failed lands the refused-connection copy inline under Connect —
        // wait on the text itself, not just the button's re-enable.
        XCTAssertTrue(
            app.staticTexts["Can't reach your Mac. Is it awake and on Tailscale?"]
                .waitForExistence(timeout: 15),
            "manual-flow failure copy never rendered")
        hostShot(
            "pairing-manual-failed-\(suffix(appearance: appearance, typeSize: nil, app: app))",
            app
        )
        app.terminate()
    }

    func testManualReadyHold() {
        for appearance in ["light", "dark"] { manualReadyShots(appearance: appearance) }
    }

    func testManualReadyHoldAccessibility() {
        for appearance in ["light", "dark"] {
            manualReadyShots(appearance: appearance, typeSize: "xxxl")
        }
    }

    func testManualFailedHold() {
        for appearance in ["light", "dark"] { manualFailedShots(appearance: appearance) }
    }

    func testPairingLight() { pairingShots(appearance: "light") }
    func testPairingDark() { pairingShots(appearance: "dark") }
    func testPairingAccessibilityLight() {
        pairingShots(appearance: "light", typeSize: "xxxl")
    }
    func testPairingAccessibilityDark() {
        pairingShots(appearance: "dark", typeSize: "xxxl")
    }

    /// Camera denied (design 1.1): the scanner square becomes the sunken
    /// "Camera access is off" block with Open Settings, and the manual fields
    /// come inline — no sheet, no push. `UB_CAMERA_STATE` pins the status.
    private func cameraDeniedShots(appearance: String, typeSize: String? = nil) {
        let app = XCUIApplication()
        app.launchEnvironment["UB_APPEARANCE"] = appearance
        app.launchEnvironment["UB_CAMERA_STATE"] = "denied"
        app.launchEnvironment["UB_RESET_PAIRING"] = "1"
        if let typeSize { app.launchEnvironment["UB_TYPE_SIZE"] = typeSize }
        app.launch()
        XCTAssertTrue(app.staticTexts["Camera access is off"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Open Settings"].exists)
        // Manual fields inline, not behind another tap.
        XCTAssertTrue(app.textFields["Mac address"].exists)
        XCTAssertTrue(app.secureTextFields["Pairing token"].exists)
        shot("pairing-camera-denied-\(suffix(appearance: appearance, typeSize: typeSize, app: app))")
    }

    func testPairingCameraDeniedLight() { cameraDeniedShots(appearance: "light") }
    func testPairingCameraDeniedDark() { cameraDeniedShots(appearance: "dark") }
    func testPairingCameraDeniedAccessibilityLight() {
        cameraDeniedShots(appearance: "light", typeSize: "xxxl")
    }
    func testPairingCameraDeniedAccessibilityDark() {
        cameraDeniedShots(appearance: "dark", typeSize: "xxxl")
    }
}
