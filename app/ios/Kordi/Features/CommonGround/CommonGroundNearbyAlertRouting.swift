import SwiftUI

/// A Nearby alert push (`notification_type: "common_ground_nearby"`): someone
/// you can see through Nearby meets a request or is a good match.
struct CommonGroundNearbyAlertPayload: Equatable {
    let accountID: String
    let otherAccountID: String
    let alertID: String?

    init?(_ payload: [AnyHashable: Any]) {
        guard payload["notification_type"] as? String == "common_ground_nearby",
              let accountID = payload["account_id"] as? String, !accountID.isEmpty,
              let otherAccountID = payload["other_account_id"] as? String, !otherAccountID.isEmpty else { return nil }
        self.accountID = accountID
        self.otherAccountID = otherAccountID
        alertID = payload["alert_id"] as? String
    }
}

/// The nearby person a tapped alert opens. The main stack opens Grounding
/// (CommonGroundPairLinkRouting), and Grounding takes the person from here.
@MainActor
final class CommonGroundNearbyAlertInbox: ObservableObject {
    static let shared = CommonGroundNearbyAlertInbox()
    @Published var accountId: String?

    func take() -> String? {
        defer { accountId = nil }
        return accountId
    }
}

/// Inside Grounding: a tapped alert shows Nearby with the person on top,
/// so Back leads to the Nearby screen.
struct CommonGroundNearbyAlertOpening: ViewModifier {
    @ObservedObject private var inbox = CommonGroundNearbyAlertInbox.shared
    @Binding var path: [CommonGroundRoute]
    let enabled: Bool

    func body(content: Content) -> some View {
        content.task(id: enabled ? inbox.accountId : nil) {
            guard enabled, let accountId = inbox.take() else { return }
            path = [.nearby, .nearbyPerson(accountId)]
        }
    }
}
