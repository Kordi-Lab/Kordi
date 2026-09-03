import SwiftUI
import UIKit

struct ComposerMentionQuery: Equatable {
    let range: NSRange
    let raw: String
    let normalized: String
    let trailingWhitespace: Bool

    static func current(
        in text: String,
        selection: ComposerTextSelection
    ) -> ComposerMentionQuery? {
        let source = text as NSString
        let cursor = min(max(selection.location, 0), source.length)
        let at = source.range(
            of: "@",
            options: .backwards,
            range: NSRange(location: 0, length: cursor)
        )
        guard at.location != NSNotFound else { return nil }
        let rawRange = NSRange(
            location: NSMaxRange(at),
            length: cursor - NSMaxRange(at)
        )
        let raw = source.substring(with: rawRange)
        guard rawRange.length <= 512,
              !raw.contains(where: \.isNewline),
              raw.first?.isWhitespace != true else { return nil }
        return ComposerMentionQuery(
            range: NSRange(location: at.location, length: cursor - at.location),
            raw: raw,
            normalized: raw
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current),
            trailingWhitespace: raw.last?.isWhitespace == true
        )
    }
}

enum ComposerMentionMenuSection: Int, CaseIterable, Identifiable {
    case references
    case contacts
    case agents

    var id: Int { rawValue }

    var title: String {
        switch self {
        case .references: "References"
        case .contacts: "Contacts"
        case .agents: "Agents"
        }
    }
}

struct ComposerMentionMenuItem: Identifiable, Hashable {
    enum Kind: Hashable {
        case target(ComposerMentionTarget)
        case pickFile
        case startWebLink
        case webLink(String, complete: Bool)
    }

    let kind: Kind

    var id: String {
        switch kind {
        case .target(let target): "target:\(target.id)"
        case .pickFile: "reference:file"
        case .startWebLink: "reference:url:start"
        case .webLink(let value, _): "reference:url:\(value)"
        }
    }

    var section: ComposerMentionMenuSection {
        switch kind {
        case .pickFile, .startWebLink, .webLink: .references
        case .target(let target): target.kind == .agent ? .agents : .contacts
        }
    }

    var target: ComposerMentionTarget? {
        guard case .target(let target) = kind else { return nil }
        return target
    }

    var label: String {
        switch kind {
        case .target(let target): target.displayName
        case .pickFile: "Attach file…"
        case .startWebLink: "Web link"
        case .webLink(let value, _): value
        }
    }

    var detail: String {
        switch kind {
        case .pickFile: "Choose from Files"
        case .startWebLink: "Type a URL after @"
        case .webLink(_, let complete):
            complete ? "Add this web reference" : "Continue typing the URL"
        case .target(let target):
            switch target.kind {
            case .all: "All people in this group"
            case .person: "Contact"
            case .agent:
                target.ownerName?.nonEmpty.map { "\($0)’s agent" } ?? "Agent"
            }
        }
    }

    var accessibilityLabel: String {
        switch kind {
        case .pickFile: "Attach a file"
        case .startWebLink: "Add a web link"
        case .webLink(let value, _): "Web link \(value)"
        case .target(let target): "\(target.displayName), \(detail)"
        }
    }
}

enum ComposerMentionMenuCatalog {
    static func items(
        for query: ComposerMentionQuery?,
        targets: [ComposerMentionTarget]
    ) -> [ComposerMentionMenuItem] {
        guard let query else { return [] }
        let raw = query.raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty {
            return [.init(kind: .pickFile), .init(kind: .startWebLink)]
                + targets.map { .init(kind: .target($0)) }
        }
        if raw.lowercased().hasPrefix("http://") || raw.lowercased().hasPrefix("https://") {
            guard !query.trailingWhitespace else { return [] }
            return [.init(kind: .webLink(raw, complete: isCompleteWebURL(raw)))]
        }
        if query.trailingWhitespace,
           targets.contains(where: {
               $0.displayName.folding(
                   options: [.caseInsensitive, .diacriticInsensitive],
                   locale: .current
               ) == query.normalized
           }) {
            return []
        }
        return targets.filter {
            $0.displayName.localizedCaseInsensitiveContains(raw)
                || $0.ownerName?.localizedCaseInsensitiveContains(raw) == true
        }.map { .init(kind: .target($0)) }
    }

    private static func isCompleteWebURL(_ value: String) -> Bool {
        guard let components = URLComponents(string: value),
              ["http", "https"].contains(components.scheme?.lowercased() ?? ""),
              components.host?.nonEmpty != nil else { return false }
        return true
    }
}

enum ComposerMentionInsertion {
    static func replacing(
        _ text: String,
        query: ComposerMentionQuery,
        with item: ComposerMentionMenuItem
    ) -> ComposerTextReplacement {
        let replacement: String
        let addsTrailingSpace: Bool
        switch item.kind {
        case .target(let target):
            replacement = target.mentionText
            addsTrailingSpace = true
        case .pickFile:
            replacement = ""
            addsTrailingSpace = false
        case .startWebLink:
            replacement = "@https://"
            addsTrailingSpace = false
        case .webLink(let value, let complete):
            replacement = complete ? value : "@\(value)"
            addsTrailingSpace = complete
        }
        let source = text as NSString
        let prefix = source.substring(to: query.range.location)
        let suffix = source.substring(from: NSMaxRange(query.range))
        let separator = addsTrailingSpace
            && (suffix.isEmpty || suffix.first?.isWhitespace != true) ? " " : ""
        var replacementRange = query.range
        if replacement.isEmpty,
           prefix.last?.isWhitespace == true,
           let first = suffix.first,
           first.isWhitespace {
            replacementRange.length += (String(first) as NSString).length
        }
        return replacingComposerText(
            text,
            selection: ComposerTextSelection(
                location: replacementRange.location,
                length: replacementRange.length
            ),
            with: replacement + separator
        )
    }
}

enum ComposerMentionText {
    struct Highlight: Equatable {
        enum Kind: Equatable {
            case active
            case agent
            case person
        }

        let range: NSRange
        let kind: Kind
    }

    private static let agentColor = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 96 / 255, green: 165 / 255, blue: 250 / 255, alpha: 1)
            : UIColor(red: 37 / 255, green: 99 / 255, blue: 235 / 255, alpha: 1)
    }
    private static let personColor = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 80 / 255, green: 210 / 255, blue: 154 / 255, alpha: 1)
            : UIColor(red: 28 / 255, green: 122 / 255, blue: 82 / 255, alpha: 1)
    }

    static func highlights(
        in text: String,
        activeQuery: ComposerMentionQuery?,
        menuIsPresented: Bool,
        selectedTarget: ComposerMentionTarget?
    ) -> [Highlight] {
        var result: [Highlight] = []
        if let selectedTarget {
            let range = (text as NSString).range(
                of: selectedTarget.mentionText,
                options: [.caseInsensitive, .diacriticInsensitive]
            )
            if range.location != NSNotFound {
                result.append(Highlight(
                    range: range,
                    kind: selectedTarget.kind == .agent ? .agent : .person
                ))
            }
        }
        if menuIsPresented, let activeQuery {
            result.append(Highlight(range: activeQuery.range, kind: .active))
        }
        return result
    }

    static func attributedString(
        _ value: String,
        font: UIFont,
        highlights: [Highlight]
    ) -> NSAttributedString {
        let result = NSMutableAttributedString(
            attributedString: BlobEmojiComposerText.attributedString(value, font: font)
        )
        applyHighlights(
            to: result,
            rawText: value,
            highlights: highlights,
            font: font
        )
        return result
    }

    static func applyHighlights(
        to textView: UITextView,
        rawText: String,
        highlights: [Highlight]
    ) {
        let selection = textView.selectedRange
        applyHighlights(
            to: textView.textStorage,
            rawText: rawText,
            highlights: highlights,
            font: textView.font ?? .preferredFont(forTextStyle: .body)
        )
        textView.selectedRange = selection
        BlobEmojiComposerText.resetTypingAttributes(of: textView)
    }

    private static func renderedHighlightRange(
        in value: String,
        range: NSRange
    ) -> NSRange? {
        let source = value as NSString
        guard range.location >= 0,
              range.location < source.length,
              NSMaxRange(range) <= source.length,
              source.substring(with: NSRange(location: range.location, length: 1)) == "@" else {
            return nil
        }
        return BlobEmojiComposerText.renderedSelection(
            forRaw: range,
            in: value
        )
    }

    private static func applyHighlights(
        to value: NSMutableAttributedString,
        rawText: String,
        highlights: [Highlight],
        font: UIFont
    ) {
        guard value.length > 0 else { return }
        let fullRange = NSRange(location: 0, length: value.length)
        value.addAttributes([
            .font: font,
            .foregroundColor: UIColor.label,
        ], range: fullRange)
        let semibold = UIFont.systemFont(ofSize: font.pointSize, weight: .semibold)
        for highlight in highlights {
            guard let range = renderedHighlightRange(in: rawText, range: highlight.range),
                  NSMaxRange(range) <= value.length else { continue }
            value.addAttributes([
                .font: semibold,
                .foregroundColor: highlight.kind == .person ? personColor : agentColor,
            ], range: range)
        }
    }
}

enum ComposerMentionPickerLayout {
    static func height(
        targetCount: Int,
        rowHeight: CGFloat,
        chromeHeight: CGFloat,
        maximumHeight: CGFloat
    ) -> CGFloat {
        min(maximumHeight, chromeHeight + CGFloat(max(0, targetCount)) * rowHeight)
    }
}

struct ComposerMentionPicker: View {
    let items: [ComposerMentionMenuItem]
    let onSelect: (ComposerMentionMenuItem) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                ForEach(ComposerMentionMenuSection.allCases) { section in
                    let sectionItems = items.filter { $0.section == section }
                    if !sectionItems.isEmpty {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(section.title)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 12)
                            ForEach(sectionItems) { item in
                                Button { onSelect(item) } label: {
                                    HStack(spacing: 10) {
                                        itemIcon(item)
                                        VStack(alignment: .leading, spacing: 1) {
                                            Text(item.label)
                                                .font(.subheadline.weight(.semibold))
                                                .foregroundStyle(.primary)
                                                .lineLimit(1)
                                            Text(item.detail)
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                                .lineLimit(1)
                                        }
                                        Spacer(minLength: 8)
                                    }
                                    .frame(minHeight: 44)
                                    .padding(.horizontal, 12)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityElement(children: .ignore)
                                .accessibilityLabel(item.accessibilityLabel)
                                .accessibilityHint(item.kind == .pickFile
                                    ? "Opens the Files picker"
                                    : "Adds this item to the message")
                            }
                        }
                    }
                }
            }
            .padding(.vertical, 10)
        }
        .scrollIndicators(items.count > 5 ? .visible : .hidden)
    }

    @ViewBuilder
    private func itemIcon(_ item: ComposerMentionMenuItem) -> some View {
        if let target = item.target, target.kind != .all {
            IdentityAvatar(
                name: target.displayName,
                imageSource: target.avatarSource,
                kind: target.kind == .agent ? .agent : .person,
                size: 30,
                seed: target.agentId ?? target.accountId
            )
        } else {
            Image(systemName: systemImage(for: item))
                .font(.body.weight(.medium))
                .foregroundStyle(.secondary)
                .frame(width: 30, height: 30)
                .accessibilityHidden(true)
        }
    }

    private func systemImage(for item: ComposerMentionMenuItem) -> String {
        switch item.kind {
        case .pickFile: "paperclip"
        case .startWebLink, .webLink: "link"
        case .target: "person.2"
        }
    }
}
