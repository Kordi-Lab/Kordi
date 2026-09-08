import SwiftUI

enum AgentSubsessionLoadFailure: Equatable {
    case timedOut, inaccessible, unavailable

    init(error: Error) {
        if (error as? URLError)?.code == .timedOut {
            self = .timedOut
        } else if let error = error as? CloudAPIError, [401, 403, 404].contains(error.statusCode) {
            self = .inaccessible
        } else {
            self = .unavailable
        }
    }

    var message: String {
        switch self {
        case .timedOut: "The connection timed out. Check your connection and try again."
        case .inaccessible: "This task is unavailable or you no longer have access."
        case .unavailable: "Could not connect. Your task may still be running. Try again."
        }
    }
}

struct AgentSubsessionView: View {
    @EnvironmentObject private var model: AppModel
    let sessionId: String
    @State private var loadFailure: AgentSubsessionLoadFailure?
    @State private var retry = 0

    var body: some View {
        Group {
            if let snapshot = model.subsessions[sessionId] {
                ConversationView(conversation: snapshot.conversation, allowsCompanionPanel: false)
                    .overlay(alignment: .top) {
                        VStack(spacing: 4) {
                            if snapshot.state == .failed {
                                Label("Task failed", systemImage: "exclamationmark.circle.fill")
                                    .foregroundStyle(.red)
                                    .padding(8).background(.regularMaterial)
                            }
                            if loadFailure != nil {
                                Button("Connection interrupted. Try again") { retry += 1 }
                                    .padding(8).background(.regularMaterial)
                            }
                        }
                    }
            } else if let loadFailure {
                ContentUnavailableView {
                    Label("Couldn't load messages", systemImage: "exclamationmark.circle")
                } description: {
                    Text(loadFailure.message)
                } actions: {
                    Button("Try again") { retry += 1 }
                }
            } else {
                ProgressView("Loading conversation…")
            }
        }
        .task(id: "\(sessionId):\(model.account?.accountId ?? ""):\(retry)") {
            loadFailure = nil
            while !Task.isCancelled {
                do {
                    _ = try await model.agentSubsession(id: sessionId, includeMessages: true)
                    try Task.checkCancellation()
                    loadFailure = nil
                } catch {
                    if Task.isCancelled || CloudTransportErrorPolicy.isCancellation(error) { return }
                    loadFailure = AgentSubsessionLoadFailure(error: error)
                }
                do { try await Task.sleep(for: .seconds(1.5)) }
                catch { return }
            }
        }
    }
}
