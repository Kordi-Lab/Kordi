import Foundation

/// Compiled edition copy explains admission; the server makes every access decision.
enum KordiLoginCopy {
    private static var configuration: KordiReleaseConfiguration? {
        #if BETA
        return nil
        #else
        return KordiReleaseConfiguration.read(Bundle.main.infoDictionary ?? [:])
        #endif
    }
    static func title(signup: Bool) -> String {
        let page = configuration?.loginPage
        return (signup ? page?.signupTitle : page?.title) ?? (signup ? "Create your account" : "Welcome to Kordi")
    }
    static func subtitle(signup: Bool, accessibility: Bool) -> String? {
        let page = configuration?.loginPage
        return (signup ? page?.signupSubtitle : page?.subtitle) ?? (accessibility ? "People and agents, together." : nil)
    }

    private static let passwordRule = "at least 8 characters, with an uppercase letter, a lowercase letter, and a number"
    static let passwordRuleHint = "Use \(passwordRule)."
    static let weakPasswordMessage = "Password must have \(passwordRule)."

    /// Mirrors the server sign-up policy; sign-in never checks it.
    static func isStrongPassword(_ password: String) -> Bool {
        password.count >= 8
            && password.contains(where: \.isUppercase)
            && password.contains(where: \.isLowercase)
            && password.unicodeScalars.contains { ("0"..."9").contains($0) }
    }
}
