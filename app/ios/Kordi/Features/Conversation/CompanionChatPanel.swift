import SwiftUI

struct CompanionChatContext: Equatable {
    let sourceConversationID: String
    let sourceSessionID: String
    let sourceName: String
    let referenceText: String
}

enum CompanionChatContextBuilder {
    static func make(
        source: ConversationSummary,
        messages: [ChatMessage],
        selfName: String,
        recentMessageLimit: Int = 6
    ) -> CompanionChatContext {
        let recentMessages = messages
            .compactMap(referenceLine)
            .suffix(max(1, recentMessageLimit))
        let participants = participantNames(source: source, selfName: selfName)
        let typeLabel = switch source.kind {
        case .person: "direct chat"
        case .agent: "agent chat"
        case .group: "group chat"
        }
        let lines = [
            "Reference: Current chat",
            "Session: \(source.displayName)",
            "Session id: \(source.sessionId)",
            "Type: \(typeLabel)",
            participants.isEmpty ? nil : "Participants: \(participants.joined(separator: ", "))",
            recentMessages.isEmpty ? nil : "Recent messages:",
        ]
        .compactMap { $0 }
            + recentMessages.map { "- \($0)" }

        return CompanionChatContext(
            sourceConversationID: source.id,
            sourceSessionID: source.sessionId,
            sourceName: source.displayName,
            referenceText: lines.joined(separator: "\n")
        )
    }

    private static func referenceLine(_ message: ChatMessage) -> String? {
        let normalized = message.text
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
        let content: String
        if let text = normalized.nonEmpty {
            content = text.count > 240
                ? String(text.prefix(239)).trimmingCharacters(in: .whitespacesAndNewlines) + "…"
                : text
        } else if !message.attachments.isEmpty {
            content = message.attachments.count == 1
                ? "Shared an attachment"
                : "Shared \(message.attachments.count) attachments"
        } else {
            return nil
        }
        let sender = message.author == .me ? "Me" : message.authorName
        return "\(sender): \(content)"
    }

    private static func participantNames(
        source: ConversationSummary,
        selfName: String
    ) -> [String] {
        let peerNames: [String]
        if source.kind == .group {
            peerNames = source.groupParticipants.map(\.displayName)
        } else {
            peerNames = [source.displayName]
        }
        return ([selfName] + peerNames).reduce(into: []) { names, candidate in
            let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty,
                  !names.contains(where: {
                      $0.localizedCaseInsensitiveCompare(trimmed) == .orderedSame
                  }) else { return }
            names.append(trimmed)
        }
    }
}

enum CompanionPanelCatalog {
    static func sections(
        conversations: [ConversationSummary],
        ownAccountID: String
    ) -> [AgentSessionSection] {
        AgentSessionPresentationCatalog.build(
            conversations: conversations,
            ownAccountId: ownAccountID
        )
    }

    static func suggestedConversation(
        for source: ConversationSummary,
        conversations: [ConversationSummary],
        ownAccountID: String,
        randomID: String = UUID().uuidString.lowercased(),
        now: Date = Date()
    ) -> ConversationSummary? {
        let availableSections = sections(
            conversations: conversations,
            ownAccountID: ownAccountID
        )

        if source.kind == .agent,
           !source.representsKordiSupport,
           availableSections.contains(where: { section in
               section.agentId == source.agentId
                   && section.template.peerAccountId == source.peerAccountId
           }) {
            return AgentSessionFactory.make(
                from: source,
                ownAccountId: ownAccountID,
                randomId: randomID,
                now: now
            )
        }

        let existing = availableSections
            .flatMap(\.sessions)
            .filter { $0.id != source.id }
            .sorted {
                $0.lastActivityAt > $1.lastActivityAt || (
                    $0.lastActivityAt == $1.lastActivityAt
                        && $0.id < $1.id
                )
            }
            .first
        if let existing {
            return existing
        }

        if let template = availableSections.first?.template {
            return AgentSessionFactory.make(
                from: template,
                ownAccountId: ownAccountID,
                randomId: randomID,
                now: now
            )
        }
        return AgentSessionFactory.makeDefault(
            ownAccountId: ownAccountID,
            randomId: randomID,
            now: now
        )
    }

    static func existingSessions(
        excluding source: ConversationSummary,
        conversations: [ConversationSummary],
        ownAccountID: String
    ) -> [ConversationSummary] {
        sections(conversations: conversations, ownAccountID: ownAccountID)
            .flatMap(\.sessions)
            .filter { $0.id != source.id }
            .sorted {
                $0.lastActivityAt > $1.lastActivityAt || (
                    $0.lastActivityAt == $1.lastActivityAt && $0.id < $1.id
                )
            }
    }
}

struct CompanionChatPanel: View {
    @EnvironmentObject private var model: AppModel
    @Binding var isPresented: Bool
    @Binding var selectedConversation: ConversationSummary?

    let sourceConversation: ConversationSummary

    private var sourceContext: CompanionChatContext {
        CompanionChatContextBuilder.make(
            source: sourceConversation,
            messages: model.messages(for: sourceConversation),
            selfName: model.account?.preferredName ?? "Me"
        )
    }

    private var existingSessions: [ConversationSummary] {
        CompanionPanelCatalog.existingSessions(
            excluding: sourceConversation,
            conversations: model.conversations,
            ownAccountID: model.account?.accountId ?? ""
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            if let selectedConversation {
                CompanionPanelHeader(
                    conversation: selectedConversation,
                    sessions: existingSessions,
                    onNewSession: { createSession(from: selectedConversation) },
                    onSelectSession: { self.selectedConversation = $0 },
                    onClose: { isPresented = false }
                )

                CompanionContextStrip(sourceName: sourceConversation.displayName)

                ConversationView(
                    conversation: selectedConversation,
                    companionContext: sourceContext,
                    allowsCompanionPanel: false,
                    showsNavigationChrome: false
                )
                .id(selectedConversation.id)
            } else {
                ContentUnavailableView(
                    "No agent session",
                    systemImage: "sparkles",
                    description: Text("Choose an available agent session to continue.")
                )
            }
        }
        .background(Color(uiColor: .systemBackground))
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .inspectorColumnWidth(min: 320, ideal: 390, max: 480)
    }

    private func createSession(from conversation: ConversationSummary) {
        selectedConversation = model.makeAgentSession(from: conversation)
    }
}

private struct CompanionPanelHeader: View {
    let conversation: ConversationSummary
    let sessions: [ConversationSummary]
    let onNewSession: () -> Void
    let onSelectSession: (ConversationSummary) -> Void
    let onClose: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            IdentityAvatar(
                name: conversation.agentDisplayName?.nonEmpty ?? conversation.displayName,
                imageSource: conversation.avatarSource,
                kind: .agent,
                size: 32,
                seed: conversation.agentId?.nonEmpty ?? conversation.sessionId
            )

            VStack(alignment: .leading, spacing: 1) {
                Text("Ask Agent · \(conversation.displayName)")
                    .font(.headline)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Text("Agent session")
                    .font(.caption)
                    .foregroundStyle(KordiTheme.agentViolet)
                    .lineLimit(1)
            }

            Spacer(minLength: 6)

            Menu {
                Button(action: onNewSession) {
                    Label("New session", systemImage: "square.and.pencil")
                }

                Menu {
                    if sessions.isEmpty {
                        Text("No existing sessions")
                    } else {
                        ForEach(sessions) { session in
                            Button {
                                onSelectSession(session)
                            } label: {
                                Label(
                                    session.displayName,
                                    systemImage: session.id == conversation.id
                                        ? "checkmark"
                                        : "bubble.left"
                                )
                            }
                            .disabled(session.id == conversation.id)
                        }
                    }
                } label: {
                    Label("Switch session", systemImage: "bubble.left.and.bubble.right")
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.body.weight(.semibold))
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .contentShape(Rectangle())
            .accessibilityLabel("Switch Ask Agent session")
            .accessibilityValue(conversation.displayName)

            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.body.weight(.semibold))
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close Ask Agent")
        }
        .padding(.leading, 16)
        .padding(.trailing, 6)
        .padding(.vertical, 5)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
    }
}

private struct CompanionContextStrip: View {
    let sourceName: String

    var body: some View {
        Label {
            Text("Using \(sourceName) as context")
                .lineLimit(1)
        } icon: {
            Image(systemName: "link")
                .accessibilityHidden(true)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 16)
        .frame(maxWidth: .infinity, minHeight: 34, alignment: .leading)
        .background(Color(uiColor: .secondarySystemBackground))
        .accessibilityElement(children: .combine)
    }
}

#Preview("Ask Agent panel") {
    NavigationStack {
        ConversationView(
            conversation: PreviewData.make().conversations.first {
                $0.id == "person:acct_maya"
            }!
        )
    }
    .environmentObject(AppModel(previewMode: true))
    .tint(KordiTheme.signalBlue)
}
