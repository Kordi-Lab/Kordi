import Foundation

/// Public Kordi ID: a nine-digit number or a user-chosen handle (3-30 letters and digits, at least one letter).
enum KordiID {
    /// Returns the nine-digit number or the handle (case preserved), or nil when the input is not valid.
    static func normalize(_ value: String?) -> String? {
        var text = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("@") { text.removeFirst() }
        guard !text.isEmpty else { return nil }

        let numberOnly = text.allSatisfy { $0.isASCII && ($0.isNumber || $0 == " " || $0 == "-") }
        if numberOnly {
            let digits = text.filter { $0.isASCII && $0.isNumber }
            guard digits.count == 9, !digits.hasPrefix("0") else { return nil }
            return digits
        }
        guard (3...30).contains(text.count),
              text.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }),
              text.contains(where: { $0.isASCII && $0.isLetter }) else { return nil }
        return text
    }
}
