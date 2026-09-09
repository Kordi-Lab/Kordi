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
