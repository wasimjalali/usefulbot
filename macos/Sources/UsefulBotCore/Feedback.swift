import Foundation

/// Settings > Feedback's client for the feedback Worker
/// (`POST {UBFeedbackURL}`, see services/feedback). Only what the owner types
/// and, when the box is checked, the app and Mac versions are sent.
public enum FeedbackKind: String, CaseIterable, Codable, Sendable {
    case idea
    case problem
    case other
}

/// The optional details line. Each value is 1 to 64 printable ASCII
/// characters or null, the Worker's rule, so one odd value drops to null
/// instead of failing the send.
public struct FeedbackContext: Encodable, Equatable, Sendable {
    public let appVersion: String?
    public let build: String?
    public let macosVersion: String?
    public let chip: String?

    public init(appVersion: String?, build: String?, macosVersion: String?, chip: String?) {
        self.appVersion = Self.clean(appVersion)
        self.build = Self.clean(build)
        self.macosVersion = Self.clean(macosVersion)
        self.chip = Self.clean(chip)
    }

    static func clean(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              (1...64).contains(value.unicodeScalars.count),
              value.unicodeScalars.allSatisfy({ (0x20...0x7E).contains($0.value) }) else { return nil }
        return value
    }

    enum CodingKeys: String, CodingKey { case appVersion, build, macosVersion, chip }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(appVersion, forKey: .appVersion)
        try c.encode(build, forKey: .build)
        try c.encode(macosVersion, forKey: .macosVersion)
        try c.encode(chip, forKey: .chip)
    }
}

public struct FeedbackSubmission: Encodable, Sendable {
    public let kind: FeedbackKind
    public let message: String
    public let replyEmail: String?
    public let installId: String
    public let context: FeedbackContext?

    public init(kind: FeedbackKind, message: String, replyEmail: String?, installId: String, context: FeedbackContext?) {
        self.kind = kind
        self.message = message.trimmingCharacters(in: .whitespacesAndNewlines)
        let email = replyEmail?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.replyEmail = email.isEmpty ? nil : email
        self.installId = installId
        self.context = context
    }

    enum CodingKeys: String, CodingKey { case kind, message, replyEmail, installId, context }

    // Nulls are sent as null, never left out and never as "".
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(kind, forKey: .kind)
        try c.encode(message, forKey: .message)
        try c.encode(replyEmail, forKey: .replyEmail)
        try c.encode(installId, forKey: .installId)
        try c.encode(context, forKey: .context)
    }
}

public enum FeedbackResult: Equatable, Sendable {
    case sent
    case invalid(field: String?, message: String?)
    case rateLimited
    /// A 5xx, an answer that is not the Worker's, or no connection at all.
    case server
}

public enum Feedback {
    public static let messageMax = 4_000
    /// Where the anonymous install id lives. Created once, kept.
    public static let installIdKey = "ub.installId"

    /// The Worker's count: code points of the trimmed message.
    public static func length(_ message: String) -> Int {
        message.trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars.count
    }

    public static func canSend(_ message: String) -> Bool {
        (1...messageMax).contains(length(message))
    }

    /// A light check for the optional reply address: one @, a dot after it,
    /// no spaces. The Worker validates for real.
    public static func plausibleEmail(_ value: String) -> Bool {
        let email = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = email.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty, !email.contains(where: \.isWhitespace) else { return false }
        let domain = parts[1]
        guard let dot = domain.lastIndex(of: "."), dot != domain.startIndex,
              domain.index(after: dot) != domain.endIndex else { return false }
        return true
    }

    public static func macOSVersion(_ version: OperatingSystemVersion = ProcessInfo.processInfo.operatingSystemVersion) -> String {
        version.patchVersion == 0
            ? "\(version.majorVersion).\(version.minorVersion)"
            : "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"
    }

    /// The install id, made on first use and kept in `defaults`.
    public static func installId(_ defaults: UserDefaults = .standard) -> String {
        if let existing = defaults.string(forKey: installIdKey), !existing.isEmpty { return existing }
        let made = UUID().uuidString.lowercased()
        defaults.set(made, forKey: installIdKey)
        return made
    }

    public static func request(url: URL, submission: FeedbackSubmission) throws -> URLRequest {
        var request = URLRequest(url: url, timeoutInterval: 20)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(submission)
        return request
    }

    private struct Answer: Decodable {
        let ok: Bool?
        let error: String?
        let field: String?
        let message: String?
    }

    public static func result(status: Int, body: Data) -> FeedbackResult {
        let answer = try? JSONDecoder().decode(Answer.self, from: body)
        switch status {
        case 201:
            return .sent
        case 200 where answer?.ok == true:
            return .sent
        case 429:
            return .rateLimited
        // Only the Worker's own refusal blames the form; a 400 from anything
        // in front of it (a proxy, a captive portal) reads as unreachable.
        case 400 where answer?.error == "invalid":
            return .invalid(field: answer?.field, message: answer?.message)
        // 404, 413, 415 and the like mean a wrong endpoint, not a wrong form.
        default:
            return .server
        }
    }

    public static func send(_ submission: FeedbackSubmission, to url: URL, session: URLSession = .shared) async -> FeedbackResult {
        do {
            let (data, response) = try await session.data(for: request(url: url, submission: submission))
            guard let http = response as? HTTPURLResponse else { return .server }
            return result(status: http.statusCode, body: data)
        } catch {
            return .server
        }
    }
}
