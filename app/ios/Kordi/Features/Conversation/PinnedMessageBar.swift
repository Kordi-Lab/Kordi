import SwiftUI

struct PinnedMessageBar: View {
    let items: [PinnedMessageItem]
    let onOpen: (PinnedMessageItem) -> Void
    let onUnpin: (PinnedMessageItem) -> Void
    @State private var selectedID: String?
    @State private var isListPresented = false
    @State private var pendingOpen: PinnedMessageItem?
    @State private var pendingUnpin: PinnedMessageItem?

    private var selectedIndex: Int { items.firstIndex { $0.id == selectedID } ?? 0 }

    var body: some View {
        if !items.isEmpty {
            let active = items[selectedIndex]
            HStack(spacing: 4) {
                Button {
                    let next = items[(selectedIndex + 1) % items.count]
                    selectedID = next.id
                    onOpen(next)
                } label: {
                    HStack(spacing: 12) {
                        VStack(spacing: 3) {
                            ForEach(items) { item in
                                Capsule()
                                    .fill(KordiTheme.signalBlue.opacity(item.id == active.id ? 1 : 0.25))
                            }
                        }
                        .frame(width: 3, height: 34)
                        .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 8) {
                                Text("Pinned message").font(.subheadline.weight(.semibold))
                                if items.count > 1 {
                                    Text("\(selectedIndex + 1) / \(items.count)")
                                        .font(.caption).monospacedDigit()
                                }
                            }
                            .foregroundStyle(KordiTheme.signalBlue)
                            Text(active.message.text.nonEmpty ?? "Attachment")
                                .font(.subheadline).foregroundStyle(.primary).lineLimit(1)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.vertical, 10)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(items.count > 1 ? "Next pinned message" : "Open pinned message")
                .accessibilityValue("\(selectedIndex + 1) of \(items.count), \(active.message.text)")

                Button { isListPresented = true } label: {
                    HStack(spacing: 1) {
                        Image(systemName: "pin")
                        Image(systemName: "list.bullet").font(.caption)
                    }
                    .font(.body).foregroundStyle(KordiTheme.signalBlue)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("View pinned messages")
            }
            .padding(.leading, 16).padding(.trailing, 8)
            .background(.bar)
            .overlay(alignment: .bottom) { Divider() }
            .sensoryFeedback(.selection, trigger: selectedID)
            .sheet(isPresented: $isListPresented, onDismiss: {
                if let item = pendingOpen { pendingOpen = nil; onOpen(item) }
                if let item = pendingUnpin { pendingUnpin = nil; onUnpin(item) }
            }) {
                PinnedMessagesSheet(items: items, onOpen: { item in
                    selectedID = item.id
                    pendingOpen = item
                }, onUnpin: { item in pendingUnpin = item })
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
            }
        }
    }
}

private struct PinnedMessagesSheet: View {
    @Environment(\.dismiss) private var dismiss
    let items: [PinnedMessageItem]
    let onOpen: (PinnedMessageItem) -> Void
    let onUnpin: (PinnedMessageItem) -> Void

    var body: some View {
        NavigationStack {
            List(items) { item in
                HStack(spacing: 12) {
                    Button {
                        onOpen(item)
                        dismiss()
                    } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: 8) {
                                Text(item.message.authorName.nonEmpty ?? "Message")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(KordiTheme.signalBlue)
                                Text(item.scope == "shared" ? "Everyone" : "Only you")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Text(item.message.text.nonEmpty ?? "Attachment")
                                .font(.body).foregroundStyle(.primary).lineLimit(3)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 6)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    Button {
                        onUnpin(item)
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.subheadline).foregroundStyle(.secondary)
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Unpin \(item.message.text.nonEmpty ?? "message")")
                }
            }
            .listStyle(.plain)
            .navigationTitle("Pinned messages")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

extension PinnedMessageItem {
    static func make(pin: CloudSessionPin?, conversationID: String, messagesByID: [String: ChatMessage]) -> [Self] {
        var seen = Set<String>()
        return ["shared", "private"].flatMap { scope in
            (pin?.messageIDs(scope: scope) ?? []).compactMap { messageID -> Self? in
                guard seen.insert(messageID).inserted else { return nil }
                // Older pinned messages remain navigable while their page loads.
                let message = messagesByID[messageID] ?? ChatMessage(
                    id: messageID, conversationId: conversationID, author: .person,
                    authorName: "", text: "Pinned message", createdAt: .distantPast,
                    deliveryState: .sent, errorMessage: nil, requestMessageId: nil)
                return Self(message: message, scope: scope)
            }
        }
    }
}
