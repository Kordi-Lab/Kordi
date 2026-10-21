import Foundation

/// Offline profiles for `--preview-data` and tests. Synthetic people only.
enum ContactProfilePreviewData {
    static func profile(for subject: ContactProfileSubject, now: Date = Date()) -> CloudContactProfile {
        func iso(_ offset: TimeInterval) -> String {
            ISO8601DateFormatter().string(from: now.addingTimeInterval(offset))
        }
        switch subject.kind {
        case .system:
            return CloudContactProfile(
                accountId: subject.accountId,
                kordiId: subject.kordiId,
                displayName: subject.name,
                about: "Help with your account and the app.",
                kind: .system,
                isContact: true
            )
        case .agent:
            return CloudContactProfile(
                accountId: subject.accountId,
                kordiId: subject.kordiId,
                displayName: subject.name,
                kind: .agent,
                owner: .init(accountId: "acct_preview_owner", kordiId: "482731906", displayName: "Nadia", avatarUrl: nil),
                shared: .init(mediaCount: 6, linkCount: 2, documentCount: 5, groups: [])
            )
        case .person:
            guard subject.accountId == "acct_maya" else {
                return CloudContactProfile(
                    accountId: subject.accountId,
                    kordiId: subject.kordiId,
                    displayName: subject.name,
                    avatarUrl: subject.avatarUrl,
                    isContact: true,
                    presence: .init(status: .offline, lastSeenAt: iso(-3 * 86_400)),
                    contactSince: iso(-2 * 86_400),
                    shared: .init()
                )
            }
            return CloudContactProfile(
                accountId: subject.accountId,
                kordiId: subject.kordiId,
                displayName: subject.name,
                avatarUrl: subject.avatarUrl,
                about: "Robotics PhD. Building a tabletop manipulation lab.",
                isContact: true,
                presence: .init(status: .online, lastSeenAt: iso(-60)),
                defaultAgent: .init(agentId: "agent_preview_maya", displayName: "Maya's agent", avatarUrl: nil),
                contactSince: iso(-69 * 86_400),
                shared: .init(
                    mediaCount: 24,
                    linkCount: 9,
                    documentCount: 3,
                    groups: [
                        .init(groupId: "session:group:mobile", title: "Mobile builders", avatarUrl: nil),
                        .init(groupId: "group_preview_reading", title: "Reading group", avatarUrl: nil)
                    ]
                ),
                commonGround: .init(
                    workingOn: ["tabletop manipulation", "sim-to-real"],
                    canHelp: ["grant writing", "lab setup"],
                    lookingFor: ["robot datasets", "co-authors"]
                )
            )
        }
    }
}
