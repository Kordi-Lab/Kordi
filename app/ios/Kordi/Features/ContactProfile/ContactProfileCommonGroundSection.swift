import SwiftUI

/// "Common ground". With a Grounding match: the score and their card, the
/// topics you both have, what each of you can help with, the next step, and
/// their own topics under "Their card". Without one: their topics only.
struct ContactProfileCommonGroundSection: View {
    let ground: CloudContactProfile.CommonGround
    @State private var showsTheirCard = false

    var body: some View {
        ContactProfileSectionLabel("Common ground")
        Group {
            if let match = ground.match {
                matchContent(match)
            } else {
                ContactProfileTopicLines(ground: ground)
            }
        }
        .padding(.horizontal, ContactProfileMetrics.gutter)
        .padding(.top, 10)
        .padding(.bottom, 6)
    }

    private func matchContent(_ match: CloudContactProfile.CommonGround.Match) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .center, spacing: 12) {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text("\(match.score)")
                        .font(.system(size: 40, weight: .semibold, design: .rounded).monospacedDigit())
                    Text("% match")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(match.score)% match")
                Spacer(minLength: 0)
                if let card = match.theirProfile {
                    ContactProfileCardChip(card: card)
                }
            }
            ContactProfileTopicGroup(label: "You both", topics: match.shared.map(\.topic))
            ContactProfileTopicGroup(label: "They can help with", topics: match.theyBring.map(\.topic))
            ContactProfileTopicGroup(label: "You can help with", topics: match.youBring.map(\.topic))
            if let nextStep = match.nextStep {
                Text(nextStep)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if ground.hasTopics {
                DisclosureGroup(isExpanded: $showsTheirCard) {
                    ContactProfileTopicLines(ground: ground)
                        .padding(.top, 10)
                } label: {
                    Text("Their card")
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                }
                .tint(.secondary)
            }
        }
    }
}

/// The contact's own topics: a label and chips for each list that has any.
struct ContactProfileTopicLines: View {
    let ground: CloudContactProfile.CommonGround

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            line("Working on", ground.workingOn)
            line("Can help", ground.canHelp)
            line("Looking for", ground.lookingFor)
        }
    }

    @ViewBuilder
    private func line(_ label: String, _ topics: [String]) -> some View {
        if !topics.isEmpty {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(label)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(width: 84, alignment: .leading)
                ContactProfileTopicChips(topics: Array(topics.prefix(4)))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .accessibilityElement(children: .combine)
        }
    }
}

/// A short label over topic chips; nothing when there are no topics.
struct ContactProfileTopicGroup: View {
    let label: String
    let topics: [String]

    var body: some View {
        if !topics.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text(label)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                ContactProfileTopicChips(topics: topics)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .accessibilityElement(children: .combine)
        }
    }
}

struct ContactProfileTopicChips: View {
    let topics: [String]

    var body: some View {
        FlowLayout(spacing: 6) {
            ForEach(Array(topics.enumerated()), id: \.offset) { _, topic in
                Text(topic)
                    .font(.caption)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(Color(uiColor: .tertiarySystemFill), in: Capsule())
            }
        }
    }
}

/// Their Common ground card: its colour and glyph, then its name.
struct ContactProfileCardChip: View {
    let card: CommonGroundProfileTag

    var body: some View {
        HStack(spacing: 6) {
            RoundedRectangle(cornerRadius: 4, style: .continuous)
                .fill(card.cardDesign.baseColour)
                .frame(width: 18, height: 18)
                .overlay {
                    Image(systemName: card.cardIcon?.symbol ?? card.cardDesign.glyph(kind: card.kindDesign))
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.white)
                }
            Text(card.title)
                .font(.footnote)
                .lineLimit(1)
        }
        .padding(.leading, 5)
        .padding(.trailing, 10)
        .padding(.vertical, 4)
        .background(Color(uiColor: .tertiarySystemFill), in: Capsule())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Their card, \(card.title)")
    }
}
