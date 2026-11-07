import Foundation

/// The `kordi://settings/connectors?provider=<id>` link an agent shares when
/// someone asks it to connect a service (issue 1712, PR 5). Opening it shows
/// account settings so the person connects the service themselves; the link
/// never grants anything. `kordi://settings/authentication` opens the AI
/// provider accounts instead, which a failed agent reply links its owner to.
struct ConnectorsSettingsLink: Equatable, Identifiable {
    static let providerIDs = ["gmail", "google_calendar", "github", "slack"]

    /// One of `providerIDs`, or nil for the Connectors list.
    let providerID: String?
    /// Opens Authentication (AI provider accounts) instead of Connectors.
    var opensAuthentication = false

    var id: String { opensAuthentication ? "authentication" : providerID ?? "connectors" }

    /// Nil for any URL that is not a Connectors settings link.
    static func parse(_ url: URL) -> ConnectorsSettingsLink? {
        guard url.scheme?.lowercased() == "kordi",
              url.host?.lowercased() == "settings",
              url.user == nil,
              url.password == nil
        else { return nil }
        let path = url.path.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if path == "authentication" { return ConnectorsSettingsLink(providerID: nil, opensAuthentication: true) }
        guard path == "connectors",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return nil }
        let provider = components.queryItems?.first { $0.name == "provider" }?.value
        return ConnectorsSettingsLink(
            providerID: provider.flatMap { providerIDs.contains($0) ? $0 : nil }
        )
    }
}

/// One opening of a Connectors settings link: the account settings path to
/// show and the connector whose detail to push on top of it. Each opening is
/// a new request, so the same link opened twice navigates again.
struct ConnectorsSettingsRequest: Equatable, Identifiable {
    let id = UUID()
    let path: [AccountSettingsRoute]
    /// Nil opens the Connectors list.
    let providerId: ConnectorProviderId?

    init(link: ConnectorsSettingsLink) {
        path = link.opensAuthentication ? [.authentication] : [.connectors]
        providerId = link.opensAuthentication ? nil : link.providerID.flatMap(ConnectorProviderId.init(rawValue:))
    }
}
