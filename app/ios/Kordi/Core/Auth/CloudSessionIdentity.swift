import Foundation

/// The access tokens of the current sign-in. A browser sign-in rotates its
/// access token every hour, so work started under an earlier token of the
/// same sign-in is still current, while work from a signed-out or replaced
/// sign-in is not. Comparing raw tokens would drop that work on every refresh.
struct CloudSessionIdentity: Equatable {
    private var tokens: Set<String> = []

    /// Follows the model's token: nil ends the sign-in, a value joins it.
    mutating func follow(_ token: String?) {
        if let token {
            tokens.insert(token)
        } else {
            tokens.removeAll()
        }
    }

    /// Whether `token` belongs to the current sign-in.
    func contains(_ token: String?) -> Bool {
        guard let token else { return false }
        return tokens.contains(token)
    }
}
