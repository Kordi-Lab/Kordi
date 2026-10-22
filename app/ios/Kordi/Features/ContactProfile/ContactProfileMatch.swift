import Foundation

/// `commonGround.match` on the contact profile: the Grounding match between
/// you and this person. `score` is required; every other part is optional,
/// and one malformed topic drops only itself.
extension CloudContactProfile.CommonGround {
    struct Match: Decodable, Hashable {
        /// 0-100.
        var score: Int
        var headline: String? = nil
        /// At most 5 topics you both have.
        var shared: [CommonGroundReason] = []
        /// At most 3 of your topics that help them.
        var youBring: [CommonGroundTrade] = []
        /// At most 3 of their topics that help you.
        var theyBring: [CommonGroundTrade] = []
        var nextStep: String? = nil
        var yourProfile: CommonGroundProfileTag? = nil
        var theirProfile: CommonGroundProfileTag? = nil
        var updatedAt: String? = nil

        private enum CodingKeys: String, CodingKey {
            case score, headline, shared, youBring, theyBring, nextStep, yourProfile, theirProfile, updatedAt
        }

        init(
            score: Int,
            headline: String? = nil,
            shared: [CommonGroundReason] = [],
            youBring: [CommonGroundTrade] = [],
            theyBring: [CommonGroundTrade] = [],
            nextStep: String? = nil,
            yourProfile: CommonGroundProfileTag? = nil,
            theirProfile: CommonGroundProfileTag? = nil,
            updatedAt: String? = nil
        ) {
            self.score = min(max(score, 0), 100)
            self.headline = headline
            self.shared = shared
            self.youBring = youBring
            self.theyBring = theyBring
            self.nextStep = nextStep
            self.yourProfile = yourProfile
            self.theirProfile = theirProfile
            self.updatedAt = updatedAt
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let score = try c.decode(Int.self, forKey: .score)
            func list<T: Decodable>(_ type: [T].Type, _ key: CodingKeys) -> [T] {
                (try? c.decodeIfPresent(type, forKey: key)) ?? []
            }
            self.init(
                score: score,
                headline: (try? c.decodeIfPresent(String.self, forKey: .headline))?.nonEmpty,
                shared: Array(list([FailableReason].self, .shared).compactMap(\.value).prefix(5)),
                youBring: Array(list([FailableTrade].self, .youBring).compactMap(\.value).prefix(3)),
                theyBring: Array(list([FailableTrade].self, .theyBring).compactMap(\.value).prefix(3)),
                nextStep: (try? c.decodeIfPresent(String.self, forKey: .nextStep))?.nonEmpty,
                yourProfile: try? c.decodeIfPresent(CommonGroundProfileTag.self, forKey: .yourProfile),
                theirProfile: try? c.decodeIfPresent(CommonGroundProfileTag.self, forKey: .theirProfile),
                updatedAt: try? c.decodeIfPresent(String.self, forKey: .updatedAt)
            )
        }
    }
}

/// A shared topic needs its `topic`; `theirTopic` falls back to it.
private struct FailableReason: Decodable {
    let value: CommonGroundReason?

    private enum CodingKeys: String, CodingKey { case topic, theirTopic, why }

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self),
              let topic = (try? c.decodeIfPresent(String.self, forKey: .topic)).nonEmpty else {
            value = nil
            return
        }
        let theirTopic = (try? c.decodeIfPresent(String.self, forKey: .theirTopic)).nonEmpty ?? topic
        let why = (try? c.decodeIfPresent(String.self, forKey: .why)) ?? ""
        value = CommonGroundReason(topic: topic, theirTopic: theirTopic, why: why)
    }
}

/// A trade needs its `topic`; `for` and `why` may be missing.
private struct FailableTrade: Decodable {
    let value: CommonGroundTrade?

    private enum CodingKeys: String, CodingKey {
        case topic, why
        case target = "for"
    }

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self),
              let topic = (try? c.decodeIfPresent(String.self, forKey: .topic)).nonEmpty else {
            value = nil
            return
        }
        let target = (try? c.decodeIfPresent(String.self, forKey: .target)) ?? ""
        let why = (try? c.decodeIfPresent(String.self, forKey: .why)) ?? ""
        value = CommonGroundTrade(topic: topic, target: target, why: why)
    }
}
