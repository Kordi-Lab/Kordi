import SwiftUI

enum AgentSubsessionStopPreview {
    static func snapshot(accountId: String, now: Date = Date()) -> CloudAgentSubsession {
        let startedAtMs = Int64(now.addingTimeInterval(-40).timeIntervalSince1970 * 1000)
        return CloudAgentSubsession(sessionId: "preview-background-stop", parentSessionId: "preview-parent",
            parentRequestId: "preview-request", ownerAccountId: accountId, agentId: "preview-agent",
            ownerDisplayName: "Alex", agentDisplayName: "Kordi", title: "Review project issues",
            status: "running", version: 1, messages: [
                .init(id: "preview-brief", role: "user", text: "Review the project and report the remaining issues.", timestampMs: startedAtMs, senderAgentId: "preview-agent"),
                .init(id: "preview-progress", role: "assistant", text: "I’m checking the open issues and pending changes. I’ll keep the review read-only.", timestampMs: startedAtMs + 5000, senderAgentId: "preview-agent")
            ], updatedAt: ISO8601DateFormatter().string(from: now), live: true, startedAtMs: startedAtMs)
    }
}

struct AgentSubsessionStopPreviewView: View {
    @EnvironmentObject private var model: AppModel
    @State private var selected: BackgroundAgentSession?
    @State private var previewDate = Date()
    private var snapshot: CloudAgentSubsession {
        AgentSubsessionStopPreview.snapshot(accountId: model.account?.accountId ?? "acct_me", now: previewDate)
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 24) {
                Text("Stop preview").font(.title2.bold())
                Text("This sample task runs only in this preview. Tap Stop to try the control.")
                    .foregroundStyle(.secondary)
                if let session = BackgroundAgentSession(wire: .init(sessionId: snapshot.sessionId,
                    turnId: nil, title: snapshot.title, status: "running")) {
                    BackgroundAgentSessionRow(presentation: .init(session: session, state: .running),
                        agentName: snapshot.agentDisplayName, isEnabled: true) { selected = $0 }
                }
                if model.subsessions[snapshot.sessionId]?.state == .stopped {
                    Button("Restart sample task") { model.installSubsessionStopPreview(snapshot, reset: true) }
                }
                Spacer()
            }
            .padding()
            .task { model.installSubsessionStopPreview(snapshot) }
            .navigationDestination(item: $selected) { AgentSubsessionView(sessionId: $0.sessionId) }
        }
    }
}
