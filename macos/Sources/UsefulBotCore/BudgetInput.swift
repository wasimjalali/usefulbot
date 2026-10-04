import Foundation

/// Why a typed budget was refused. The message names the rule it broke.
public struct BudgetInputError: Error, Equatable, Sendable {
    public let message: String
}

public extension Result where Failure == BudgetInputError {
    var errorMessage: String? {
        if case .failure(let error) = self { return error.message }
        return nil
    }
}

/// Parsing and formatting for the two daily budgets in the usage settings.
/// There is no product ceiling: the only upper bound is the largest integer
/// that survives JSON and a JS number exactly, and a value past it is refused,
/// never clamped or wrapped.
public enum BudgetInput {
    public static let maxSafe = 9_007_199_254_740_991
    private static let million = 1_000_000.0

    /// The token field is in millions: "500", "3.5", "3.5M" and "1,000" all mean
    /// what they look like. A comma is only a thousands separator ("1,000",
    /// never "3,5"), and the M goes at the end only.
    public static func tokens(_ text: String, min: Int, max: Int?) -> Result<Int, BudgetInputError> {
        var body = text.trimmingCharacters(in: .whitespaces)
        if let last = body.last, last == "M" || last == "m" {
            body.removeLast()
            body = body.trimmingCharacters(in: .whitespaces)
        }
        let parts = body.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false)
        let whole = parts.first.map(String.init) ?? ""
        let fraction = parts.count > 1 ? String(parts[1]) : ""
        guard parts.count <= 2, isDigitGroups(whole, allowEmpty: !fraction.isEmpty),
              fraction.allSatisfy({ $0.isASCII && $0.isNumber }),
              let millions = Double((whole.isEmpty ? "0" : whole.replacingOccurrences(of: ",", with: "")) + "." + (fraction.isEmpty ? "0" : fraction)),
              millions.isFinite else {
            return .failure(.init(message: "Type the limit in millions, like 500 or 3.5."))
        }
        let tokens = (millions * million).rounded()
        let ceiling = Swift.min(max ?? maxSafe, maxSafe)
        if tokens < Double(min) {
            return .failure(.init(message: "Has to be at least \(tokenLabel(min)) tokens."))
        }
        if tokens > Double(ceiling) {
            return .failure(.init(message: "Has to be at most \(grouped(ceiling)) tokens."))
        }
        return .success(Int(tokens))
    }

    /// The request field is a whole number, plain or grouped.
    public static func requests(_ text: String, min: Int, max: Int? = nil) -> Result<Int, BudgetInputError> {
        let cleaned = text.trimmingCharacters(in: .whitespaces)
        guard isDigitGroups(cleaned, allowEmpty: false) else {
            return .failure(.init(message: "Type the request limit as a whole number."))
        }
        let ceiling = Swift.min(max ?? maxSafe, maxSafe)
        // Int(cleaned) is nil on overflow, which is also "too big".
        guard let value = Int(cleaned.replacingOccurrences(of: ",", with: "")), value <= ceiling else {
            return .failure(.init(message: "Has to be at most \(grouped(ceiling)) requests."))
        }
        if value < min {
            return .failure(.init(message: min == 1 ? "Has to be at least 1 request." : "Has to be at least \(grouped(min)) requests."))
        }
        return .success(value)
    }

    /// A refusal the server sent, in the same words the field would have used.
    public static func serverMessage(for code: String) -> String? {
        switch code {
        case "token_budget_min": return "Has to be at least 1M tokens."
        case "token_budget_max": return "Has to be at most \(grouped(maxSafe)) tokens."
        case "token_budget_invalid": return "Type the limit in millions, like 500 or 3.5."
        case "request_budget_min": return "Has to be at least 1 request."
        case "request_budget_max": return "Has to be at most \(grouped(maxSafe)) requests."
        case "request_budget_invalid": return "Type the request limit as a whole number."
        default: return nil
        }
    }

    /// Millions, with a tenth only when the budget has one, grouped above 999M:
    /// "500M", "1,000M", "3.5M". Showing 3,500,000 as "3M" would be the field
    /// lying about what is enforced.
    public static func tokenLabel(_ tokens: Int) -> String {
        let millions = Double(tokens) / million
        return millions == millions.rounded()
            ? "\(grouped(Int(millions)))M"
            : String(format: "%.1fM", millions)
    }

    public static func requestLabel(_ requests: Int) -> String { grouped(requests) }

    /// "0 of 12,345": exact, matching the stepper, never rounded to 12K.
    public static func requestUsage(used: Int, cap: Int) -> String {
        cap > 0 ? "\(grouped(used)) of \(grouped(cap))" : grouped(used)
    }

    /// A meter's fill. A budget lowered below what the day already used reads
    /// as full: never past it, never negative.
    public static func meterFraction(used: Int, cap: Int) -> Double {
        guard cap > 0 else { return 0 }
        return Swift.min(1, Swift.max(0, Double(used) / Double(cap)))
    }

    /// True when the owner has set a token budget above the shipped one.
    public static func tokenBudgetAboveDefault(tokens: Int, default shipped: Int) -> Bool {
        tokens > shipped
    }

    /// ASCII digits, either plain ("1500") or in strict thousands groups
    /// ("1,500", "12,345,678"): one to three digits, then groups of exactly three.
    /// Anything looser is a typo, not a number ("3,5" is not 35).
    private static func isDigitGroups(_ text: String, allowEmpty: Bool) -> Bool {
        if text.isEmpty { return allowEmpty }
        func digits(_ part: Substring) -> Bool { part.allSatisfy { $0.isASCII && $0.isNumber } }
        let groups = text.split(separator: ",", omittingEmptySubsequences: false)
        if groups.count == 1 { return digits(groups[0]) }
        // No leading zero once there are groups: "0,500" and "001,000" are typos.
        guard let first = groups.first, (1...3).contains(first.count), digits(first), first.first != "0" else { return false }
        return groups.dropFirst().allSatisfy { $0.count == 3 && digits($0) }
    }

    private static func grouped(_ value: Int) -> String {
        value.formatted(.number.grouping(.automatic).locale(Locale(identifier: "en_US")))
    }
}

/// Validation and refusal messages for the two budget fields, kept apart from
/// the usage poll's own error so a refresh can never wipe them.
public struct BudgetMessages: Equatable, Sendable {
    public enum Field: Sendable { case tokens, requests }
    public private(set) var tokens: String?
    public private(set) var requests: String?

    public init() {}

    public func message(for field: Field) -> String? {
        field == .tokens ? tokens : requests
    }

    /// The one line to show under the group.
    public var current: String? { tokens ?? requests }

    public mutating func set(_ field: Field, _ message: String) {
        if field == .tokens { tokens = message } else { requests = message }
    }

    public mutating func clear(_ field: Field) {
        if field == .tokens { tokens = nil } else { requests = nil }
    }
}

/// Budget writes held while another is in flight: one slot per field, so the
/// newest value for a field replaces an older one that never went out.
public struct PendingBudgetWrites<Write> {
    private var tokens: Write?
    private var requests: Write?

    public init() {}

    public mutating func hold(_ write: Write, for field: BudgetMessages.Field) {
        if field == .tokens { tokens = write } else { requests = write }
    }

    /// The next held write (tokens first), removed from the queue.
    public mutating func next() -> (field: BudgetMessages.Field, write: Write)? {
        if let write = tokens { tokens = nil; return (.tokens, write) }
        if let write = requests { requests = nil; return (.requests, write) }
        return nil
    }
}
