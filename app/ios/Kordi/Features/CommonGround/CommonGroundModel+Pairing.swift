import Foundation

/// One-to-one pairing: your code for the card on top of the wallet, and
/// redeeming someone else's code with that same card.
extension CommonGroundModel {
    /// The card a pairing shares: the selected one in the wallet; nil
    /// before profiles, which the server reads as the default.
    var pairingProfileID: String? { activeProfileID }

    /// A fresh code, or the line to show instead.
    func newPairCode() async -> Result<CommonGroundPairCode, CommonGroundPairError> {
        let profileId = pairingProfileID
        do {
            return .success(try await call { try await $0.newCommonGroundPairCode(token: $1, profileId: profileId) })
        } catch {
            return .failure(Self.pairError(error))
        }
    }

    /// Redeems the other person's code. Your own code is refused here; the
    /// server refuses another device of your account.
    func redeemPairCode(_ code: String, ownCode: String? = nil) async -> CommonGroundRedeemOutcome {
        if CommonGroundPairCodeText.same(code, ownCode) { return .failed(CommonGroundPairCopy.yourself) }
        let profileId = pairingProfileID
        do {
            let card = try await call { try await $0.redeemCommonGroundPairCode(token: $1, code: code, profileId: profileId) }
            if card.person.accountId == me.accountId { return .failed(CommonGroundPairCopy.yourself) }
            remember(card, profileId: profileId)
            return .paired(card)
        } catch let error as CloudAPIError where error.code == "common_ground_code_not_found" {
            return .codeGone
        } catch {
            return .failed(Self.pairError(error).message)
        }
    }

    /// Keeps a paired person's card so their match opens through the
    /// shared card, and refreshes Recent.
    func remember(_ card: CommonGroundPersonCard, profileId: String?) {
        let id = card.person.accountId
        view(id, through: card.profileId ?? profileId)
        people[id] = card
        matches[id] = nil
        Task {
            if let response = try? await call({ try await $0.commonGroundRecent(token: $1) }) { applyRecent(response.people) }
        }
    }

    static func pairError(_ error: Error) -> CommonGroundPairError {
        if let error = error as? CloudAPIError {
            switch error.code {
            case "common_ground_no_card": return .noCard
            case "common_ground_sharing_off": return .sharingOff
            case "common_ground_code_not_found": return .other(CommonGroundPairCopy.expired)
            default: break
            }
        }
        return .other(message(for: error) ?? "")
    }
}

/// Why a code could not be made or used.
enum CommonGroundPairError: Error, Equatable {
    /// Opens the first-run flow.
    case noCard
    /// Asks to turn sharing back on.
    case sharingOff
    case other(String)

    @MainActor var message: String {
        switch self {
        case .noCard: CommonGroundModel.messages["common_ground_no_card"] ?? ""
        case .sharingOff: CommonGroundModel.messages["common_ground_sharing_off"] ?? ""
        case .other(let message): message
        }
    }
}
