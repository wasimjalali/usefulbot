import XCTest

/// PR-2 visual gate: screenshots for every screen/state PR-2 adds, in both
/// appearances, at the device width, plus one accessibility-XXXL pass.
/// Pairing-form states live in PairingUITests; this class owns the states
/// behind a live session (Bots list, Devices, signed-out, credential-invalid,
/// failed/manual connect, readiness banner).
///
/// States needing a live stack read the pairing payload from
/// `/tmp/ub-pair.json` (the simulator shares the host filesystem) and skip
/// without it — scripts/ios-pairing-gate.sh runs them as legs around its
/// credential flips. `testFailed`/`testConnecting` need no stack.
final class ShotsUITests: XCTestCase {
    private struct Pairing {
        let host: String
        let token: String
        let name: String
    }

    private let pairFilePath = "/tmp/ub-pair.json"

    private func pairing() throws -> Pairing {
        guard let data = FileManager.default.contents(atPath: pairFilePath) else {
            throw XCTSkip("\(pairFilePath) missing — drive this test through scripts/ios-pairing-gate.sh")
        }
        struct Raw: Decodable { let v: Int; let host: String; let token: String; let name: String }
        guard let raw = try? JSONDecoder().decode(Raw.self, from: data) else {
            XCTFail("pairing payload is not the expected shape")
            throw NSError(domain: "test", code: 1)
        }
        return Pairing(host: raw.host, token: raw.token, name: raw.name)
    }

    /// `alertsWindow` bounds the dismissal poll: transient states (the
    /// "Connected to" hold) can't afford the full 5 s window or the state
    /// under capture expires underneath the camera.
    private func shot(_ name: String, _ app: XCUIApplication, alertsWindow: TimeInterval = 5) {
        // The Keychain save sheet can surface seconds after the last event;
        // the capture is only trustworthy immediately after a dismissal
        // pass, so it lives inside shot() rather than at the call site.
        dismissSystemAlerts(app, window: alertsWindow)
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

    private func suffix(_ app: XCUIApplication, appearance: String, typeSize: String?) -> String {
        let width = Int(app.frame.width.rounded())
        var s = appearance
        if width != 390 { s += "-\(width)" }
        if typeSize != nil { s += "-xxxl" }
        return s
    }

    /// System alerts that slip through (Keychain "Save Password", camera
    /// consent) must not wedge a leg — answer them and carry on.
    private func installInterruptionMonitor() {
        addUIInterruptionMonitor(withDescription: "system alerts") { alert in
            for label in ["Not Now", "Allow", "OK"] where alert.buttons[label].exists {
                alert.buttons[label].tap()
                return true
            }
            return false
        }
    }

    /// The Keychain "Save Password?" sheet can surface *after* the last
    /// synthesized event — during a hold there is nothing for the
    /// interruption monitor to interrupt, so it lingers into the shot
    /// (observed async at ~2 s post-submit, which an early-exit poll missed).
    /// Poll the full window, answering each alert that appears.
    private func dismissSystemAlerts(_ app: XCUIApplication, window: TimeInterval = 5) {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let deadline = Date().addingTimeInterval(window)
        while Date() < deadline {
            for host in [app, springboard] where host.alerts.firstMatch.exists {
                for label in ["Not Now", "Allow", "OK"] {
                    let button = host.buttons[label]
                    if button.exists { button.tap() }
                }
            }
            usleep(300_000)
        }
    }

    /// A typed field can leave the ScrollView offset after the keyboard
    /// drops — the light connected shots came back mid-scroll. Drag the
    /// scroll view back to the top before capturing (bounded; the drag is a
    /// no-op once the content is home).
    private func pinToTop(_ app: XCUIApplication) {
        for _ in 0..<3 where app.scrollViews.firstMatch.exists {
            app.swipeDown()
            usleep(200_000)
        }
    }

    private func launch(_ app: XCUIApplication, appearance: String, typeSize: String? = nil,
                        reset: Bool = false, offline: Bool = false,
                        holdSeconds: TimeInterval? = nil,
                        hangShell: Bool = false, emptyShell: Bool = false,
                        failShell: Bool = false,
                        expiryDays: Double? = nil) {
        app.launchEnvironment["UB_APPEARANCE"] = appearance
        app.launchEnvironment["UB_CAMERA_STATE"] = "denied"
        if reset { app.launchEnvironment["UB_RESET_PAIRING"] = "1" }
        if offline { app.launchEnvironment["UB_OFFLINE"] = "1" }
        if let holdSeconds { app.launchEnvironment["UB_HOLD_CONNECTED"] = "\(holdSeconds)" }
        if hangShell { app.launchEnvironment["UB_HANG_SHELL"] = "1" }
        if emptyShell { app.launchEnvironment["UB_EMPTY_SHELL"] = "1" }
        if failShell { app.launchEnvironment["UB_FAIL_SHELL"] = "1" }
        if let expiryDays {
            app.launchEnvironment["UB_CREDENTIAL_EXPIRY_DAYS"] = "\(expiryDays)"
        }
        if let typeSize { app.launchEnvironment["UB_TYPE_SIZE"] = typeSize }
        installInterruptionMonitor()
        app.launch()
    }

    /// The paired root's positive signal: the bots list's nav-bar title.
    /// Used instead of `navigationBars[…]` (the title is a toolbar item,
    /// not `.navigationTitle`) and instead of a nonexistence poll (a
    /// transient snapshot miss fakes it).
    @discardableResult
    private func waitForBotsRoot(_ app: XCUIApplication, timeout: TimeInterval = 15) -> Bool {
        app.descendants(matching: .any)["bots-list"].waitForExistence(timeout: timeout)
    }

    /// Opens the pushed Devices screen and waits for its own nav bar.
    private func openDevices(_ app: XCUIApplication) {
        for _ in 0..<8 {
            if app.navigationBars["Devices"].exists { return }
            let gear = app.buttons["Devices"]
            if gear.exists { gear.tap() }
            usleep(400_000)
        }
    }

    private func type(_ app: XCUIApplication, _ element: XCUIElement, _ text: String) {
        XCTAssertTrue(element.waitForExistence(timeout: 15))
        element.tap()
        element.typeText(text)
    }

    /// `scrollDismissesKeyboard(.interactively)` doesn't take on every sim
    /// (iOS-26.5 iPhone 17 kept the keyboard up through a swipeDown, and the
    /// raw coordinate tap on Connect then landed on the keyboard). The
    /// Return key resigns the field without scrolling content; the swipe is
    /// kept as fallback.
    private func dismissKeyboard(_ app: XCUIApplication) {
        guard app.keyboards.firstMatch.exists else { return }
        for name in ["return", "Return", "Done", "done"] {
            let key = app.keyboards.buttons[name]
            if key.exists {
                key.tap()
                break
            }
        }
        if app.keyboards.firstMatch.waitForNonExistence(timeout: 6) { return }
        app.swipeDown()
        _ = app.keyboards.firstMatch.waitForNonExistence(timeout: 4)
    }

    /// Sheet buttons can hit a stale snapshot mid-rerender ("Computed hit
    /// point {-1,-1}"). Gate on isHittable first, then coordinate-tap — a
    /// coordinate tap can never fail "not hittable".
    private func tapButton(_ app: XCUIApplication, _ label: String) {
        let el = app.buttons[label]
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            if el.exists, el.isHittable {
                el.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                return
            }
            // Offscreen or covered: a swipe scrolls the sheet's list and
            // dismisses a keyboard still over the bottom half on 375 pt.
            app.swipeUp()
            usleep(400_000)
        }
        XCTFail("\(label) never became hittable")
    }

    private func pairThroughManualEntry(_ app: XCUIApplication, _ pair: Pairing) {
        type(app, app.textFields["Mac address"], pair.host)
        // The SecureField type can drop silently when a system alert steals
        // first responder (the disabled Connect button is the only readable
        // tell), and a coordinate tap on a disabled button no-ops without an
        // error — so confirm the attempt registered, then retry the whole
        // token entry once when it didn't.
        for _ in 0..<2 {
            type(app, app.secureTextFields["Pairing token"], pair.token)
            var waited = 0.0
            while !app.buttons["manual-connect"].isEnabled && waited < 3 {
                usleep(250_000)
                waited += 0.25
            }
            if !app.buttons["manual-connect"].isEnabled { continue }
            // The keyboard can still be settling over the button row when
            // the coordinate resolves — a raw coordinate tap lands on it
            // with no hit-failure. Dismiss first so the tap reaches Connect.
            dismissKeyboard(app)
            tapButton(app, "Connect")
            // A real tap moves the status line off idle; if it never did
            // the tap no-opped and the token needs retyping. Read it
            // through a matching() query — identifier and label evaluate in
            // one snapshot, so the pairing screen unmounting on the Bots
            // push can't throw a stale-snapshot between exists and label.
            let moved = app.staticTexts.matching(NSPredicate(
                format: "identifier == 'pairing-status' AND label != '' AND label != %@",
                "Point the camera at the code on your Mac")).firstMatch
            let deadline = Date().addingTimeInterval(12)
            while Date() < deadline {
                if app.descendants(matching: .any)["bots-list"].exists { return }
                if moved.exists { return }
                usleep(300_000)
            }
        }
        // The keyboard can outlive the push to the Bots list and cover the
        // Devices sheet's bottom rows on small screens.
        dismissKeyboard(app)
    }
    /// Full paired journey: bots list → Devices sheet → sign out → sign in.
    /// One run per (appearance, typeSize) the gate requires.
    private func sessionJourney(appearance: String, typeSize: String? = nil) throws {
        let pair = try pairing()
        let app = XCUIApplication()
        launch(app, appearance: appearance, typeSize: typeSize, reset: true)

        XCTAssertTrue(app.textFields["Mac address"].waitForExistence(timeout: 15))
        pairThroughManualEntry(app, pair)
        XCTAssertTrue(waitForBotsRoot(app, timeout: 20))
        let s = suffix(app, appearance: appearance, typeSize: typeSize)
        shot("bots-paired-\(s)", app)

        openDevices(app)
        XCTAssertTrue(app.navigationBars["Devices"].waitForExistence(timeout: 10),
                      "Devices push never presented")
        XCTAssertTrue(app.staticTexts["This Mac"].waitForExistence(timeout: 10))
        shot("devices-paired-\(s)", app)

        tapButton(app, "Sign out on this phone")
        XCTAssertTrue(app.staticTexts["Signed out"].waitForExistence(timeout: 10))
        shot("signed-out-\(s)", app)

        tapButton(app, "signed-out-sign-in")
        XCTAssertTrue(waitForBotsRoot(app, timeout: 15))
        // The roster mounts before the toolbar rebuild finishes — an
        // immediate shot can miss the nav chrome entirely. Wait on the
        // Devices gear so the chrome is in the evidence.
        XCTAssertTrue(app.buttons["Devices"].waitForExistence(timeout: 10))
        shot("bots-resigned-in-\(s)", app)
    }

    func testJourneyLight() throws { try sessionJourney(appearance: "light") }
    func testJourneyDark() throws { try sessionJourney(appearance: "dark") }
    func testJourneyAccessibilityLight() throws {
        try sessionJourney(appearance: "light", typeSize: "xxxl")
    }
    func testJourneyAccessibilityDark() throws {
        try sessionJourney(appearance: "dark", typeSize: "xxxl")
    }

    /// Revoked credential → idle + invalid copy. Driven as a gate leg right
    /// after `setup-local.mjs --revoke-phone`, while the stored token is a
    /// live 401. The light variant is captured by PairingFlowUITests.
    /// XCTest screenshots censor `isSecureTextEntry` content — the field
    /// renders masked bullets fine (a `simctl io` framebuffer capture shows
    /// them), so filled-token states capture host-side: `shot()` writes the
    /// censored PNG + attachment, `.hold-<name>` asks the gate's watcher to
    /// overwrite the PNG with a framebuffer capture, `.done-<name>`
    /// releases the test. Without the watcher the XCTest file stands.
    private func hostShot(
        _ name: String,
        _ app: XCUIApplication,
        alertsWindow: TimeInterval = 5
    ) {
        shot(name, app, alertsWindow: alertsWindow)
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

    /// The revoked pairing screen — both appearances inside the gate's
    /// revoked window.
    func testCredentialInvalid() throws {
        guard FileManager.default.contents(atPath: "/tmp/ub-pair-revoked") != nil else {
            throw XCTSkip("/tmp/ub-pair-revoked missing — only valid inside the gate's revoked window")
        }
        for appearance in ["light", "dark"] {
            let app = XCUIApplication()
            launch(app, appearance: appearance)
            XCTAssertTrue(app.staticTexts[
                "This pairing was revoked or expired. Scan a new code from your Mac."
            ].waitForExistence(timeout: 15))
            XCTAssertTrue(app.staticTexts["Pair again"].exists)
            shot("pairing-credential-invalid-\(suffix(app, appearance: appearance, typeSize: nil))", app)
            app.terminate()
        }
    }

    /// The Unpair confirm (design 1.15, spec 4.4 class A): the
    /// confirmationDialog stands in for the spec's FloatingSheet until that
    /// component lands — the substitution is recorded in the build log and
    /// this capture evidences the shipped control.
    func testUnpairConfirm() throws {
        guard FileManager.default.contents(atPath: pairFilePath) != nil else {
            throw XCTSkip("\(pairFilePath) missing — drive this test through scripts/ios-pairing-gate.sh")
        }
        for appearance in ["light", "dark"] {
            let app = XCUIApplication()
            launch(app, appearance: appearance)
            XCTAssertTrue(waitForBotsRoot(app))
            openDevices(app)
            XCTAssertTrue(app.navigationBars["Devices"].waitForExistence(timeout: 10))
            tapButton(app, "Unpair")
            // iOS 26 presents the confirm as an anchored popover whose
            // content lives on the alert layer — the app's own element
            // tree exposes nothing stable to assert, so presentation is
            // evidenced by the framebuffer capture (the handshake itself
            // is the wait) and the popover dismisses on an outside tap.
            _ = app.otherElements["PopoverDismissRegion"]
                .waitForExistence(timeout: 8)
            hostShot("devices-unpair-confirm-\(suffix(app, appearance: appearance, typeSize: nil))", app)
            // Cancel — never Unpair: the rest of the gate still needs the
            // paired store. A top-edge point hits no control.
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.02)).tap()
            app.terminate()
        }
    }

    /// Mac unreachable readiness banner: the gate kills the web service
    /// before this leg, so the list's refresh fails and the banner shows.
    /// Both appearances in one run — the stack stays down between launches.
    func testMacUnreachableBanner() throws {
        guard FileManager.default.contents(atPath: "/tmp/ub-web-down") != nil else {
            throw XCTSkip("/tmp/ub-web-down missing — only valid while the gate holds the web service down")
        }
        for appearance in ["light", "dark"] {
            let app = XCUIApplication()
            launch(app, appearance: appearance)
            XCTAssertTrue(
                app.staticTexts["Your Mac is unreachable"].waitForExistence(timeout: 25)
                    || app.staticTexts["Agent runtime is down on your Mac"].waitForExistence(timeout: 5),
                "readiness banner never appeared")
            shot("bots-unreachable-\(suffix(app, appearance: appearance, typeSize: nil))", app)
            openDevices(app)
            XCTAssertTrue(app.navigationBars["Devices"].waitForExistence(timeout: 10))
            shot("devices-unreachable-\(suffix(app, appearance: appearance, typeSize: nil))", app)
            app.terminate()
        }
    }

    /// No-network banner: UB_OFFLINE pins the path monitor unsatisfied, so
    /// the paired app lands on the cached-read view with the offline copy.
    func testOfflineBanner() throws {
        guard FileManager.default.contents(atPath: pairFilePath) != nil else {
            throw XCTSkip("\(pairFilePath) missing — drive this test through scripts/ios-pairing-gate.sh")
        }
        for appearance in ["light", "dark"] {
            let app = XCUIApplication()
            launch(app, appearance: appearance, offline: true)
            XCTAssertTrue(
                app.staticTexts["You're offline"].waitForExistence(timeout: 25),
                "offline banner never appeared")
            shot("bots-offline-\(suffix(app, appearance: appearance, typeSize: nil))", app)
            // Devices carries its own non-ready copy (the status pill) —
            // §17.1.3 wants every state it can reach, not just the banner.
            openDevices(app)
            XCTAssertTrue(app.navigationBars["Devices"].waitForExistence(timeout: 10))
            shot("devices-offline-\(suffix(app, appearance: appearance, typeSize: nil))", app)
            app.terminate()
        }
        // The xxxl pass is the evidence for the banner's drop-under rule:
        // Retry leaves the trailing slot and stacks under the copy.
        let app = XCUIApplication()
        launch(app, appearance: "light", typeSize: "xxxl", offline: true)
        XCTAssertTrue(
            app.staticTexts["You're offline"].waitForExistence(timeout: 25),
            "offline banner never appeared at xxxl")
        shot("bots-offline-\(suffix(app, appearance: "light", typeSize: "xxxl"))", app)
        app.terminate()
    }

    /// Runtime-down banner: the gate kills eve (:4321) but leaves the web
    /// service up, so `/api/status` answers with the probe failed and the
    /// chat-down copy shows. The paired app is left on the sim from leg C.
    func testRuntimeDownBanner() throws {
        guard FileManager.default.contents(atPath: "/tmp/ub-eve-down") != nil else {
            throw XCTSkip("/tmp/ub-eve-down missing — only valid while the gate holds eve down")
        }
        for appearance in ["light", "dark"] {
            let app = XCUIApplication()
            launch(app, appearance: appearance)
            XCTAssertTrue(
                app.staticTexts["Agent runtime is down on your Mac"].waitForExistence(timeout: 25),
                "runtime-down banner never appeared")
            shot("bots-runtime-down-\(suffix(app, appearance: appearance, typeSize: nil))", app)
            openDevices(app)
            XCTAssertTrue(app.navigationBars["Devices"].waitForExistence(timeout: 10))
            shot("devices-runtime-down-\(suffix(app, appearance: appearance, typeSize: nil))", app)
            app.terminate()
        }
    }

    /// Failed manual connect: a refused loopback port fails the session
    /// exchange fast, landing the error copy on the status line.
    func testConnectFailedBothAppearances() {
        for appearance in ["light", "dark"] {
            let app = XCUIApplication()
            launch(app, appearance: appearance, reset: true)
            XCTAssertTrue(app.textFields["Mac address"].waitForExistence(timeout: 15))
            type(app, app.textFields["Mac address"], "http://127.0.0.1:1")
            type(app, app.secureTextFields["Pairing token"], "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
            // The keyboard can cover the Connect row — dismiss so the tap
            // reaches the button, not the keyboard.
            dismissKeyboard(app)
            app.buttons["manual-connect"].tap()
            // The failure copy differs per failure mode; poll the status
            // label until it leaves idle/connecting, then shoot the error.
            // The denied state suppresses the idle line to "" — that is
            // idle, not a result; keep polling past it. matching() keeps
            // identifier and label in one snapshot so the read can't throw
            // stale mid-navigation.
            let settled = app.staticTexts.matching(NSPredicate(
                format: "identifier == 'pairing-status' AND label != '' AND label != %@ AND label != %@",
                "Connecting to your Mac",
                "Point the camera at the code on your Mac")).firstMatch
            let deadline = Date().addingTimeInterval(20)
            while Date() < deadline, !settled.exists {
                usleep(300_000)
            }
            XCTAssertTrue(settled.exists)
            hostShot(
                "pairing-connect-failed-\(suffix(app, appearance: appearance, typeSize: nil))",
                app
            )
            app.terminate()
        }
    }

    /// Success line: "Connected to <name>" is a 600 ms transient by design,
    /// faster than XCTest polls. UB_HOLD_CONNECTED stretches the hold so the
    /// state is capturable; each run pairs fresh against the live
    /// credential, so it needs the live token like every pairing leg.
    func testConnectedPairScreen() throws {
        guard FileManager.default.contents(atPath: pairFilePath) != nil else {
            throw XCTSkip("\(pairFilePath) missing — drive this test through scripts/ios-pairing-gate.sh")
        }
        for appearance in ["light", "dark"] {
            let pair = try pairing()
            let app = XCUIApplication()
            // 15 s of hold: the alert-dismissal pass + pinToTop + capture
            // inside shot() must land inside it or the Bots list is what the
            // capture records instead of the success line.
            launch(app, appearance: appearance, reset: true, holdSeconds: 15)
            XCTAssertTrue(app.textFields["Mac address"].waitForExistence(timeout: 15))
            type(app, app.textFields["Mac address"], pair.host)
            type(app, app.secureTextFields["Pairing token"], pair.token)
            var waited = 0.0
            while !app.buttons["manual-connect"].isEnabled && waited < 3 {
                usleep(250_000)
                waited += 0.25
            }
            if !app.buttons["manual-connect"].isEnabled {
                type(app, app.secureTextFields["Pairing token"], pair.token)
            }
            // The hold runs while the keyboard still covers the button row
            // here; dismiss with Return (the swipe doesn't take on iOS-26.5)
            // or the coordinate tap on Connect lands on the keyboard.
            dismissKeyboard(app)
            tapButton(app, "Connect")
            // Poll for the success line; a blocking keyboard-wait would
            // outlast the hold and shoot the Bots list instead. Manual
            // pairing names the Mac by its host (PairingPayload falls back
            // to host when the QR name is absent), so match the prefix.
            let connected = app.staticTexts.matching(NSPredicate(
                format: "identifier == 'pairing-status' AND label BEGINSWITH %@",
                "Connected to ")).firstMatch
            let deadline = Date().addingTimeInterval(15)
            while Date() < deadline, !connected.exists {
                usleep(250_000)
            }
            if !connected.exists {
                XCTFail("success line never appeared")
                shot("pairing-connected-debug-\(suffix(app, appearance: appearance, typeSize: nil))", app)
                app.terminate()
                continue
            }
            XCTAssertTrue(connected.exists,
                          "success line expired before the shot — hold too short")
            pinToTop(app)
            hostShot(
                "pairing-connected-\(suffix(app, appearance: appearance, typeSize: nil))",
                app, alertsWindow: 1.5
            )
            // markPaired lands only after the hold; terminating mid-hold
            // would leave the store unpaired for the revoke/testB legs.
            // Wait for the positive paired-root signal (its nav bar): a
            // nonexistence poll can return on a transient snapshot miss.
            // XCTest polling starves the MainActor the hold sleeps on, so
            // give it real headroom and fail THIS leg, not testB downstream.
            XCTAssertTrue(
                waitForBotsRoot(app, timeout: 40),
                "paired root never appeared — terminating would bank unpaired")
            // cfprefsd's disk flush is async past persist()'s ack; the gate's
            // wait_banked holds the leg's end until `paired` is on disk, so
            // the revoke leg can never migrate the launch-time `unpaired`.
            app.terminate()
        }
    }

    /// Same success line at XXXL — the spec's accessibility pass applies to
    /// every pairing state, transient included.
    func testConnectedPairScreenAccessibility() throws {
        guard FileManager.default.contents(atPath: pairFilePath) != nil else {
            throw XCTSkip("\(pairFilePath) missing — drive this test through scripts/ios-pairing-gate.sh")
        }
        for appearance in ["light", "dark"] {
            let pair = try pairing()
            let app = XCUIApplication()
            launch(app, appearance: appearance, typeSize: "xxxl", reset: true,
                   holdSeconds: 15)
            XCTAssertTrue(app.textFields["Mac address"].waitForExistence(timeout: 15))
            type(app, app.textFields["Mac address"], pair.host)
            type(app, app.secureTextFields["Pairing token"], pair.token)
            var waited = 0.0
            while !app.buttons["manual-connect"].isEnabled && waited < 3 {
                usleep(250_000)
                waited += 0.25
            }
            if !app.buttons["manual-connect"].isEnabled {
                type(app, app.secureTextFields["Pairing token"], pair.token)
            }
            dismissKeyboard(app)
            tapButton(app, "Connect")
            let connected = app.staticTexts.matching(NSPredicate(
                format: "identifier == 'pairing-status' AND label BEGINSWITH %@",
                "Connected to ")).firstMatch
            let deadline = Date().addingTimeInterval(15)
            while Date() < deadline, !connected.exists {
                usleep(250_000)
            }
            if !connected.exists {
                XCTFail("success line never appeared")
                shot("pairing-connected-debug-\(suffix(app, appearance: appearance, typeSize: "xxxl"))", app)
                app.terminate()
                continue
            }
            XCTAssertTrue(connected.exists,
                          "success line expired before the shot — hold too short")
            pinToTop(app)
            hostShot(
                "pairing-connected-\(suffix(app, appearance: appearance, typeSize: "xxxl"))",
                app, alertsWindow: 1.5
            )
            // markPaired lands only after the hold; terminating mid-hold
            // would leave the store unpaired for the revoke/testB legs.
            // Same reasoning as testConnectedPairScreen: assert the paired
            // root with headroom so this leg fails instead of testB.
            XCTAssertTrue(
                waitForBotsRoot(app, timeout: 40),
                "paired root never appeared — terminating would bank unpaired")
            // Same banked-state hold as the standard leg above.
            app.terminate()
        }
    }

    /// Connecting state: a loopback listener that accepts and never answers
    /// holds the exchange open, so the spinner copy is stable. The gate
    /// starts the stub (see ios-pairing-gate.sh); without it this skips.
    func testConnectingBothAppearances() throws {
        guard FileManager.default.contents(atPath: "/tmp/ub-stub-up") != nil else {
            throw XCTSkip("/tmp/ub-stub-up missing — the gate's stall stub is not running")
        }
        for appearance in ["light", "dark"] {
            let app = XCUIApplication()
            launch(app, appearance: appearance, reset: true)
            XCTAssertTrue(app.textFields["Mac address"].waitForExistence(timeout: 15))
            type(app, app.textFields["Mac address"], "http://127.0.0.1:59999")
            type(app, app.secureTextFields["Pairing token"], "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
            dismissKeyboard(app)
            app.buttons["manual-connect"].tap()
            XCTAssertTrue(
                app.staticTexts["Connecting to your Mac"].waitForExistence(timeout: 15),
                "connecting copy never appeared")
            hostShot(
                "pairing-connecting-\(suffix(app, appearance: appearance, typeSize: nil))",
                app
            )
            app.terminate()
        }
    }

    /// Re-paired Bots list in dark — the flow leg's `bots-repaired` shot is
    /// light-only, so the gate runs this right after testC while the rotated
    /// credential still holds the pairing.
    func testRepairedDark() throws {
        guard FileManager.default.contents(atPath: pairFilePath) != nil else {
            throw XCTSkip("\(pairFilePath) missing — drive this test through scripts/ios-pairing-gate.sh")
        }
        let app = XCUIApplication()
        launch(app, appearance: "dark")
        XCTAssertTrue(waitForBotsRoot(app, timeout: 25), "re-paired app never reached the Bots list")
        shot("bots-repaired-\(suffix(app, appearance: "dark", typeSize: nil))", app)
        app.terminate()
    }

    /// Loading state (spec 1.2): UB_HANG_SHELL holds the roster fetch so the
    /// skeleton rows stay on screen for the shot.
    func testBotsLoading() throws {
        for appearance in ["light", "dark"] {
            let app = XCUIApplication()
            launch(app, appearance: appearance, hangShell: true)
            XCTAssertTrue(
                app.descendants(matching: .any)
                    .matching(identifier: "bots-skeleton").firstMatch
                    .waitForExistence(timeout: 20),
                "skeleton never rendered")
            shot("bots-loading-\(suffix(app, appearance: appearance, typeSize: nil))", app)
            app.terminate()
        }
    }

    /// Empty state (spec 1.2): UB_EMPTY_SHELL answers the roster with zero
    /// bots so "Create your first bot" + "New bot" render for the shot.
    func testBotsEmpty() throws {
        for appearance in ["light", "dark"] {
            let app = XCUIApplication()
            launch(app, appearance: appearance, emptyShell: true)
            XCTAssertTrue(
                app.staticTexts["Create your first bot"].waitForExistence(timeout: 25),
                "empty state never rendered")
            shot("bots-empty-\(suffix(app, appearance: appearance, typeSize: nil))", app)
            app.terminate()
        }
    }

    /// Error state (design spec 1.2): UB_FAIL_SHELL makes the roster fetch
    /// fail while the Mac stays reachable — the inline error line + Retry
    /// render, never the empty state.
    func testBotsLoadError() throws {
        for appearance in ["light", "dark"] {
            let app = XCUIApplication()
            launch(app, appearance: appearance, failShell: true)
            XCTAssertTrue(
                app.descendants(matching: .any)
                    .matching(identifier: "bots-load-error").firstMatch
                    .waitForExistence(timeout: 20),
                "load-error row never rendered")
            shot("bots-load-error-\(suffix(app, appearance: appearance, typeSize: nil))", app)
            app.terminate()
        }
    }

    /// Same state at accessibility XXXL — the error line must wrap, never
    /// truncate (A.7).
    func testBotsLoadErrorAccessibility() throws {
        for appearance in ["light", "dark"] {
            let app = XCUIApplication()
            launch(app, appearance: appearance, typeSize: "xxxl", failShell: true)
            XCTAssertTrue(
                app.descendants(matching: .any)
                    .matching(identifier: "bots-load-error").firstMatch
                    .waitForExistence(timeout: 20),
                "load-error row never rendered")
            shot("bots-load-error-\(suffix(app, appearance: appearance, typeSize: "xxxl"))", app)
            app.terminate()
        }
    }

    /// Credential-expiring banner (spec 11, design 1.2's fourth row):
    /// UB_CREDENTIAL_EXPIRY_DAYS=3 puts the credential inside the seven-day
    /// window so the one-time banner renders — and Devices shows its own
    /// Credential-expiring state (warning value + the re-pair row).
    func testExpiryBanner() throws {
        for appearance in ["light", "dark"] {
            let app = XCUIApplication()
            launch(app, appearance: appearance, expiryDays: 3)
            XCTAssertTrue(waitForBotsRoot(app, timeout: 15))
            if !app.staticTexts["Pairing expires in 3 days"]
                .waitForExistence(timeout: 15) {
                let tree = app.descendants(matching: .staticText)
                    .allElementsBoundByIndex.map(\.label)
                XCTFail("expiry banner never rendered; texts: \(tree)")
            }
            shot("bots-expiring-\(suffix(app, appearance: appearance, typeSize: nil))", app)

            openDevices(app)
            XCTAssertTrue(app.navigationBars["Devices"].waitForExistence(timeout: 10),
                          "Devices push never presented")
            XCTAssertTrue(app.buttons["Re-pair from your Mac"].waitForExistence(timeout: 10),
                          "re-pair row never rendered")
            shot("devices-expiring-\(suffix(app, appearance: appearance, typeSize: nil))", app)

            // Re-pair pushes the real pairing flow (design spec 1.15); the
            // pushed state keeps the nav bar so the back chevron is the exit.
            tapButton(app, "Re-pair from your Mac")
            XCTAssertTrue(
                app.staticTexts["Connect to your Mac"].waitForExistence(timeout: 15),
                "pushed pairing screen never presented")
            let navBar = app.navigationBars.firstMatch
            XCTAssertTrue(navBar.waitForExistence(timeout: 10),
                          "pushed pairing screen hid its nav bar")
            XCTAssertTrue(navBar.buttons.count > 0,
                          "pushed pairing screen has no back affordance")
            shot("pairing-repair-\(suffix(app, appearance: appearance, typeSize: nil))", app)
            app.terminate()
        }
    }

    /// Pairing screen offline (spec 1.1): "You're offline" on the status
    /// line, scanning paused, Enter manually disabled with the reason.
    /// Runs at the end of the gate — needs no credential.
    func testOfflinePairing() throws {
        for appearance in ["light", "dark"] {
            let app = XCUIApplication()
            launch(app, appearance: appearance, reset: true, offline: true)
            XCTAssertTrue(
                app.staticTexts["You're offline"].waitForExistence(timeout: 15),
                "offline status never appeared")
            // Camera is pinned denied for shots, so manual entry sits inline:
            // its Connect carries the same disabled-with-reason chrome.
            XCTAssertFalse(app.buttons["manual-connect"].isEnabled,
                           "manual Connect should be disabled offline")
            shot("pairing-offline-\(suffix(app, appearance: appearance, typeSize: nil))", app)
            app.terminate()
        }
    }

    /// Signed-out error + offline (spec 1.18): the gate holds the web
    /// service down for this leg, so the sign-out is offline-pure and the
    /// Sign-in retry lands the unreachable error on the reason line.
    /// Leaves the app signedOut — testResignIn re-pairs it.
    func testSignedOutStates() throws {
        guard FileManager.default.contents(atPath: "/tmp/ub-web-down") != nil else {
            throw XCTSkip("/tmp/ub-web-down missing — only valid while the gate holds the web service down")
        }
        for appearance in ["light", "dark"] {
            // Reach signedOut: from the paired root open Devices and sign
            // out; on the second appearance the state is already there.
            let app = XCUIApplication()
            launch(app, appearance: appearance)
            if app.buttons["Devices"].waitForExistence(timeout: 10) {
                openDevices(app)
                XCTAssertTrue(app.navigationBars["Devices"].waitForExistence(timeout: 10),
                              "Devices push never presented")
                tapButton(app, "Sign out on this phone")
            }
            XCTAssertTrue(app.staticTexts["Signed out"].waitForExistence(timeout: 15),
                          "signed-out screen never appeared")
            let s = suffix(app, appearance: appearance, typeSize: nil)

            // Error state: the web service is down, so tapping Sign in
            // exchanges nowhere and the reason line carries the failure.
            tapButton(app, "signed-out-sign-in")
            XCTAssertTrue(
                app.staticTexts["signed-out-reason"].waitForExistence(timeout: 15),
                "error reason never appeared")
            shot("signed-out-error-\(s)", app)
            app.terminate()

            // Offline state: the pinned monitor renders the disabled reason
            // and greys Sign in.
            let off = XCUIApplication()
            launch(off, appearance: appearance, offline: true)
            XCTAssertTrue(off.staticTexts["Signed out"].waitForExistence(timeout: 15))
            XCTAssertTrue(off.staticTexts["You're offline"].waitForExistence(timeout: 10))
            XCTAssertFalse(off.buttons["signed-out-sign-in"].isEnabled,
                           "Sign in should be disabled offline")
            dismissSystemAlerts(off)
            shot("signed-out-offline-\(s)", app)
            off.terminate()
        }
    }

    /// Recovery leg for testSignedOutStates: the web service is back up, so
    /// a Sign-in tap re-exchanges and the app lands paired again for the
    /// banner legs that follow.
    func testResignIn() throws {
        let app = XCUIApplication()
        launch(app, appearance: "light")
        XCTAssertTrue(app.staticTexts["Signed out"].waitForExistence(timeout: 15),
                      "app was not left signedOut")
        tapButton(app, "signed-out-sign-in")
        XCTAssertTrue(waitForBotsRoot(app, timeout: 30), "re-sign-in never reached the Bots list")
        // The gate's wait_banked holds after this leg until `paired` is on
        // disk — the runtime-down leg would otherwise risk migrating the
        // launch-time `signedOut` (observed once on the 402 run).
        app.terminate()
    }
}
