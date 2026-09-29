#if os(iOS)
import Foundation
import Security

/// The phone's device token, held in the iOS Keychain exactly as spec 4.1
/// prescribes: `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly` (the item
/// dies with a wiped device and exists only while a passcode is set),
/// `kSecAttrSynchronizable = false` (never iCloud), service
/// `com.usefulbot.device.phone`, and `kSecAttrAccount` = the canonical origin
/// the token was paired for — so a token can only ever be read back for the
/// endpoint it was minted against.
///
/// The value never touches UserDefaults, files, logs or the pasteboard; API
/// accepts and returns `String` because SecItem values are `Data`, and the
/// caller holds the string only for the duration of a sign-in.
public struct PhoneKeychainStore: DeviceTokenStore {
    public static let service = "com.usefulbot.device.phone"

    /// The canonical origin this store answers for. A store is cheap; a new
    /// origin means a new store.
    public let account: String

    public init(account: CanonicalOrigin) {
        self.account = account.value
    }

    public init?(storedOrigin: String?) {
        guard let storedOrigin else { return nil }
        self.account = storedOrigin
    }

    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
    }

    public func token() throws -> String {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data,
                  let token = String(data: data, encoding: .utf8),
                  !token.isEmpty else {
                throw BackendError.deviceTokenMissing
            }
            return token
        case errSecItemNotFound:
            throw BackendError.deviceTokenMissing
        case errSecInteractionNotAllowed:
            throw BackendError.keychainLocked
        case errSecUserCanceled:
            throw BackendError.keychainCancelled
        case errSecAuthFailed, errSecMissingEntitlement:
            throw BackendError.keychainDenied
        default:
            throw BackendError.deviceTokenMissing
        }
    }

    /// Write the token. An existing item for the same origin is overwritten in
    /// place (re-pairing the same Mac) rather than deleted-then-added, so a
    /// failed add cannot leave the phone with nothing stored.
    public func store(token: String) throws {
        guard let data = token.data(using: .utf8) else {
            throw BackendError.decoding
        }
        let attributes: [String: Any] = [
            // Data protection: never a backup, never off this device, and
            // the item is unusable once a passcode is removed.
            kSecAttrAccessible as String: kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
            kSecValueData as String: data,
        ]
        let status = SecItemAdd(baseQuery().merging(attributes) { _, new in new } as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let update = SecItemUpdate(
                baseQuery() as CFDictionary,
                [kSecValueData as String: data] as CFDictionary
            )
            guard update == errSecSuccess else {
                throw BackendError.keychainDenied
            }
            return
        }
        guard status == errSecSuccess else {
            throw BackendError.keychainDenied
        }
    }

    /// Delete the token for this origin. Unpair calls it; it is idempotent.
    public func deleteToken() {
        SecItemDelete(baseQuery() as CFDictionary)
    }

    /// The stored origin for a re-pair check: `PairingStore` keeps the origin
    /// itself; this only answers whether a token exists for it.
    public func hasToken() -> Bool {
        var query = baseQuery()
        query[kSecReturnData as String] = false
        return SecItemCopyMatching(query as CFDictionary, nil) == errSecSuccess
    }
}
#endif
