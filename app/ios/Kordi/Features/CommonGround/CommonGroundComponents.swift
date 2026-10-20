import SwiftUI

// Shared pieces of the Common ground screens.

/// Grouped section like the info page's, with a tighter corner radius.
struct CommonGroundSection<Content: View>: View {
    var title: String? = nil
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                    .accessibilityAddTraits(.isHeader)
            }
            VStack(spacing: 0) { content }
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    Color(uiColor: .secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                )
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct CommonGroundAvatar: View {
    let person: CommonGroundPerson
    var size: CGFloat = 40
    /// Opaque backing and a ring, for avatars that overlap.
    var ringed = false

    var body: some View {
        let shape = Circle()
        IdentityAvatar(name: person.displayName, imageSource: person.avatarUrl, kind: .person, size: size, seed: person.accountId)
            .clipShape(shape)
            .background(Color(uiColor: .systemBackground), in: shape)
            .overlay { if ringed { shape.stroke(Color(uiColor: .systemBackground), lineWidth: 3) } }
    }
}

/// The room's would-be group: member avatars as circles in a grid.
struct CommonGroundStack: View {
    let people: [CommonGroundPerson]
    var size: CGFloat = 36

    var body: some View {
        let shown = Array(people.prefix(9))
        let columns = shown.count <= 1 ? 1 : shown.count <= 4 ? 2 : 3
        let gap = columns == 1 ? 0 : max(2, size * 0.04)
        let tile = (size - gap * CGFloat(columns - 1)) / CGFloat(columns)
        VStack(spacing: gap) {
            ForEach(0..<((shown.count + columns - 1) / columns), id: \.self) { row in
                HStack(spacing: gap) {
                    ForEach(shown[(row * columns)..<min(shown.count, row * columns + columns)]) { person in
                        IdentityAvatar(name: person.displayName, imageSource: person.avatarUrl, kind: .person, size: tile, seed: person.accountId)
                            .clipShape(Circle())
                    }
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// Contacts-style rows inside a grouped section.
struct CommonGroundPeopleRows: View {
    struct Entry: Identifiable {
        let person: CommonGroundPerson
        let subtitle: String
        var score: Int? = nil
        var selectable = true
        var id: String { person.accountId }
    }

    let entries: [Entry]
    let onSelect: ((CommonGroundPerson) -> Void)?

    var body: some View {
        ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
            if index > 0 { SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset + 52) }
            if let onSelect, entry.selectable {
                Button { onSelect(entry.person) } label: { row(entry, chevron: true) }
                    .buttonStyle(SessionRowButtonStyle())
            } else {
                row(entry, chevron: false)
            }
        }
    }

    private func row(_ entry: Entry, chevron: Bool) -> some View {
        HStack(spacing: 12) {
            CommonGroundAvatar(person: entry.person, size: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.person.displayName).font(.headline).foregroundStyle(.primary)
                if !entry.subtitle.isEmpty {
                    Text(entry.subtitle)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            if let score = entry.score {
                Text("\(score)%")
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            if chevron {
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, minHeight: SessionDetailMetrics.rowMinHeight, alignment: .leading)
        .contentShape(Rectangle())
    }
}

/// Two overlapping avatars with the match score on a tinted capsule.
struct CommonGroundMatchBadge: View {
    let me: CommonGroundPerson
    let person: CommonGroundPerson
    let score: Int?

    var body: some View {
        HStack(spacing: -14) {
            CommonGroundAvatar(person: me, size: 80, ringed: true)
            CommonGroundAvatar(person: person, size: 80, ringed: true)
        }
        .overlay(alignment: .bottom) {
            if let score {
                Text("\(score)% match")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(commonGroundTint, in: Capsule())
                    .overlay(Capsule().stroke(Color(uiColor: .systemBackground), lineWidth: 2))
                    .offset(y: 12)
            }
        }
        .padding(.bottom, 12)
    }
}

let commonGroundTagHeight: CGFloat = 32
let commonGroundTagShape = RoundedRectangle(cornerRadius: 8, style: .continuous)

/// A topic tag with its color dot. Tapping the text opens it; the remove
/// button shows only when the tag is editable. Hidden tags are muted.
struct CommonGroundTag: View {
    let topic: String
    var muted = false
    var onOpen: (() -> Void)? = nil
    var onRemove: (() -> Void)? = nil

    var body: some View {
        let style = commonGroundStyle(for: topic)
        HStack(spacing: 7) {
            Button { onOpen?() } label: {
                HStack(spacing: 7) {
                    Circle().fill(muted ? Color(uiColor: .tertiaryLabel) : style.color).frame(width: 8, height: 8)
                    Text(topic)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(muted ? .secondary : .primary)
                        .strikethrough(muted)
                        .lineLimit(1)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(onOpen == nil)
            if let onRemove {
                Button(action: onRemove) {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 20, height: 20)
                        .contentShape(Rectangle())
                }
                .buttonStyle(CommonGroundRemoveButtonStyle())
                .accessibilityLabel("Remove \(topic)")
            }
        }
        .padding(.leading, 12)
        .padding(.trailing, onRemove == nil ? 12 : 6)
        .frame(height: commonGroundTagHeight)
        .background(muted ? Color(uiColor: .tertiarySystemFill) : style.color.opacity(0.13), in: commonGroundTagShape)
    }
}

/// Plain remove glyph with a small rounded fill while pressed.
struct CommonGroundRemoveButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                Color(uiColor: .tertiarySystemFill).opacity(configuration.isPressed ? 1 : 0),
                in: RoundedRectangle(cornerRadius: 5, style: .continuous)
            )
    }
}

/// Read-only tags in a flowing section.
struct CommonGroundTagCloud: View {
    let topics: [String]

    var body: some View {
        FlowLayout(spacing: 8) {
            ForEach(topics, id: \.self) { CommonGroundTag(topic: $0) }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Small topic capsule with its icon colour.
struct CommonGroundTopicPill: View {
    let topic: String
    /// Gray fill and faint icon, for topics with no recent evidence.
    var muted = false

    var body: some View {
        let style = commonGroundStyle(for: topic)
        HStack(spacing: 5) {
            Image(systemName: style.symbol)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(muted ? Color(uiColor: .tertiaryLabel) : style.color)
            Text(topic)
                .font(.caption.weight(.medium))
                .foregroundStyle(muted ? .secondary : .primary)
                .lineLimit(1)
        }
        .padding(.horizontal, 9)
        .frame(height: 26)
        .background(muted ? Color(uiColor: .tertiarySystemFill) : style.color.opacity(0.12), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

struct CommonGroundThinking: View {
    let steps: [String]
    /// Runs while the steps cycle; the last step holds until it finishes.
    let work: @MainActor () async -> Void
    @State private var index = 0

    var body: some View {
        VStack(spacing: 14) {
            KordiMark(size: 72, colorRelay: true)
            Text(steps[min(index, steps.count - 1)])
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .contentTransition(.opacity)
        }
        .frame(maxWidth: .infinity)
        .task {
            let stepper = Task { @MainActor in
                for step in steps.indices {
                    withAnimation { index = step }
                    try? await Task.sleep(for: .seconds(1.5))
                }
            }
            await work()
            stepper.cancel()
        }
    }
}

/// Settings-style icon tile for a topic, picked by keyword so any server
/// string gets a stable icon and brand colour.
func commonGroundStyle(for topic: String) -> (symbol: String, color: Color) {
    let text = topic.lowercased()
    func has(_ words: String...) -> Bool { words.contains { text.contains($0) } }
    if has("memory") { return ("brain", KordiTheme.brandPink) }
    if has("eval", "benchmark") { return ("checkmark.seal", KordiTheme.signalBlue) }
    if has("privacy", "security") { return ("lock", Color(uiColor: .systemGray)) }
    if has("education", "learn", "tutor") { return ("graduationcap", KordiTheme.brandCyan) }
    if has("device", "quantiz", "edge", "compression") { return ("iphone", KordiTheme.brandAmber) }
    if has("moderation", "community", "social") { return ("bubble.left.and.bubble.right", KordiTheme.agentViolet) }
    if has("robot") { return ("gearshape.2", KordiTheme.agentViolet) }
    if has("study", "user", "qualitative") { return ("person.2", KordiTheme.brandCyan) }
    let palette = [KordiTheme.brandPink, KordiTheme.brandCyan, KordiTheme.brandAmber, KordiTheme.signalBlue, KordiTheme.agentViolet]
    // djb2: String.hashValue is seeded per launch, this stays stable.
    var hash: UInt64 = 5381
    for byte in text.utf8 { hash = (hash &* 33) &+ UInt64(byte) }
    return ("sparkles", palette[Int(hash % UInt64(palette.count))])
}

/// "2026-09-30" to "Sep 30, 2026"; nil when missing or unparseable.
func commonGroundDisplayDate(_ raw: String?) -> String? {
    guard let raw else { return nil }
    let parser = DateFormatter()
    parser.calendar = Calendar(identifier: .gregorian)
    parser.locale = Locale(identifier: "en_US_POSIX")
    parser.timeZone = .current
    parser.dateFormat = "yyyy-MM-dd"
    guard let date = parser.date(from: String(raw.prefix(10))) else { return nil }
    return date.formatted(.dateTime.month(.abbreviated).day().year())
}

/// "Alex", "Alex and Sam", "Alex, Sam and Kim".
func commonGroundNameList(_ names: [String]) -> String {
    guard names.count > 1 else { return names.first ?? "" }
    return names.dropLast().joined(separator: ", ") + " and " + (names.last ?? "")
}
