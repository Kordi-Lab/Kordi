import Foundation

/// A public allowlist embedded by the validated ops build, covered by the app signature.
struct KordiReleaseConfiguration: Decodable {
    let edition: String
    let backendOrigin: String
    let callbackScheme: String
    let iosIdentifier: String
    let iosShareIdentifier: String
    let appGroup: String
    let credentialService: String

    static func read(_ info: [String: Any]) -> KordiReleaseConfiguration? {
        guard let encoded = info["KordiExpectedDistribution"] as? String,
              let data = Data(base64Encoded: encoded),
              let value = try? JSONDecoder().decode(Self.self, from: data),
              ["app", "research"].contains(value.edition),
              let url = URL(string: value.backendOrigin),
              url.scheme == "https", url.host != nil,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/",
              !value.iosIdentifier.split(separator: ".").contains("beta"),
              value.callbackScheme != "kordi-beta",
              value.iosShareIdentifier == "\(value.iosIdentifier).share" else { return nil }
        if value.edition == "research" {
            guard value.iosIdentifier.split(separator: ".").contains("research"),
                  value.appGroup.split(separator: ".").contains("research"),
                  value.credentialService.split(separator: ".").contains("research"),
                  value.callbackScheme.split(separator: "-").contains("research") else { return nil }
        }
        return value
    }

    var channel: String { edition == "app" ? "production" : "research" }
}
