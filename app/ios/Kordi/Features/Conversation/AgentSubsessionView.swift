import SwiftUI

struct AgentSubsessionView: View {
    @EnvironmentObject private var model: AppModel
    let sessionId: String
    @State private var loadError = false
    @State private var retry = 0

    var body: some View {
        Group {
            if let snapshot = model.subsessions[sessionId] {
                ConversationView(conversation: snapshot.conversation, allowsCompanionPanel: false)
                    .overlay(alignment: .top) {
                        if loadError {
                            Button("Connection interrupted. Try again") { retry += 1 }
                                .padding(8).background(.regularMaterial)
                        }
                    }
            } else if loadError {
                ContentUnavailableView {
                    Label("Couldn't load messages", systemImage: "exclamationmark.circle")
                } description: {
                    Text("Check access or try again after synchronization.")
                } actions: {
                    Button("Try again") { retry += 1 }
                }
            } else {
                ProgressView("Loading conversation…")
            }
        }
        .task(id: "\(sessionId):\(model.account?.accountId ?? ""):\(retry)") {
            var failures = 0
            while !Task.isCancelled {
                do {
                    _ = try await model.agentSubsession(id: sessionId, includeMessages: true)
                    try Task.checkCancellation()
                    loadError = false
                    failures = 0
                } catch {
                    if Task.isCancelled { return }
                    failures += 1
                    loadError = failures >= 3
                }
                do { try await Task.sleep(for: .seconds(1.5)) }
                catch { return }
            }
        }
    }
}
