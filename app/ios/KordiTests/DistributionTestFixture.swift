import Foundation

/// Synthetic build identity for tests; never used by the application.
enum DistributionTestFixture {
    static func encoded(research: Bool = false) -> String {
        let value = [
            "edition": research ? "research" : "app",
            "backendOrigin": research ? "https://research.example.test" : "https://kordi.ai",
            "callbackScheme": research ? "kordi-research" : "kordi",
            "iosIdentifier": research ? "ai.kordi.ios.research" : "ai.kordi.ios",
            "iosShareIdentifier": research ? "ai.kordi.ios.research.share" : "ai.kordi.ios.share",
            "appGroup": research ? "group.ai.kordi.research.share" : "group.ai.kordi.share",
            "credentialService": research ? "ai.kordi.research.share-session" : "ai.kordi.share-session"
        ]
        return try! JSONEncoder().encode(value).base64EncodedString()
    }
}
