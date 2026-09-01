import Foundation
import UIKit
import UserNotifications

struct KordiMessageNotificationRoute: Hashable {
    let conversation: ConversationSummary
    let messageID: String
}

enum KordiNotificationAuthorizationState: String, Equatable {
    case notDetermined
    case denied
    case authorized
    case provisional
    case ephemeral

    init(_ status: UNAuthorizationStatus) {
        switch status {
        case .notDetermined: self = .notDetermined
        case .denied: self = .denied
        case .authorized: self = .authorized
        case .provisional: self = .provisional
        case .ephemeral: self = .ephemeral
        @unknown default: self = .notDetermined
        }
    }

    var canRegisterForRemoteNotifications: Bool {
        switch self {
        case .authorized, .provisional, .ephemeral: true
        case .notDetermined, .denied: false
        }
    }
}

func shouldAutomaticallyRequestNotificationAuthorization(
    accountAvailable: Bool,
    state: KordiNotificationAuthorizationState
) -> Bool {
    accountAvailable && state == .notDetermined
}

enum KordiMessageNotificationPreference {
    case messages
    case sound
    case previews
    case badge
}

@MainActor
final class KordiNotificationCoordinator: ObservableObject {
    static let messageCategory = "KORDI_MESSAGE"

    private enum PreferenceKey {
        static let messages = "kordi.notifications.messages"
        static let sound = "kordi.notifications.sound"
        static let previews = "kordi.notifications.previews"
        static let badge = "kordi.notifications.badge"
    }

    @Published private(set) var authorizationState: KordiNotificationAuthorizationState = .notDetermined
    @Published private(set) var pendingMessageRoute: KordiMessageNotificationRoute?
    @Published private(set) var messagesEnabled: Bool
    @Published private(set) var soundEnabled: Bool
    @Published private(set) var previewsEnabled: Bool
    @Published private(set) var badgeEnabled: Bool

    private weak var model: AppModel?
    private var pendingNotificationPayload: [AnyHashable: Any]?
    private var latestPushToken: String?
    private var authorizationRequestInFlight = false
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        messagesEnabled = defaults.object(forKey: PreferenceKey.messages) as? Bool ?? true
        soundEnabled = defaults.object(forKey: PreferenceKey.sound) as? Bool ?? true
        previewsEnabled = defaults.object(forKey: PreferenceKey.previews) as? Bool ?? true
        badgeEnabled = defaults.object(forKey: PreferenceKey.badge) as? Bool ?? true
    }

    func configure(model: AppModel) {
        self.model = model
        registerCategories()
        Task { await refreshAuthorizationState(registerIfAllowed: true) }
    }

    func accountDidChange() {
        guard model?.account != nil else {
            pendingMessageRoute = nil
            Task { await setBadgeCount(0) }
            return
        }
        requestAuthorizationIfNeeded()
        registerCurrentPushToken()
        routePendingNotificationIfPossible()
    }

    private func requestAuthorizationIfNeeded() {
        guard !authorizationRequestInFlight else { return }
        authorizationRequestInFlight = true
        Task { [weak self] in
            guard let self else { return }
            defer { authorizationRequestInFlight = false }
            await refreshAuthorizationState(registerIfAllowed: true)
            guard shouldAutomaticallyRequestNotificationAuthorization(
                accountAvailable: model?.account != nil,
                state: authorizationState
            ) else { return }
            await requestAuthorization()
        }
    }

    func requestAuthorization() async {
        let center = UNUserNotificationCenter.current()
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
        await refreshAuthorizationState(registerIfAllowed: true)
        synchronizeBadge()
        registerCurrentPushToken()
    }

    func openSystemSettings() {
        guard let url = URL(string: UIApplication.openNotificationSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    func refreshAuthorizationState(registerIfAllowed: Bool = false) async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        let state = KordiNotificationAuthorizationState(settings.authorizationStatus)
        authorizationState = state
        if registerIfAllowed, state.canRegisterForRemoteNotifications, model?.account != nil {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    func registerPushToken(_ token: String) {
        latestPushToken = token
        registerCurrentPushToken()
    }

    func setPreference(_ preference: KordiMessageNotificationPreference, enabled: Bool) {
        switch preference {
        case .messages:
            messagesEnabled = enabled
            defaults.set(enabled, forKey: PreferenceKey.messages)
        case .sound:
            soundEnabled = enabled
            defaults.set(enabled, forKey: PreferenceKey.sound)
        case .previews:
            previewsEnabled = enabled
            defaults.set(enabled, forKey: PreferenceKey.previews)
        case .badge:
            badgeEnabled = enabled
            defaults.set(enabled, forKey: PreferenceKey.badge)
        }
        synchronizeBadge()
        registerCurrentPushToken()
    }

    func synchronizeBadge() {
        let count = badgeEnabled
            ? MainTabUnreadCounts.build(
                conversations: model?.conversations ?? [],
                mutedSessionIds: model?.mutedSessionIds ?? []
            ).total
            : 0
        Task { await setBadgeCount(count) }
    }

    func presentationOptions(for notification: UNNotification) -> UNNotificationPresentationOptions {
        guard let payload = KordiMessageNotificationPayload(notification.request.content.userInfo) else {
            return [.banner, .sound, .badge]
        }
        guard payload.accountID == model?.account?.accountId else {
            return []
        }
        guard messagesEnabled else { return [] }
        if model?.isConversationActivelyReadable(canonicalConversationID: payload.sessionID) == true {
            synchronizeBadge()
            return []
        }
        var options: UNNotificationPresentationOptions = [.banner]
        if soundEnabled { options.insert(.sound) }
        if badgeEnabled { options.insert(.badge) }
        return options
    }

    func handleNotificationResponse(_ notification: UNNotification) {
        pendingNotificationPayload = notification.request.content.userInfo
        routePendingNotificationIfPossible()
    }

    func handleColdLaunchPayload(_ payload: [AnyHashable: Any]) {
        pendingNotificationPayload = payload
        routePendingNotificationIfPossible()
    }

    func consumePendingRoute() {
        pendingMessageRoute = nil
    }

    func retryPendingRoute() {
        routePendingNotificationIfPossible()
    }

    private func routePendingNotificationIfPossible() {
        guard let pendingNotificationPayload,
              let payload = KordiMessageNotificationPayload(pendingNotificationPayload),
              payload.accountID == model?.account?.accountId,
              let conversation = model?.conversationForNotification(
                canonicalConversationID: payload.sessionID
              ) else {
            return
        }
        self.pendingNotificationPayload = nil
        pendingMessageRoute = KordiMessageNotificationRoute(
            conversation: conversation,
            messageID: payload.messageID
        )
    }

    private func registerCategories() {
        let category = UNNotificationCategory(
            identifier: Self.messageCategory,
            actions: [],
            intentIdentifiers: [],
            options: []
        )
        UNUserNotificationCenter.current().setNotificationCategories([category])
    }

    private func registerCurrentPushToken() {
        guard let latestPushToken, let model else { return }
        let messagesEnabled = messagesEnabled
        let soundEnabled = soundEnabled
        let previewsEnabled = previewsEnabled
        let badgeEnabled = badgeEnabled
        Task {
            await model.registerNotificationPushToken(
                latestPushToken,
                messagesEnabled: messagesEnabled,
                soundEnabled: soundEnabled,
                previewsEnabled: previewsEnabled,
                badgeEnabled: badgeEnabled
            )
        }
    }

    private func setBadgeCount(_ count: Int) async {
        try? await UNUserNotificationCenter.current().setBadgeCount(max(0, count))
    }
}

private struct KordiMessageNotificationPayload {
    let accountID: String
    let sessionID: String
    let messageID: String

    init?(_ payload: [AnyHashable: Any]) {
        guard payload["notification_type"] as? String == "message",
              let accountID = payload["account_id"] as? String,
              let sessionID = payload["session_id"] as? String,
              let messageID = payload["message_id"] as? String,
              !accountID.isEmpty,
              !sessionID.isEmpty,
              !messageID.isEmpty else {
            return nil
        }
        self.accountID = accountID
        self.sessionID = sessionID
        self.messageID = messageID
    }
}
