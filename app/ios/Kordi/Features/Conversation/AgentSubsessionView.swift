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
                    .toolbar {
                        if snapshot.canStop(accountId: model.account?.accountId) {
                            ToolbarItem(placement: .topBarTrailing) {
                                AgentSubsessionStopButton(snapshot: snapshot)
                                    .labelStyle(.iconOnly)
                            }
                        }
                    }
                    .safeAreaInset(edge: .top, spacing: 0) {
                        if loadFailure != nil {
                            HStack(spacing: 12) {
                                Label("Connection interrupted", systemImage: "wifi.exclamationmark")
                                    .foregroundStyle(.secondary)
                                Spacer(minLength: 0)
                                Button("Retry") { retry += 1 }
                                    .frame(minHeight: 44)
                            }
                            .font(.footnote)
                            .padding(.horizontal, 16)
                            .fixedSize(horizontal: false, vertical: true)
                            .background(Color(uiColor: .secondarySystemBackground))
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
