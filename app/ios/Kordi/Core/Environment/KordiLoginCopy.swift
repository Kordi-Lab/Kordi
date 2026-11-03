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
}
