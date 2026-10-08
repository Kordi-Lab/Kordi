import Foundation

/// The `kordi://settings/connectors?provider=<id>` link an agent shares when
/// someone asks it to connect a service (issue 1712, PR 5). Opening it shows
/// account settings so the person connects the service themselves; the link
/// never grants anything.
struct ConnectorsSettingsLink: Equatable, Identifiable {
    static let providerIDs = ["gmail", "google_calendar", "github", "slack"]

    /// One of `providerIDs`, or nil for the Connectors list.
    let providerID: String?

    var id: String { providerID ?? "connectors" }

    /// Nil for any URL that is not a Connectors settings link.
    static func parse(_ url: URL) -> ConnectorsSettingsLink? {
        guard url.scheme?.lowercased() == "kordi",
              url.host?.lowercased() == "settings",
              url.user == nil,
              url.password == nil,
              url.path.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "/")) == "connectors",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return nil }
        let provider = components.queryItems?.first { $0.name == "provider" }?.value
        return ConnectorsSettingsLink(
            providerID: provider.flatMap { providerIDs.contains($0) ? $0 : nil }
        )
    }
}
