import SwiftUI
import UIKit

enum KordiMarkdownInlinePart: Equatable {
    case text(String)
    case code(String)
    case strong(String)
    case emphasis(String)
    case link(label: String, url: URL)
}

struct KordiMarkdownListItem: Equatable {
    let text: String
    let checked: Bool?
    let depth: Int
    let ordered: Bool
    let ordinal: Int
}

enum KordiMarkdownBlock: Equatable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case code(language: String?, source: String)
    case list([KordiMarkdownListItem])
    case blockquote(String)
    case table(headers: [String], rows: [[String]])
}

enum KordiMarkdownParser {
    static func parse(_ text: String) -> [KordiMarkdownBlock] {
        let key = text as NSString
        if let cached = blockCache.object(forKey: key) { return cached.blocks }
        let blocks = parseUncached(text)
        blockCache.setObject(
            MarkdownBlockBox(blocks),
            forKey: key,
            cost: min(text.utf8.count, 128 * 1_024)
        )
        return blocks
    }

    private static func parseUncached(_ text: String) -> [KordiMarkdownBlock] {
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n")
            .components(separatedBy: "\n")
        var blocks: [KordiMarkdownBlock] = []
        var index = 0

        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty {
                index += 1
                continue
            }

            if let fence = captures(in: trimmed, pattern: "^(`{3,})([^\\s`]*)?.*$") {
                let fenceLength = fence[1].count
                let language = fence[2].nonEmpty
                var source: [String] = []
                index += 1
                while index < lines.count {
                    let candidate = lines[index].trimmingCharacters(in: .whitespaces)
                    if let closing = captures(in: candidate, pattern: "^(`{3,})\\s*$"),
                       closing[1].count >= fenceLength {
                        break
                    }
                    source.append(lines[index])
                    index += 1
                }
                if index < lines.count { index += 1 }
                blocks.append(.code(language: language, source: source.joined(separator: "\n")))
                continue
            }

            if trimmed.contains("|"), index + 1 < lines.count, isTableSeparator(lines[index + 1]) {
                let headers = splitTableRow(line)
                var rows: [[String]] = []
                index += 2
                while index < lines.count {
                    let row = lines[index]
                    guard !row.trimmingCharacters(in: .whitespaces).isEmpty, row.contains("|") else { break }
                    rows.append(splitTableRow(row))
                    index += 1
                }
                blocks.append(.table(headers: headers, rows: rows))
                continue
            }

            if let heading = captures(in: trimmed, pattern: "^(#{1,3})\\s+(.+)$") {
                blocks.append(.heading(level: heading[1].count, text: heading[2]))
                index += 1
                continue
            }

            if trimmed.hasPrefix(">") {
                var quote: [String] = []
                while index < lines.count {
                    let candidate = lines[index].trimmingCharacters(in: .whitespaces)
                    guard candidate.hasPrefix(">") else { break }
                    quote.append(candidate.replacingOccurrences(of: "^>\\s?", with: "", options: .regularExpression))
                    index += 1
                }
                blocks.append(.blockquote(quote.joined(separator: "\n")))
                continue
            }

            if let parsedList = parseList(lines, startIndex: index) {
                blocks.append(.list(parsedList.items))
                index = parsedList.nextIndex
                continue
            }

            var paragraph: [String] = []
            while index < lines.count {
                let candidate = lines[index].trimmingCharacters(in: .whitespaces)
                guard !candidate.isEmpty, !isBlockStarter(lines: lines, index: index) else { break }
                paragraph.append(candidate)
                index += 1
            }
            if !paragraph.isEmpty {
                blocks.append(.paragraph(paragraph.joined(separator: " ")))
            } else {
                // A malformed block marker is still user content; never let it stall parsing.
                blocks.append(.paragraph(trimmed))
                index += 1
            }
        }

        return blocks
    }

    static func parseInline(_ text: String) -> [KordiMarkdownInlinePart] {
        let key = text as NSString
        if let cached = inlineCache.object(forKey: key) { return cached.parts }
        let parts = parseInlineUncached(text)
        inlineCache.setObject(
            MarkdownInlineBox(parts),
            forKey: key,
            cost: min(text.utf8.count, 32 * 1_024)
        )
        return parts
    }

    private static func parseInlineUncached(_ text: String) -> [KordiMarkdownInlinePart] {
        var parts: [KordiMarkdownInlinePart] = []
        var remainder = text[...]

        while !remainder.isEmpty {
            let value = String(remainder)
            let patterns: [(String, ([String]) -> (part: KordiMarkdownInlinePart, suffix: String)?)] = [
                ("^\\[([^\\]]+)\\]\\((https?://[^\\s)]+)\\)", { captures in
                    guard let url = URL(string: captures[2]) else { return nil }
                    return (.link(label: captures[1], url: url), "")
                }),
                ("^(https?://[^\\s<>\"']+)", { captures in
                    var rawURL = captures[1]
                    var suffix = ""
                    while let last = rawURL.last, ".,!?;:".contains(last) {
                        suffix.insert(last, at: suffix.startIndex)
                        rawURL.removeLast()
                    }
                    guard let url = URL(string: rawURL) else { return nil }
                    return (.link(label: rawURL, url: url), suffix)
                }),
                ("^`([^`]+)`", { (.code($0[1]), "") }),
                ("^\\*\\*([^*]+)\\*\\*", { (.strong($0[1]), "") }),
                ("^\\*([^*]+)\\*", { (.emphasis($0[1]), "") })
            ]

            var matched = false
            for (pattern, transform) in patterns {
                guard let hit = capturesWithFullMatch(in: value, pattern: pattern),
                      let transformed = transform(hit.captures) else { continue }
                parts.append(transformed.part)
                if !transformed.suffix.isEmpty { parts.append(.text(transformed.suffix)) }
                remainder = remainder.dropFirst(hit.fullMatch.count)
                matched = true
                break
            }
            if matched { continue }

            let tokens = ["[", "`", "*", "http://", "https://"]
            let next = tokens.compactMap { value.range(of: $0)?.lowerBound }
                .min { value.distance(from: value.startIndex, to: $0) < value.distance(from: value.startIndex, to: $1) }

            guard let next else {
                parts.append(.text(value))
                break
            }
            if next == value.startIndex {
                let nextCharacter = value.index(after: value.startIndex)
                parts.append(.text(String(value[..<nextCharacter])))
                remainder = remainder.dropFirst()
            } else {
                let prefix = String(value[..<next])
                parts.append(.text(prefix))
                remainder = remainder.dropFirst(prefix.count)
            }
        }

        return parts
    }

    private static func parseList(
        _ lines: [String],
        startIndex: Int
    ) -> (items: [KordiMarkdownListItem], nextIndex: Int)? {
        guard let first = listLine(lines[startIndex]) else { return nil }
        var items: [KordiMarkdownListItem] = []
        var indentLevels = [first.indent]
        var ordinals: [Int: Int] = [:]
        var index = startIndex

        while index < lines.count {
            guard !lines[index].trimmingCharacters(in: .whitespaces).isEmpty,
                  let line = listLine(lines[index]),
                  line.indent >= first.indent else { break }
            if line.indent == first.indent, line.ordered != first.ordered { break }

            indentLevels.removeAll { $0 > line.indent }
            if !indentLevels.contains(line.indent) { indentLevels.append(line.indent) }
            indentLevels.sort()
            let depth = indentLevels.firstIndex(of: line.indent) ?? 0
            let task = taskPrefix(line.content)
            let ordinal = line.ordered ? ordinals[depth, default: 0] + 1 : 0
            if line.ordered { ordinals[depth] = ordinal }

            items.append(KordiMarkdownListItem(
                text: task.text,
                checked: task.checked,
                depth: depth,
                ordered: line.ordered,
                ordinal: ordinal
            ))
            index += 1
        }

        return (items, index)
    }

    private static func isBlockStarter(lines: [String], index: Int) -> Bool {
        let value = lines[index].trimmingCharacters(in: .whitespaces)
        if captures(in: value, pattern: "^(#{1,3})\\s+(.+)$") != nil { return true }
        if captures(in: value, pattern: "^(`{3,})") != nil { return true }
        if value.hasPrefix(">") || listLine(lines[index]) != nil { return true }
        return value.contains("|") && index + 1 < lines.count && isTableSeparator(lines[index + 1])
    }

    private static func listLine(_ line: String) -> (indent: Int, ordered: Bool, content: String)? {
        guard let hit = captures(in: line, pattern: "^(\\s*)([-*+]|(\\d+)\\.)\\s+(.*)$") else { return nil }
        let indent = hit[1].replacingOccurrences(of: "\t", with: "    ").count
        return (indent, !hit[3].isEmpty, hit[4])
    }

    private static func taskPrefix(_ text: String) -> (checked: Bool?, text: String) {
        guard let hit = captures(in: text, pattern: "^\\[( |x|X)\\]\\s+(.*)$") else {
            return (nil, text)
        }
        return (hit[1].lowercased() == "x", hit[2])
    }

    private static func splitTableRow(_ line: String) -> [String] {
        var value = line.trimmingCharacters(in: .whitespaces)
        if value.hasPrefix("|") { value.removeFirst() }
        if value.hasSuffix("|") { value.removeLast() }
        return value.split(separator: "|", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private static func isTableSeparator(_ line: String) -> Bool {
        let value = line.trimmingCharacters(in: .whitespaces)
        guard value.contains("|") else { return false }
        return splitTableRow(value).allSatisfy {
            captures(in: $0, pattern: "^:?-{3,}:?$") != nil
        }
    }

    private static func captures(in text: String, pattern: String) -> [String]? {
        capturesWithFullMatch(in: text, pattern: pattern)?.captures
    }

    private static func capturesWithFullMatch(
        in text: String,
        pattern: String
    ) -> (fullMatch: String, captures: [String])? {
        let patternKey = pattern as NSString
        let regex: NSRegularExpression
        if let cached = regularExpressionCache.object(forKey: patternKey) {
            regex = cached
        } else {
            guard let compiled = try? NSRegularExpression(pattern: pattern) else { return nil }
            regularExpressionCache.setObject(compiled, forKey: patternKey)
            regex = compiled
        }
        guard
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              match.range.location == 0,
              let fullRange = Range(match.range(at: 0), in: text) else { return nil }

        var captures = [String(text[fullRange])]
        if match.numberOfRanges > 1 {
            for index in 1..<match.numberOfRanges {
                let range = match.range(at: index)
                captures.append(range.location == NSNotFound ? "" : Range(range, in: text).map { String(text[$0]) } ?? "")
            }
        }
        return (String(text[fullRange]), captures)
    }

    private final class MarkdownBlockBox: NSObject {
        let blocks: [KordiMarkdownBlock]

        init(_ blocks: [KordiMarkdownBlock]) {
            self.blocks = blocks
        }
    }

    private final class MarkdownInlineBox: NSObject {
        let parts: [KordiMarkdownInlinePart]

        init(_ parts: [KordiMarkdownInlinePart]) {
            self.parts = parts
        }
    }

    private static let blockCache: NSCache<NSString, MarkdownBlockBox> = {
        let cache = NSCache<NSString, MarkdownBlockBox>()
        cache.countLimit = 1_024
        cache.totalCostLimit = 8 * 1_024 * 1_024
        return cache
    }()

    private static let inlineCache: NSCache<NSString, MarkdownInlineBox> = {
        let cache = NSCache<NSString, MarkdownInlineBox>()
        cache.countLimit = 2_048
        cache.totalCostLimit = 4 * 1_024 * 1_024
        return cache
    }()

    private static let regularExpressionCache: NSCache<NSString, NSRegularExpression> = {
        let cache = NSCache<NSString, NSRegularExpression>()
        cache.countLimit = 32
        return cache
    }()
}

struct MarkdownMessageContent: View {
    enum Density: Equatable {
        case standard
        case compact
    }

    let text: String
    let density: Density
    let mentionTargets: [ComposerMentionTarget]
    let mentions: [MessageMention]
    @State private var showsFullOversizedText = false

    // ponytail: Keep first layout bounded; paginate rich Markdown blocks if expanded formatting becomes necessary.
    static let oversizedTextByteLimit = 32 * 1_024
    static let oversizedTextPreviewCharacters = 12_000

    init(
        text: String,
        density: Density = .standard,
        mentionTargets: [ComposerMentionTarget] = [],
        mentions: [MessageMention] = []
    ) {
        self.text = text
        self.density = density
        self.mentionTargets = mentionTargets
        self.mentions = mentions
    }

    private var blocks: [KordiMarkdownBlock] {
        KordiMarkdownParser.parse(text)
    }

    private var bodyFont: Font {
        density == .compact ? .caption : .body
    }

    private var blockSpacing: CGFloat {
        density == .compact ? 5 : 9
    }

    static func collapsedText(_ text: String) -> String? {
        guard text.utf8.count > oversizedTextByteLimit else { return nil }
        return String(text.prefix(oversizedTextPreviewCharacters)) + "…"
    }

    @ViewBuilder
    var body: some View {
        if let collapsed = Self.collapsedText(text) {
            VStack(alignment: .leading, spacing: blockSpacing) {
                Text(showsFullOversizedText ? text : collapsed)
                    .font(bodyFont)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                Button(showsFullOversizedText ? "Show less" : "Show full response") {
                    showsFullOversizedText.toggle()
                }
                .font(.caption.weight(.semibold))
                .buttonStyle(.plain)
                .foregroundStyle(KordiTheme.signalBlue)
                .accessibilityHint("Changes how much of this long message is visible")
            }
        } else {
            VStack(alignment: .leading, spacing: blockSpacing) {
                ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                    blockView(block)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
            .environment(\.composerMentionTargets, mentionTargets)
            .environment(\.messageMentions, mentions)
        }
    }

    @ViewBuilder
    private func blockView(_ block: KordiMarkdownBlock) -> some View {
        switch block {
        case let .heading(level, text):
            InlineMarkdownText(text: text, font: headingFont(level))
                .fontWeight(.bold)
                .accessibilityAddTraits(.isHeader)
        case let .paragraph(text):
            InlineMarkdownText(text: text, font: bodyFont)
        case let .code(language, source):
            MarkdownCodeBlock(language: language, source: source)
        case let .list(items):
            VStack(alignment: .leading, spacing: density == .compact ? 4 : 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    MarkdownListRow(item: item, font: bodyFont)
                }
            }
        case let .blockquote(text):
            HStack(alignment: .top, spacing: 9) {
                Capsule()
                    .fill(Color.secondary.opacity(0.45))
                    .frame(width: 3)
                InlineMarkdownText(text: text, font: bodyFont)
                    .italic()
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 2)
        case let .table(headers, rows):
            MarkdownTable(headers: headers, rows: rows)
        }
    }

    private func headingFont(_ level: Int) -> Font {
        if density == .compact {
            return level == 1 ? .subheadline : .caption
        }
        switch level {
        case 1: return .title3
        case 2: return .headline
        default: return .subheadline
        }
    }
}

private struct InlineMarkdownText: View {
    let text: String
    let font: Font
    @Environment(\.composerMentionTargets) private var mentionTargets
    @Environment(\.messageMentions) private var mentions

    var body: some View {
        Text(attributedText)
            .font(font)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var attributedText: AttributedString {
        var result = AttributedString()
        for part in KordiMarkdownParser.parseInline(text) {
            var fragment: AttributedString
            switch part {
            case let .text(value):
                fragment = styledText(value)
            case let .code(value):
                fragment = AttributedString(value)
                fragment.font = .system(.body, design: .monospaced)
                fragment.foregroundColor = .secondary
            case let .strong(value):
                fragment = styledText(value, baseFont: font.bold())
            case let .emphasis(value):
                fragment = styledText(value, baseFont: font.italic())
            case let .link(label, url):
                fragment = AttributedString(label)
                fragment.link = url
                fragment.foregroundColor = KordiTheme.signalBlue
                fragment.underlineStyle = .single
            }
            result.append(fragment)
        }
        return result
    }

    private func styledText(
        _ value: String,
        baseFont: Font? = nil
    ) -> AttributedString {
        var result = AttributedString()
        for segment in ComposerMentionTargetCatalog.highlightedSegments(
            in: value,
            mentions: mentions,
            targets: mentionTargets
        ) {
            var fragment = AttributedString(segment.text)
            if let kind = segment.kind {
                fragment.font = font.weight(.semibold)
                fragment.foregroundColor = kind == .agent
                    ? KordiTheme.agentMention
                    : KordiTheme.personMention
            } else if let baseFont {
                fragment.font = baseFont
            }
            result.append(fragment)
        }
        return result
    }
}

private extension EnvironmentValues {
    @Entry var composerMentionTargets: [ComposerMentionTarget] = []
    @Entry var messageMentions: [MessageMention] = []
}

private struct MarkdownListRow: View {
    let item: KordiMarkdownListItem
    let font: Font

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            marker
                .frame(width: 20, alignment: .trailing)
            InlineMarkdownText(text: item.text, font: font)
        }
        .padding(.leading, CGFloat(item.depth) * 17)
    }

    @ViewBuilder
    private var marker: some View {
        if let checked = item.checked {
            Image(systemName: checked ? "checkmark.square.fill" : "square")
                .font(font)
                .foregroundStyle(checked ? KordiTheme.signalBlue : .secondary)
                .accessibilityLabel(checked ? "Completed" : "Not completed")
        } else if item.ordered {
            Text("\(item.ordinal).")
                .font(font.monospacedDigit())
                .foregroundStyle(.secondary)
        } else {
            Text("•")
                .font(font.weight(.semibold))
                .foregroundStyle(.secondary)
        }
    }
}

private struct MarkdownCodeBlock: View {
    let language: String?
    let source: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(displayLanguage)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                Spacer(minLength: 12)
                Button {
                    UIPasteboard.general.string = source
                    withAnimation(.easeOut(duration: 0.15)) { copied = true }
                    Task {
                        try? await Task.sleep(for: .seconds(1.2))
                        withAnimation(.easeOut(duration: 0.15)) { copied = false }
                    }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .contentTransition(.symbolEffect(.replace))
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(copied ? "Copied" : "Copy code")
            }
            .padding(.leading, 10)

            Divider().opacity(0.55)

            ScrollView(.horizontal, showsIndicators: true) {
                Text(source)
                    .font(.system(.caption, design: .monospaced))
                    .lineSpacing(3)
                    .textSelection(.enabled)
                    .padding(10)
            }
        }
        .background(Color.primary.opacity(0.065), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .stroke(Color.primary.opacity(0.09), lineWidth: 0.5)
        }
        .accessibilityElement(children: .contain)
    }

    private var displayLanguage: String {
        switch language?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "js", "jsx", "mjs", "cjs": "javascript"
        case "ts", "tsx": "typescript"
        case "py", "py3": "python"
        case "sh", "zsh", "shell": "bash"
        case "yml": "yaml"
        case "md", "mdx": "markdown"
        case "htm", "xml", "svg": "html"
        case "mmd": "mermaid"
        case let value?: value
        case nil: "text"
        }
    }
}

private struct MarkdownTable: View {
    let headers: [String]
    let rows: [[String]]

    private var columnCount: Int {
        max(headers.count, rows.map(\.count).max() ?? 0)
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 0) {
                row(headers, isHeader: true)
                Divider()
                ForEach(Array(rows.enumerated()), id: \.offset) { index, cells in
                    row(cells, isHeader: false)
                    if index < rows.count - 1 { Divider().opacity(0.55) }
                }
            }
            .padding(1)
        }
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.primary.opacity(0.09), lineWidth: 0.5)
        }
    }

    private func row(_ cells: [String], isHeader: Bool) -> some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(0..<columnCount, id: \.self) { column in
                InlineMarkdownText(text: column < cells.count ? cells[column] : "", font: .caption)
                    .fontWeight(isHeader ? .semibold : .regular)
                    .frame(width: 132, alignment: .leading)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 8)
            }
        }
    }
}
