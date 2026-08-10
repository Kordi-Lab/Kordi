import Foundation

struct SessionRuntimeRouteStore {
    private let defaults: UserDefaults
    private let defaultsKey: String

    init(
        defaults: UserDefaults = .standard,
        defaultsKey: String = "kordi.session-runtime-routes"
    ) {
        self.defaults = defaults
        self.defaultsKey = defaultsKey
    }

    func route(accountId: String?, sessionId: String) -> CloudModelRouting? {
        routes()[routeKey(accountId: accountId, sessionId: sessionId)]
    }

    func save(_ route: CloudModelRouting, accountId: String?, sessionId: String) {
        var savedRoutes = routes()
        savedRoutes[routeKey(accountId: accountId, sessionId: sessionId)] = route
        guard let data = try? JSONEncoder().encode(savedRoutes) else { return }
        defaults.set(data, forKey: defaultsKey)
    }

    private func routes() -> [String: CloudModelRouting] {
        guard let data = defaults.data(forKey: defaultsKey),
              let routes = try? JSONDecoder().decode([String: CloudModelRouting].self, from: data) else {
            return [:]
        }
        return routes
    }

    private func routeKey(accountId: String?, sessionId: String) -> String {
        "\(accountId?.nonEmpty ?? "signed-out")\u{001F}\(sessionId)"
    }
}
