import Foundation

// Connectors let a person link services and device-local sources so their
// agent can read updates and, with approval, act in them. Tokens never reach
// the model: Kordi's server (or the owner's device) runs each tool call and only
// the results reach the agent. This file mirrors the desktop model in
// app/desktop/src/features/connectors/connectorsModel.ts; keep ids, labels, and
// helper semantics identical so both clients describe the same contract.

enum ConnectorProviderId: String, Codable, CaseIterable, Hashable, Sendable {
    case googleCalendar = "google_calendar"
    case gmail
    case github
    case slack
    case outlook
    case macCalendar = "mac_calendar"
    case macContacts = "mac_contacts"
    case macNotificationCenter = "mac_notification_center"
}

enum ConnectorKind: String, Codable, Sendable {
    case service
    case macLocal = "mac_local"
}

enum ConnectorToolGroup: String, Codable, Sendable {
    case read
    case act
}

struct ConnectorScope: Codable, Equatable, Hashable, Identifiable, Sendable {
    let id: String
    let label: String
    let group: ConnectorToolGroup
}

enum ConnectorAvailability: String, Codable, Sendable {
    case available
    case comingLater = "coming_later"
}

struct ConnectorDefinition: Equatable, Identifiable, Sendable {
    let providerId: ConnectorProviderId
    let kind: ConnectorKind
    let name: String
    /// The company that handles the sign-in, for example "Google".
    let providerName: String
    let summary: String
    let readScopes: [ConnectorScope]
    let actScopes: [ConnectorScope]
    let actDescription: String
    let availability: ConnectorAvailability
    var experimental: Bool = false
    var requiresFullDiskAccess: Bool = false

    var id: ConnectorProviderId { providerId }
}

enum ConnectorStatus: String, Codable, Sendable {
    case notConnected = "not_connected"
    case connected
    case needsReauth = "needs_reauth"
    case permissionMissing = "permission_missing"
}

struct ConnectorState: Codable, Equatable, Sendable {
    var providerId: ConnectorProviderId
    var status: ConnectorStatus
    /// ISO 8601 timestamp, matching the desktop and server wire format.
    var connectedAt: String?
    var grantedScopeIds: [String]
    var actEnabled: Bool
    var agentIds: [String]
    /// ISO 8601 timestamp of the newest event received from the provider.
    var lastEventAt: String?

    static func empty(_ providerId: ConnectorProviderId) -> ConnectorState {
        ConnectorState(
            providerId: providerId,
            status: .notConnected,
            connectedAt: nil,
            grantedScopeIds: [],
            actEnabled: false,
            agentIds: [],
            lastEventAt: nil
        )
    }
}

struct ConnectorAgent: Codable, Equatable, Identifiable, Sendable {
    let agentId: String
    let name: String
    let isDefault: Bool

    var id: String { agentId }
}

enum ConnectorAuditOutcome: String, Codable, Sendable {
    case completed
    case approved
    case denied
    case blockedBackground = "blocked_background"
    /// The provider call failed. Reported by the server's audit log.
    case failed

    var label: String {
        switch self {
        case .completed: "Completed"
        case .approved: "Approved by you"
        case .denied: "Denied by you"
        case .blockedBackground: "Background run, read only"
        case .failed: "Failed"
        }
    }
}

struct ConnectorAuditEntry: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let providerId: ConnectorProviderId
    /// ISO 8601 timestamp.
    let at: String
    let agentName: String
    let tool: String
    let group: ConnectorToolGroup
    let outcome: ConnectorAuditOutcome
    let summary: String
}

private func read(_ id: String, _ label: String) -> ConnectorScope {
    ConnectorScope(id: id, label: label, group: .read)
}

private func act(_ id: String, _ label: String) -> ConnectorScope {
    ConnectorScope(id: id, label: label, group: .act)
}

let connectorCatalog: [ConnectorDefinition] = [
    ConnectorDefinition(
        providerId: .googleCalendar,
        kind: .service,
        name: "Google Calendar",
        providerName: "Google",
        summary: "Upcoming events, invitations, and free time.",
        readScopes: [
            read("google_calendar.events.read", "Read your events and invitations"),
            read("google_calendar.freebusy.read", "See when you are free"),
        ],
        actScopes: [
            act("google_calendar.invitations.reply", "Reply to invitations"),
            act("google_calendar.events.write", "Create and change events"),
        ],
        actDescription: "Your agent can reply to invitations and create or change events.",
        availability: .available
    ),
    ConnectorDefinition(
        providerId: .gmail,
        kind: .service,
        name: "Gmail",
        providerName: "Google",
        summary: "Mail that needs your attention.",
        readScopes: [
            read("gmail.messages.read", "Search and read your mail"),
            read("gmail.labels.read", "Read labels"),
        ],
        actScopes: [
            act("gmail.messages.send", "Send mail as you"),
        ],
        actDescription: "Your agent can send mail as you.",
        availability: .available
    ),
    ConnectorDefinition(
        providerId: .github,
        kind: .service,
        name: "GitHub",
        providerName: "GitHub",
        summary: "Notifications, reviews, and pull request state.",
        readScopes: [
            read("github.notifications.read", "Notifications"),
            read("github.pulls.read", "Pull request state and reviews"),
        ],
        actScopes: [
            act("github.comments.write", "Comment on issues and pull requests"),
        ],
        actDescription: "Your agent can comment on issues and pull requests. GitHub grants this as write access to all your private repositories.",
        availability: .available
    ),
    ConnectorDefinition(
        providerId: .slack,
        kind: .service,
        name: "Slack",
        providerName: "Slack",
        summary: "Messages in the channels you choose.",
        readScopes: [
            read("slack.channels.read", "Channels you choose"),
        ],
        actScopes: [
            act("slack.messages.write", "Post messages as you"),
        ],
        actDescription: "Your agent can post messages as you.",
        availability: .available
    ),
    ConnectorDefinition(
        providerId: .outlook,
        kind: .service,
        name: "Outlook",
        providerName: "Microsoft",
        summary: "Microsoft 365 mail and calendar.",
        readScopes: [
            read("outlook.mail.read", "Search and read your mail"),
            read("outlook.calendar.read", "Read your events"),
        ],
        actScopes: [],
        actDescription: "",
        availability: .comingLater
    ),
    ConnectorDefinition(
        providerId: .macCalendar,
        kind: .macLocal,
        name: "Calendar and Reminders",
        providerName: "macOS",
        summary: "Calendars and reminders on this Mac.",
        readScopes: [
            read("mac_calendar.events.read", "Read calendars on this Mac"),
            read("mac_calendar.reminders.read", "Read reminders"),
        ],
        actScopes: [
            act("mac_calendar.reminders.write", "Create reminders"),
        ],
        actDescription: "Your agent can create reminders on this Mac.",
        availability: .available
    ),
    ConnectorDefinition(
        providerId: .macContacts,
        kind: .macLocal,
        name: "Contacts",
        providerName: "macOS",
        summary: "Names and details of people you know.",
        readScopes: [
            read("mac_contacts.read", "Read names, emails, and phone numbers"),
        ],
        actScopes: [],
        actDescription: "",
        availability: .available
    ),
    ConnectorDefinition(
        providerId: .macNotificationCenter,
        kind: .macLocal,
        name: "Notification Center",
        providerName: "macOS",
        summary: "Recent notifications on this Mac.",
        readScopes: [
            read("mac_notification_center.read", "Recent notifications on this Mac (bounded window)"),
        ],
        actScopes: [],
        actDescription: "",
        availability: .available,
        experimental: true,
        requiresFullDiskAccess: true
    ),
]

enum ConnectorsModel {
    static func definition(_ providerId: ConnectorProviderId) -> ConnectorDefinition {
        // The catalog lists every case, so this lookup always succeeds.
        connectorCatalog.first { $0.providerId == providerId }!
    }

    /// The connectors the iPhone settings screen lists. iOS offers no API for
    /// reading other apps' notifications, so Notification Center stays in the
    /// shared catalog for parity with the desktop but is never shown here.
    /// Calendar and Contacts use EventKit and Contacts on the iPhone, so their
    /// copy says "this iPhone" instead of "this Mac"; ids stay the same.
    static var iPhoneCatalog: [ConnectorDefinition] {
        connectorCatalog
            .filter { $0.providerId != .macNotificationCenter }
            .map { definition in
                guard definition.kind == .macLocal else { return definition }
                return ConnectorDefinition(
                    providerId: definition.providerId,
                    kind: definition.kind,
                    name: definition.name,
                    providerName: "iOS",
                    summary: onThisIPhone(definition.summary),
                    readScopes: definition.readScopes.map { ConnectorScope(id: $0.id, label: onThisIPhone($0.label), group: $0.group) },
                    actScopes: definition.actScopes.map { ConnectorScope(id: $0.id, label: onThisIPhone($0.label), group: $0.group) },
                    actDescription: onThisIPhone(definition.actDescription),
                    availability: definition.availability,
                    experimental: definition.experimental,
                    requiresFullDiskAccess: definition.requiresFullDiskAccess
                )
            }
    }

    private static func onThisIPhone(_ text: String) -> String {
        text.replacingOccurrences(of: "this Mac", with: "this iPhone")
    }

    /// Tool groups a single run may receive. Background runs only ever read.
    static func toolGroupsForRun(state: ConnectorState, startedByPerson: Bool) -> [ConnectorToolGroup] {
        guard state.status == .connected else { return [] }
        if !state.actEnabled || !startedByPerson { return [.read] }
        return [.read, .act]
    }

    static func hasGrantedActScopes(definition: ConnectorDefinition, state: ConnectorState) -> Bool {
        !definition.actScopes.isEmpty
            && definition.actScopes.allSatisfy { state.grantedScopeIds.contains($0.id) }
    }

    static func disconnectConsequences(_ definition: ConnectorDefinition) -> [String] {
        [
            "Kordi removes the sign-in token for \(definition.name).",
            "Stored events from \(definition.name) are deleted.",
            "Copies your agent made from them are queued for removal. Lessons your agent already saved are managed under Memory.",
        ]
    }

    private static func agentCountLabel(state: ConnectorState, agents: [ConnectorAgent]) -> String {
        let granted = agents.filter { state.agentIds.contains($0.agentId) }.count
        if !agents.isEmpty && granted == agents.count { return "All agents" }
        if granted == 0 { return "No agents" }
        return granted == 1 ? "1 agent" : "\(granted) agents"
    }

    private static func unavailableLabel(definition: ConnectorDefinition, state: ConnectorState?) -> String? {
        if definition.availability == .comingLater { return nil }
        switch state?.status ?? .notConnected {
        case .needsReauth: return "Sign in again"
        case .permissionMissing: return definition.requiresFullDiskAccess ? "Needs Full Disk Access" : "Needs permission"
        case .notConnected: return "Not connected"
        case .connected: return nil
        }
    }

    static func statusLabel(definition: ConnectorDefinition, state: ConnectorState?, agents: [ConnectorAgent]) -> String {
        if definition.availability == .comingLater { return "Not yet available" }
        if let label = unavailableLabel(definition: definition, state: state) { return label }
        guard let state else { return "Not connected" }
        let access = state.actEnabled ? "Can act" : "Read only"
        return ["Connected", access, agentCountLabel(state: state, agents: agents)].joined(separator: " · ")
    }

    /// Short status value for the connector list; the detail view adds agent grants.
    static func listValue(definition: ConnectorDefinition, state: ConnectorState?) -> String {
        if definition.availability == .comingLater { return "Coming later" }
        if let label = unavailableLabel(definition: definition, state: state) { return label }
        guard let state else { return "Not connected" }
        return state.actEnabled ? "Connected · Can act" : "Connected · Read only"
    }

    static func systemImage(_ providerId: ConnectorProviderId) -> String {
        switch providerId {
        case .googleCalendar: "calendar"
        case .gmail: "envelope"
        case .github: "arrow.triangle.branch"
        case .slack: "number"
        case .outlook: "envelope"
        case .macCalendar: "calendar.badge.clock"
        case .macContacts: "person.crop.circle"
        case .macNotificationCenter: "bell.badge"
        }
    }
}

/// Decides whether the Connectors settings row exists. The server announces
/// support with `connectorsVersion` in `/v1/cloud/auth/capabilities`, which the
/// app model fetches on sign-in and on foreground; the debug
/// `--preview-connectors` launch argument shows the row with sample data.
enum ConnectorsAvailability {
    static let previewArgument = "--preview-connectors"

    static func isPreviewRequested(arguments: [String] = ProcessInfo.processInfo.arguments) -> Bool {
#if DEBUG
        arguments.contains(previewArgument)
#else
        false
#endif
    }

    static let previewDetailPrefix = "--preview-connector-detail="

    /// Debug-only: the connector whose detail `--preview-connector-detail=<providerId>` opens.
    static func previewDetailProviderId(arguments: [String] = ProcessInfo.processInfo.arguments) -> ConnectorProviderId? {
#if DEBUG
        guard isPreviewRequested(arguments: arguments),
              let argument = arguments.first(where: { $0.hasPrefix(previewDetailPrefix) }) else { return nil }
        return ConnectorProviderId(rawValue: String(argument.dropFirst(previewDetailPrefix.count)))
#else
        nil
#endif
    }

    static func isAvailable(
        arguments: [String] = ProcessInfo.processInfo.arguments,
        connectorsVersion: Int? = nil
    ) -> Bool {
        isPreviewRequested(arguments: arguments) || connectorsVersion != nil
    }

    /// The client for this build, or nil to hide the section: the sample
    /// client for the preview argument, otherwise the server client once the
    /// server reports `connectorsVersion`.
    @MainActor
    static func makeClient(
        arguments: [String] = ProcessInfo.processInfo.arguments,
        connectorsVersion: Int? = nil,
        cloudClient: () -> (any ConnectorsClient)? = { nil }
    ) -> (any ConnectorsClient)? {
        if isPreviewRequested(arguments: arguments) { return PreviewConnectorsClient() }
        return connectorsVersion == nil ? nil : cloudClient()
    }
}
