import SwiftUI

/// The agent reply or PiP message "About this reply" describes.
struct AgentReplyDisclosureTarget: Identifiable, Hashable {
    let message: ChatMessage
    let isPip: Bool

    var id: String { message.id }
}

/// "About this reply": which agent wrote a reply, whose it is, who asked,
/// where it ran, and, for Kordi Cloud runs, the model.
struct AgentReplyDisclosureSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let target: AgentReplyDisclosureTarget
    let conversation: ConversationSummary

    @State private var load: AgentReplyDisclosureLoad?
    @State private var attempt = 0

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Label(AgentReplyDisclosurePresentation.heading, systemImage: "sparkles")
                        .font(.headline)
                        .accessibilityAddTraits(.isHeader)
                }
                Section {
                    content
                } footer: {
                    if !target.isPip {
                        Text(AgentReplyDisclosurePresentation.footnote)
                    }
                }
            }
            .navigationTitle(AgentReplyDisclosurePresentation.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task(id: attempt) {
                if target.isPip {
                    await model.loadAIFeatures()
                    return
                }
                load = nil
                let result = await model.replyDisclosure(for: target.message, in: conversation)
                guard !Task.isCancelled else { return }
                load = result
            }
        }
        .presentationDetents([.medium, .large])
    }

    @ViewBuilder
    private var content: some View {
        if target.isPip {
            row(AgentReplyDisclosurePresentation.pipText(providerLabel: model.aiFeatures?.pipProviderLabel))
        } else {
            switch load {
            case nil:
                HStack(spacing: 10) {
                    ProgressView()
                    Text(AgentReplyDisclosurePresentation.loading).foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
            case .missing:
                row(AgentReplyDisclosurePresentation.missing)
            case .failed:
                row(AgentReplyDisclosurePresentation.failed)
                Button("Try Again") { attempt += 1 }
                    .frame(minHeight: 44)
            case .loaded(let disclosure):
                ForEach(
                    AgentReplyDisclosurePresentation.rows(
                        for: disclosure,
                        fallbackAgentName: target.message.authorName,
                        fallbackOwnerName: target.message.senderOwnerName
                    ),
                    id: \.self
                ) { line in
                    row(line)
                }
            }
        }
    }

    private func row(_ text: String) -> some View {
        Text(text)
            .fixedSize(horizontal: false, vertical: true)
            .frame(minHeight: 32, alignment: .leading)
    }
}

/// Conversation-level hooks: reload what is waiting for this person when the
/// chat opens, and present "About this reply".
struct ConversationAgentTrustModifier: ViewModifier {
    @EnvironmentObject private var model: AppModel
    let conversation: ConversationSummary
    let showsPendingActions: Bool
    @Binding var presentedDisclosure: AgentReplyDisclosureTarget?

    private var refreshID: String {
        "agent-actions:\(conversation.sessionId):\(model.account?.accountId ?? "")"
    }

    func body(content: Content) -> some View {
        content
            .task(id: refreshID) {
                guard showsPendingActions else { return }
                await model.refreshPendingAgentActions(sessionId: conversation.sessionId)
            }
            .sheet(item: $presentedDisclosure) { target in
                AgentReplyDisclosureSheet(target: target, conversation: conversation)
            }
    }
}

/// The "AI" mark before an agent's owner. The text and the spoken name are
/// always present, so the mark never relies on color.
struct AgentAIChip: View {
    let action: (() -> Void)?

    private var chip: some View {
        Text(AgentMessageLabels.chipText)
            .font(.caption2.weight(.bold))
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .foregroundStyle(KordiTheme.agentViolet)
            .background(KordiTheme.agentViolet.opacity(0.14), in: Capsule())
            .overlay(Capsule().stroke(KordiTheme.agentViolet.opacity(0.35), lineWidth: 0.5))
    }

    var body: some View {
        if let action {
            Button(action: action) {
                chip
                    // A 44 pt touch target that does not change the row's layout.
                    .padding(.vertical, 12)
                    .padding(.horizontal, 10)
                    .contentShape(Rectangle())
                    .padding(.vertical, -12)
                    .padding(.horizontal, -10)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(AgentMessageLabels.chipAccessibilityLabel)
            .accessibilityHint("Shows who runs this agent and where the reply ran")
        } else {
            chip.accessibilityLabel("AI agent")
        }
    }
}

/// PiP's tag, which also opens "About this reply".
struct PipIdentityTag: View {
    let action: (() -> Void)?

    private var tag: some View {
        Text(KordiPipIdentity.tag)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color(red: 0.941, green: 0.706, blue: 0.161).opacity(0.18), in: Capsule())
            .foregroundStyle(Color(red: 0.353, green: 0.239, blue: 0.0))
    }

    var body: some View {
        if let action {
            Button(action: action) {
                tag
                    .padding(.vertical, 12)
                    .contentShape(Rectangle())
                    .padding(.vertical, -12)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(KordiPipIdentity.tag), about this reply")
        } else {
            tag
        }
    }
}
