import Foundation

/// Supplies the device credential `BackendClient` sends to
/// `api/auth/session`. The desktop reads the login Keychain through the
/// `security` CLI; the phone reads the paired token from SecItem (PR-2).
public protocol DeviceTokenStore: Sendable {
    /// May block behind a Keychain prompt, so callers keep it off the actor
    /// executor.
    func token() throws -> String
}

/// A value pinned in memory. Pairing validates a candidate token through it
/// before the credential is written to the shared Keychain item — an
/// unvalidated write would let an in-flight re-auth on the live client mint
/// against it and burn a healthy pairing.
public struct InMemoryDeviceTokenStore: DeviceTokenStore {
    private let value: String

    public init(_ value: String) {
        self.value = value
    }

    public func token() throws -> String {
        value
    }
}

#if os(macOS)
/// The desktop token source: `/usr/bin/security find-generic-password` with
/// the bounded wait the app has always used, so a locked Keychain cannot stall
/// a launch.
public struct ProcessDeviceTokenStore: DeviceTokenStore {
    public let service: String

    public init(service: String) {
        self.service = service
    }

    public func token() throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        process.arguments = ["find-generic-password", "-s", service, "-w"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            throw BackendError.deviceTokenMissing
        }
        // A locked Keychain can block the CLI behind a prompt; never stall the
        // launch on it.
        let deadline = Date().addingTimeInterval(5)
        while process.isRunning, Date() < deadline {
            usleep(50_000)
        }
        if process.isRunning {
            process.terminate()
            // A Keychain unlock prompt ignores SIGTERM; give it a short grace
            // then make sure the CLI cannot leak into the next launch.
            let killDeadline = Date().addingTimeInterval(1)
            while process.isRunning, Date() < killDeadline {
                usleep(50_000)
            }
            if process.isRunning {
                kill(process.processIdentifier, SIGKILL)
            }
            // Still running past the deadline means it was waiting on an
            // interaction prompt, not that the item is absent.
            throw BackendError.keychainLocked
        }
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw BackendClient.keychainFailure(for: process.terminationStatus)
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let token = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !token.isEmpty else { throw BackendError.deviceTokenMissing }
        return token
    }
}
#endif
