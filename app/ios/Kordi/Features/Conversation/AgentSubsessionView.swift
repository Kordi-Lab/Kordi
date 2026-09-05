import SwiftUI

struct AgentSubsessionView: View {
    @EnvironmentObject private var model: AppModel
    let sessionId: String
    @State private var snapshot: CloudAgentSubsession?
    @State private var loadError = false
    @State private var retry = 0
    @State private var loadedAccountId: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if loadError {
                    ContentUnavailableView {
                        Label("Couldn't load this task", systemImage: "exclamationmark.circle")
                    } description: {
                        Text("Check access or try again after synchronization.")
                    } actions: {
                        Button("Try again") { retry += 1 }
                    }
                } else if let snapshot, loadedAccountId == model.account?.accountId {
                    Text("\(snapshot.agentDisplayName) · Owner · \(snapshot.ownerAccountId == model.account?.accountId ? "You" : snapshot.ownerDisplayName)")
                        .font(.caption).foregroundStyle(.secondary)
                    ForEach(snapshot.messages) { message in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(message.role == "user" ? "Task" : snapshot.agentDisplayName)
                                .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                            MarkdownMessageContent(text: message.text, allowsTextSelection: true)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    let symbol = switch snapshot.state {
                    case .running: "clock"
                    case .done: "checkmark.circle"
                    case .failed: "exclamationmark.circle"
                    case .stopped: "stop.circle"
                    }
                    Label(snapshot.state.label, systemImage: symbol)
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    ProgressView("Loading task…").frame(maxWidth: .infinity).padding(.top, 60)
                }
            }
            .padding(20)
        }
        .navigationTitle(loadedAccountId == model.account?.accountId ? snapshot?.title ?? "Agent task" : "Agent task")
        .navigationBarTitleDisplayMode(.inline)
        // Keep the existing iOS 17 deployment target.
        .toolbar(.visible, for: .navigationBar)
        .onChange(of: model.account?.accountId) { _, _ in
            snapshot = nil
            loadedAccountId = nil
            loadError = false
            retry += 1
        }
        .task(id: "\(sessionId):\(retry)") {
            var failures = 0
            while !Task.isCancelled {
                do {
                    var next = try await model.agentSubsession(id: sessionId, includeMessages: snapshot == nil)
                    if let current = snapshot {
                        if next.version != current.version { next = try await model.agentSubsession(id: sessionId, includeMessages: true) }
                        else { next.messages = current.messages }
                    }
                    try Task.checkCancellation()
                    if snapshot != next { snapshot = next }
                    loadedAccountId = model.account?.accountId
                    loadError = false
                    failures = 0
                } catch {
                    if Task.isCancelled { return }
                    failures += 1
                    if failures >= 3 { snapshot = nil; loadError = true; return }
                }
                do { try await Task.sleep(for: .seconds(snapshot?.state == .running || snapshot == nil ? 1.5 : 10)) }
                catch { return }
            }
        }
    }
}
