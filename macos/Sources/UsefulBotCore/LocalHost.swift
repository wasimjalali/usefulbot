import Foundation

/// Host classification for links that arrive inside model or tool output.
/// Deterministic and dependency-free so it can be unit tested: a chip or a
/// markdown link must never be able to send the browser at the local server
/// with its session cookie.
public enum LocalHost {
    /// True for loopback, private, link-local and unspecified hosts, in any
    /// IPv4 spelling (dotted, short, hex, octal, single integer) or IPv6 form
    /// (loopback, link-local, unique-local, v4-mapped), plus `.local` names.
    public static func isLocal(_ host: String?) -> Bool {
        guard var value = host?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !value.isEmpty else {
            // An unknown host cannot be proven remote; fail closed.
            return true
        }
        if value.hasPrefix("["), value.hasSuffix("]") {
            value = String(value.dropFirst().dropLast())
        }
        if let zone = value.firstIndex(of: "%") {
            value = String(value[..<zone])
        }
        // Control and default-ignorable characters (zero-width joiners, bidi
        // marks) must not be able to disguise an address as remote.
        if value.unicodeScalars.contains(where: { $0.properties.isDefaultIgnorableCodePoint || $0.value < 0x21 }) {
            return true
        }
        if value.hasSuffix(".") { value.removeLast() }
        if value == "localhost" || value.hasSuffix(".localhost") || value.hasSuffix(".local") {
            return true
        }
        if value.contains(":") {
            return isLocalIPv6(value)
        }
        if let address = ipv4(value) {
            return isPrivateV4(address)
        }
        // A numeric-looking host that does not parse (08.0.0.1, 127..0.1) is
        // not provably remote; fail closed like any other unknown host.
        let numeric = CharacterSet(charactersIn: "0123456789abcdefABCDEFxX.")
        if value.contains(where: { $0.isNumber }),
           value.unicodeScalars.allSatisfy({ numeric.contains($0) }) {
            return true
        }
        return false
    }

    /// True for loopback only: the credential-bearing client base must allow
    /// nothing broader than 127.0.0.0/8, `::1` and localhost spellings.
    public static func isLoopback(_ host: String?) -> Bool {
        guard var value = host?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !value.isEmpty else {
            return false
        }
        if value.hasPrefix("["), value.hasSuffix("]") {
            value = String(value.dropFirst().dropLast())
        }
        if value.hasSuffix(".") { value.removeLast() }
        if value == "localhost" || value.hasSuffix(".localhost") || value == "::1" {
            return true
        }
        if value.contains(":") { return false }
        guard let address = ipv4(value) else { return false }
        return (address >> 24) & 0xff == 127
    }

    private static func isLocalIPv6(_ value: String) -> Bool {
        // Any embedded dotted IPv4 tail decides: ::ffff:127.0.0.1,
        // ::ffff:0:127.0.0.1 and 0:0:0:0:0:ffff:127.0.0.1 alike.
        if value.contains(".") {
            let tail = value.split(separator: ":").last.map(String.init) ?? value
            guard let address = ipv4(tail) else { return true } // malformed: fail closed
            return isPrivateV4(address)
        }
        // Expand to eight groups so compressed and full forms classify the
        // same: ::1 and 0:0:0:0:0:0:0:1, :: and 0:0:0:0:0:0:0:0.
        guard let groups = ipv6Groups(value) else { return true } // malformed: fail closed
        if groups.allSatisfy({ $0 == 0 }) { return true }
        if groups.dropLast().allSatisfy({ $0 == 0 }), groups.last == 1 { return true }
        if groups[0] & 0xffc0 == 0xfe80 { return true } // fe80::/10 link-local
        if groups[0] & 0xfe00 == 0xfc00 { return true } // fc00::/7 unique-local
        if groups[0] == 0, groups[1] == 0, groups[2] == 0, groups[3] == 0,
           groups[4] == 0, groups[5] == 0xffff {
            // Standard v4-mapped in hex form: the last 32 bits are the IPv4.
            return isPrivateV4(UInt32(groups[6]) << 16 | UInt32(groups[7]))
        }
        return false
    }

    /// Expand a dotted-tail-free IPv6 literal to eight 16-bit groups,
    /// accepting one `::`. Returns nil for anything malformed.
    private static func ipv6Groups(_ value: String) -> [UInt16]? {
        let halves = value.components(separatedBy: "::")
        guard halves.count <= 2 else { return nil }

        func parse(_ part: String) -> [UInt16]? {
            guard !part.isEmpty else { return [] }
            var groups: [UInt16] = []
            for token in part.split(separator: ":") {
                guard let group = UInt16(token, radix: 16) else { return nil }
                groups.append(group)
            }
            return groups
        }

        guard let left = parse(halves[0]) else { return nil }
        guard halves.count == 2 else {
            return left.count == 8 ? left : nil
        }
        guard let right = parse(halves[1]), left.count + right.count <= 8 else { return nil }
        let zeros = Array(repeating: UInt16(0), count: 8 - left.count - right.count)
        return left + zeros + right
    }

    /// The phone's link rule (spec 4.7): the shared `isLocal` set plus the
    /// paired Mac's own host, injected by the caller — a model-authored link
    /// must never open the paired host either, which is the credential's own
    /// address. `pairedHost` is a bare host string (no scheme) or nil.
    public static func isBlocked(_ host: String?, pairedHost: String?) -> Bool {
        func normalized(_ value: String) -> String {
            var host = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if host.hasPrefix("["), host.hasSuffix("]") {
                host = String(host.dropFirst().dropLast())
            }
            if let zone = host.firstIndex(of: "%") {
                host = String(host[..<zone])
            }
            if host.hasSuffix(".") { host.removeLast() }
            return host
        }
        if let pairedHost, let host, normalized(host) == normalized(pairedHost) {
            return true
        }
        return isLocal(host)
    }

    private static func isPrivateV4(_ address: UInt32) -> Bool {
        let first = (address >> 24) & 0xff
        let second = (address >> 16) & 0xff
        if first == 0 || first == 10 || first == 127 { return true }
        if first == 192, second == 168 { return true }
        if first == 172, (16...31).contains(second) { return true }
        if first == 169, second == 254 { return true }
        // 100.64.0.0/10 — the tailnet CGNAT range a paired Mac lives in
        // (spec 4.7 block list).
        if first == 100, (64...127).contains(second) { return true }
        return false
    }

    /// WHATWG-style IPv4 parsing: `127.1`, `0x7f.0.0.1`, `0177.0.0.1` and
    /// `2130706433` all resolve to loopback and must not slip past.
    private static func ipv4(_ value: String) -> UInt32? {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard (1...4).contains(parts.count) else { return nil }
        var numbers: [UInt32] = []
        for part in parts {
            guard !part.isEmpty, let number = ipv4Part(String(part)) else { return nil }
            numbers.append(number)
        }
        let head = numbers.dropLast()
        guard head.allSatisfy({ $0 <= 255 }) else { return nil }
        let remaining = 4 - head.count
        let capacity: UInt32 = remaining == 4 ? .max : (1 << (8 * remaining)) - 1
        guard let last = numbers.last, last <= capacity else { return nil }
        var address: UInt32 = 0
        for byte in head { address = (address << 8) | byte }
        return (address << (8 * remaining)) | last
    }

    private static func ipv4Part(_ part: String) -> UInt32? {
        if part.hasPrefix("0x") {
            return UInt32(part.dropFirst(2), radix: 16)
        }
        if part.count > 1, part.hasPrefix("0") {
            return UInt32(part.dropFirst(), radix: 8)
        }
        return UInt32(part, radix: 10)
    }
}
