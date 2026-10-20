import SwiftUI

/// Quarters, newest first, on a dotted rail; past topics close the list muted.
struct CommonGroundTimeline: View {
    let profile: CommonGroundProfile
    let onOpen: (String) -> Void

    private struct Entry: Identifiable {
        let period: String
        let topics: [String]
        var id: String { period }
    }

    private static let periodWidth: CGFloat = 72
    private static let rowPadding: CGFloat = 10
    /// Vertical centre of the dot within a row.
    private static let dotCenter: CGFloat = rowPadding + 10

    /// Each topic sits in the period it first appeared; earlier topics that
    /// appear in no period close the list.
    private var entries: [Entry] {
        var out = profile.timeline.map { Entry(period: $0.period, topics: $0.topics) }
        let placed = Set(profile.timeline.flatMap(\.topics))
        let rest = profile.earlier.filter { !placed.contains($0) }
        if !rest.isEmpty {
            out.append(Entry(period: "Earlier", topics: rest))
        }
        return out
    }

    var body: some View {
        let entries = entries
        CommonGroundSection(title: "Timeline") {
            VStack(spacing: 0) {
                ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                    row(entry, isFirst: index == 0, isLast: index == entries.count - 1)
                }
            }
            .padding(.vertical, 4)
        }
    }

    private func row(_ entry: Entry, isFirst: Bool, isLast: Bool) -> some View {
        let earlier = Set(profile.earlier)
        let muted = !entry.topics.isEmpty && entry.topics.allSatisfy(earlier.contains)
        return HStack(alignment: .top, spacing: 12) {
            Text(entry.period)
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .foregroundStyle(muted ? .secondary : .primary)
                .frame(width: Self.periodWidth, alignment: .leading)
            Circle()
                .fill(muted ? Color(uiColor: .tertiaryLabel) : commonGroundTint)
                .frame(width: 8, height: 8)
                .padding(.top, Self.dotCenter - Self.rowPadding - 4)
            FlowLayout(spacing: 6) {
                ForEach(entry.topics, id: \.self) { topic in
                    Button { onOpen(topic) } label: {
                        CommonGroundTopicPill(topic: topic, muted: earlier.contains(topic))
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, Self.rowPadding)
        .background(alignment: .topLeading) {
            if !(isFirst && isLast) {
                Rectangle()
                    .fill(Color(uiColor: .separator))
                    .frame(width: 1.5, height: isLast ? Self.dotCenter : nil)
                    .padding(.top, isFirst ? Self.dotCenter : 0)
                    .frame(maxHeight: .infinity, alignment: .top)
                    .padding(.leading, 14 + Self.periodWidth + 12 + 4 - 0.75)
            }
        }
    }
}

/// The evidence behind one topic, newest first; rows with a URL open it.
/// Topics on the card can be hidden from others here.
struct CommonGroundReferences: View {
    @EnvironmentObject private var model: CommonGroundModel
    let topic: String
    let profile: CommonGroundProfile?

    private var onCard: Bool { model.card?.topics.all.contains(topic) ?? false }

    var body: some View {
        let info = profile?.topics[topic]
        let items = profile?.evidence(for: topic) ?? []
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(topic)
                            .font(.title3.weight(.bold))
                        if let seen = seenLine(info) {
                            Text(seen)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer(minLength: 8)
                    if onCard {
                        Button(model.isHidden(topic) ? "Show" : "Hide") {
                            Task { await model.toggleHidden(topic) }
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .disabled(model.busy == "hidden")
                    }
                }
                .padding(.horizontal, 4)
                CommonGroundSection {
                    if items.isEmpty {
                        CommonGroundRow(title: "No references")
                    }
                    ForEach(Array(items.enumerated()), id: \.element.id) { index, entry in
                        if index > 0 { SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset) }
                        if let raw = entry.item.url, let url = URL(string: raw) {
                            Link(destination: url) { row(entry.item, linked: true) }
                                .buttonStyle(SessionRowButtonStyle())
                        } else {
                            row(entry.item, linked: false)
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 24)
            .padding(.bottom, 16)
        }
        .background(Color(uiColor: .systemGroupedBackground))
    }

    private func row(_ item: CommonGroundProfile.Evidence, linked: Bool) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title)
                    .font(.body)
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                Text([item.source, commonGroundDisplayDate(item.date)].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if !item.snippet.isEmpty {
                    Text(item.snippet)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            .multilineTextAlignment(.leading)
            Spacer(minLength: 0)
            if linked {
                Image(systemName: "arrow.up.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .padding(.top, 4)
            }
        }
        .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, minHeight: SessionDetailMetrics.rowMinHeight, alignment: .leading)
        .contentShape(Rectangle())
    }

    private func seenLine(_ info: CommonGroundProfile.TopicInfo?) -> String? {
        let parts = [
            commonGroundDisplayDate(info?.firstSeen).map { "First seen \($0)" },
            commonGroundDisplayDate(info?.lastSeen).map { "Last seen \($0)" },
        ].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
