import Foundation

@MainActor
final class CloudPresencePublisher {
    private let api: CloudAPIClient
    private let heartbeatInterval: Duration
    private var token: String?
    private var task: Task<Void, Never>?

    init(api: CloudAPIClient, heartbeatInterval: Duration = .seconds(10)) {
        self.api = api
        self.heartbeatInterval = heartbeatInterval
    }

    deinit {
        task?.cancel()
    }

    func start(token: String) {
        guard task == nil || self.token != token else { return }
        stop()
        self.token = token
        task = Task { [api, heartbeatInterval] in
            try? await api.publishPresenceOnline(token: token)
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: heartbeatInterval)
                } catch {
                    return
                }
                guard !Task.isCancelled else { return }
                try? await api.publishPresenceHeartbeat(token: token)
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
        token = nil
    }

    func stopAndPublishOffline(token: String) async {
        let activeTask = task
        stop()
        await activeTask?.value
        try? await api.publishPresenceOffline(token: token)
    }
}
