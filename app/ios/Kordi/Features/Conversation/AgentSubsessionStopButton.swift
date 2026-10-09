import SwiftUI

struct AgentSubsessionStopButton: View {
    @EnvironmentObject private var model: AppModel
    let snapshot: CloudAgentSubsession
    @State private var failure: String?

    private var current: CloudAgentSubsession {
        if let saved = model.subsessions[snapshot.sessionId], saved.version >= snapshot.version { return saved }
        return snapshot
    }
    private var stopping: Bool { model.stoppingSubsessionIDs.contains(snapshot.sessionId) }

    var body: some View {
        if current.canStop(accountId: model.account?.accountId) {
            Button {
                Task {
                    do { try await model.stopAgentSubsession(current) }
                    catch {
                        if !CloudTransportErrorPolicy.isCancellation(error) {
                            failure = Self.failureMessage(error)
                        }
                    }
                }
            } label: {
                Label(stopping ? "Stopping…" : "Stop", systemImage: "stop.fill")
                    .font(.subheadline.weight(.semibold))
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .foregroundStyle(KordiTheme.signalBlue)
            .disabled(stopping)
            .accessibilityLabel("\(stopping ? "Stopping" : "Stop") background task: \(current.title)")
            .accessibilityHint("Stops this task and its queued follow-ups")
            .alert("Couldn't stop task", isPresented: Binding(
                get: { failure != nil }, set: { if !$0 { failure = nil } }
            )) {
                Button("OK", role: .cancel) { failure = nil }
            } message: { Text(failure ?? "") }
        }
    }

    static func failureMessage(_ error: Error) -> String {
        guard let error = error as? CloudAPIError else {
            return "Check your connection and try again. The task may still be running."
        }
        if error.statusCode == 409 { return "The task changed. Refresh it before trying Stop again." }
        if [401, 403].contains(error.statusCode) { return "Only the task owner can stop this task." }
        if error.statusCode == 404 { return "Stop is unavailable for this task or this server version. The task may still be running." }
        return "Could not stop this task. Try again."
    }
}

private struct AgentRequestStopButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.6 : 1)
    }
}

/// Stop for a running agent request this account sent. It appears only on the
/// request's processing row and asks the executor to stop through the server.
struct AgentRequestStopButton: View {
    @EnvironmentObject private var model: AppModel
    let conversationId: String
    let requestMessageId: String
    @State private var failure: String?

    private var stopping: Bool { model.stoppingAgentRequestIDs.contains(requestMessageId) }

    var body: some View {
        if model.canStopAgentRequest(conversationId: conversationId, requestMessageId: requestMessageId) {
            Button {
                Task {
                    do { try await model.stopAgentRequest(conversationId: conversationId, requestMessageId: requestMessageId) }
                    catch {
                        if !CloudTransportErrorPolicy.isCancellation(error) {
                            failure = Self.failureMessage(error)
                        }
                    }
                }
            } label: {
                ZStack {
                    Circle().fill(Color(uiColor: .tertiarySystemFill))
                    if stopping {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 11, weight: .regular))
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(width: 28, height: 28)
                .padding(8)
                .contentShape(.rect)
                .padding(-8)
            }
            .buttonStyle(AgentRequestStopButtonStyle())
            .disabled(stopping)
            .accessibilityLabel(stopping ? "Stopping" : "Stop")
            .alert("Couldn't stop request", isPresented: Binding(
                get: { failure != nil }, set: { if !$0 { failure = nil } }
            )) {
                Button("OK", role: .cancel) { failure = nil }
            } message: { Text(failure ?? "") }
        }
    }

    static func failureMessage(_ error: Error) -> String {
        guard let error = error as? CloudAPIError else {
            return "Check your connection and try again. The agent may still be running."
        }
        if error.statusCode == 409 { return "This request already finished." }
        if [401, 403].contains(error.statusCode) { return "Only the requester or the agent owner can stop this request." }
        if error.statusCode == 404 { return "Stop is unavailable for this request or this server version. The agent may still be running." }
        return "Could not stop this request. Try again."
    }
}
