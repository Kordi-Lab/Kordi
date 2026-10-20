import Foundation

extension KordiMarkdownParser {
    typealias ListLine = (indent: Int, ordered: Bool, number: Int, content: String)

    static func parseList(
        _ lines: [String],
        startIndex: Int
    ) -> (items: [KordiMarkdownListItem], nextIndex: Int)? {
        guard let first = listLine(lines[startIndex]) else { return nil }
        var items: [KordiMarkdownListItem] = []
        var indentLevels = [first.indent]
        var ordinals: [Int: Int] = [:]
        var index = startIndex
        var afterBlank = false

        while index < lines.count {
            let raw = lines[index]
            let trimmed = raw.trimmingCharacters(in: .whitespaces)

            if trimmed.isEmpty {
                // A blank line keeps the list open (a loose list) only when the
                // next content continues it: another item, or indented text.
                var next = index + 1
                while next < lines.count, lines[next].trimmingCharacters(in: .whitespaces).isEmpty { next += 1 }
                guard next < lines.count else { break }
                let continues: Bool
                if let nextItem = listLine(lines[next]) {
                    continues = nextItem.indent > first.indent
                        || (nextItem.indent == first.indent && nextItem.ordered == first.ordered)
                } else {
                    continues = indentWidth(lines[next]) > first.indent
                        && !startsOtherBlock(lines[next].trimmingCharacters(in: .whitespaces))
                }
                guard continues else { break }
                index = next
                afterBlank = true
                continue
            }

            guard let line = listLine(raw) else {
                // Text indented under an item continues it; blank-separated text
                // becomes a new line inside the same item.
                guard let last = items.last, indentWidth(raw) > first.indent, !startsOtherBlock(trimmed) else { break }
                items[items.count - 1] = KordiMarkdownListItem(
                    text: last.text + (afterBlank ? "\n" : " ") + trimmed,
                    checked: last.checked,
                    depth: last.depth,
                    ordered: last.ordered,
                    ordinal: last.ordinal
                )
                afterBlank = false
                index += 1
                continue
            }
            guard line.indent >= first.indent else { break }

            // Models often write the bullets under a numbered item without
            // indenting them. Nest those bullets instead of ending the list.
            let flatBulletUnderNumber = first.ordered && !line.ordered && !afterBlank
                && line.indent == first.indent && !items.isEmpty
            if line.indent == first.indent, line.ordered != first.ordered, !flatBulletUnderNumber { break }
            let indent = flatBulletUnderNumber ? first.indent + 1 : line.indent

            indentLevels.removeAll { $0 > indent }
            if !indentLevels.contains(indent) { indentLevels.append(indent) }
            indentLevels.sort()
            let depth = indentLevels.firstIndex(of: indent) ?? 0
            ordinals = ordinals.filter { $0.key <= depth }
            let task = taskPrefix(line.content)
            // Number from the source start, then count up, so "1." on every
            // item still reads 1, 2, 3 and a list that starts at 3 keeps 3.
            let ordinal = line.ordered ? ordinals[depth].map { $0 + 1 } ?? line.number : 0
            if line.ordered { ordinals[depth] = ordinal }

            items.append(KordiMarkdownListItem(
                text: task.text,
                checked: task.checked,
                depth: depth,
                ordered: line.ordered,
                ordinal: ordinal
            ))
            afterBlank = false
            index += 1
        }

        return (items, index)
    }

    static func listLine(_ line: String) -> ListLine? {
        guard let hit = captures(in: line, pattern: "^(\\s*)([-*+]|(\\d+)\\.)\\s+(.*)$") else { return nil }
        let indent = hit[1].replacingOccurrences(of: "\t", with: "    ").count
        return (indent, !hit[3].isEmpty, Int(hit[3]) ?? 1, hit[4])
    }

    private static func indentWidth(_ line: String) -> Int {
        line.prefix { $0 == " " || $0 == "\t" }.replacingOccurrences(of: "\t", with: "    ").count
    }

    private static func startsOtherBlock(_ trimmed: String) -> Bool {
        trimmed.range(of: "^#{1,3}\\s", options: .regularExpression) != nil || trimmed.hasPrefix("```") || trimmed.hasPrefix(">")
    }

    private static func taskPrefix(_ text: String) -> (checked: Bool?, text: String) {
        guard let hit = captures(in: text, pattern: "^\\[( |x|X)\\]\\s+(.*)$") else {
            return (nil, text)
        }
        return (hit[1].lowercased() == "x", hit[2])
    }
}
