import SwiftUI

/// The small "Agent" tag next to an agent's name in a thread.
struct DocumentAgentTag: View {
    var body: some View {
        Text("Agent")
            .font(.caption2.weight(.medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color(uiColor: .tertiarySystemFill), in: Capsule())
    }
}

/// "<Agent> is working", under the comment that mentioned the agent.
struct DocumentAgentWorkingLine: View {
    let agentName: String

    var body: some View {
        HStack(spacing: 6) {
            ProgressView().controlSize(.mini)
            Text("\(agentName) is working")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

/// "Could not answer", with Retry when the viewer can post the mention again.
struct DocumentAgentFailedLine: View {
    let onRetry: (() -> Void)?

    var body: some View {
        HStack(spacing: 10) {
            Label("Could not answer", systemImage: "exclamationmark.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let onRetry {
                Button("Retry", action: onRetry)
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.plain)
                    .foregroundStyle(KordiTheme.signalBlue)
                    .frame(minHeight: 28)
                    .contentShape(Rectangle())
            }
        }
    }
}

/// One muted line without an avatar: a system reply or "Edited by <Agent>".
struct DocumentThreadNoticeLine: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// The quiet button that starts a reply asking the agent to edit.
struct DocumentAskAgentToEditButton: View {
    let agentName: String
    let action: () -> Void

    var body: some View {
        Button("Ask \(agentName) to edit", action: action)
            .font(.caption.weight(.medium))
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .frame(minHeight: 28)
            .contentShape(Rectangle())
    }
}
