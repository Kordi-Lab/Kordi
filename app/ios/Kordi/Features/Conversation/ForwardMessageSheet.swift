import SwiftUI

struct MessageForwardRequest: Identifiable {
    let id = UUID()
    let sourceConversation: ConversationSummary
    let messages: [ChatMessage]
}

struct ForwardMessageSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @EnvironmentObject private var model: AppModel
    let request: MessageForwardRequest
    let onComplete: (ConversationSummary) -> Void

    @State private var destinations: [MessageForwardDestination] = []
    @State private var selected: MessageForwardDestination?
    @State private var query = ""
    @State private var filter = MessageForwardFilter.all
    @State private var caption = ""
    @State private var batch = MessageForwardBatch()
    @State private var didComplete = false
    @FocusState private var focusedField: Field?

    private enum Field { case search, comment }
    private var isBatch: Bool { request.messages.count > 1 }
    private var locked: Bool { batch.isSending || batch.destinationID != nil }
    private var visible: [MessageForwardDestination] {
        MessageForwardCatalog.filter(destinations, query: query, kind: filter)
    }
    private var title: String { isBatch ? "Forward \(request.messages.count) messages" : "Forward message" }

    var body: some View {
        NavigationStack {
            Group {
                if batch.succeeded {
                    success
                } else {
                    VStack(spacing: 0) {
                        pickerHeader
                        destinationList
                    }
                    .safeAreaInset(edge: .bottom, spacing: 0) {
                        if focusedField != .search { footer }
                    }
                }
            }
            .navigationTitle(batch.succeeded ? "" : title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(batch.succeeded ? .hidden : .automatic, for: .navigationBar)
            .toolbar {
                if !batch.succeeded {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Close", systemImage: "xmark") { dismiss() }
                            .labelStyle(.iconOnly)
                            .disabled(batch.isSending)
                            .accessibilityIdentifier("forward-close")
                    }
                }
            }
        }
        .presentationDetents(batch.succeeded ? [.height(dynamicTypeSize.isAccessibilitySize ? 180 : 120)] : [.large])
        .presentationBackground(batch.succeeded && !reduceTransparency ? AnyShapeStyle(.ultraThinMaterial) : AnyShapeStyle(.background))
        .presentationDragIndicator(batch.succeeded ? .hidden : .automatic)
        .animation(reduceMotion ? .easeOut(duration: 0.2) : .spring(duration: 0.5, bounce: 0.2), value: batch.succeeded)
        .sensoryFeedback(.success, trigger: batch.succeeded)
        .interactiveDismissDisabled(batch.isSending || batch.succeeded)
        .onAppear(perform: rebuildDestinations)
        .onChange(of: model.conversations) { rebuildDestinations() }
        .onChange(of: model.contacts) { rebuildDestinations() }
    }

    private var pickerHeader: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !isBatch, focusedField != .search, let message = request.messages.first {
                VStack(alignment: .leading, spacing: 4) {
                    let source = destinations.first { $0.id == request.sourceConversation.sessionId }
                    Label("From \(source?.path ?? request.sourceConversation.displayName)", systemImage: "arrowshape.turn.up.right")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("\(message.authorName): \(messagePreview(message))")
                        .font(.subheadline)
                        .lineLimit(2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: 12))
            }
            Text("Send to").font(.subheadline.weight(.semibold))
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Search people, groups, or agents", text: $query)
                    .font(.subheadline)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focusedField, equals: .search)
                    .submitLabel(.search)
                    .onSubmit { focusedField = nil }
                    .accessibilityIdentifier("forward-search")
                if !query.isEmpty {
                    Button("Clear search", systemImage: "xmark.circle.fill") { query = "" }
                        .labelStyle(.iconOnly)
                        .foregroundStyle(.secondary)
                        .frame(minWidth: 44, minHeight: 44)
                }
            }
            .frame(minHeight: 44)
            .padding(.horizontal, 12)
            .background(Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: 12))
            ScrollView(.horizontal) {
                HStack(spacing: 16) {
                    ForEach(MessageForwardFilter.allCases) { item in
                        Button {
                            filter = item
                        } label: {
                            VStack(spacing: 8) {
                                Text(item.rawValue).font(.subheadline.weight(filter == item ? .semibold : .regular))
                                Rectangle().fill(filter == item ? KordiTheme.signalBlue : .clear).frame(height: 2)
                            }
                            .padding(.horizontal, 6)
                            .frame(minHeight: 44)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(filter == item ? KordiTheme.signalBlue : .secondary)
                        .accessibilityAddTraits(filter == item ? .isSelected : [])
                    }
                }
            }
            .scrollIndicators(.hidden)
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }

    private var destinationList: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Recent chats" : "Search results")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 6)
            List {
                ForEach(visible) { destination in
                    ForwardDestinationRow(destination: destination, selected: selected?.id == destination.id) {
                        selected = destination
                        focusedField = nil
                    }
                    .disabled(locked)
                    .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                    .listRowSeparator(.hidden)
                    .listRowBackground(selected?.id == destination.id ? KordiTheme.signalBlue.opacity(0.08) : .clear)
                }
                if visible.isEmpty {
                    ContentUnavailableView {
                        Label(destinations.isEmpty ? "No chats available" : "No matching destinations", systemImage: "magnifyingglass")
                    } actions: {
                        if !destinations.isEmpty {
                            Button("Clear search and filters") { query = ""; filter = .all }
                        }
                    }
                    .listRowSeparator(.hidden)
                }
            }
            .listStyle(.plain)
            .contentMargins(.top, 0, for: .scrollContent)
            .scrollDismissesKeyboard(.interactively)
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let selected {
                (Text("To ").foregroundStyle(.secondary) + Text(selected.path).bold())
                    .font(.subheadline)
                    .accessibilityIdentifier("forward-selection")
            }
            if !isBatch {
                TextField("Add a comment (optional)", text: $caption, axis: .vertical)
                    .font(.subheadline)
                    .lineLimit(1...4)
                    .focused($focusedField, equals: .comment)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .frame(minHeight: 44)
                    .background(Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: 12))
                    .disabled(locked)
            }
            if let error = batch.errorMessage {
                Text(error).font(.footnote).foregroundStyle(.red)
                    .accessibilityIdentifier("forward-error")
            }
            Button(action: forward) {
                HStack(spacing: 8) {
                    if batch.isSending { ProgressView().tint(.white) }
                    else { Image(systemName: "arrowshape.turn.up.right") }
                    Text(buttonTitle).font(.body.weight(.semibold))
                }
                .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .tint(KordiTheme.signalBlue)
            .disabled(selected == nil || request.messages.isEmpty || batch.isSending)
            .accessibilityIdentifier("forward-submit")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.background)
        .overlay(alignment: .top) { Divider() }
    }

    private var buttonTitle: String {
        if batch.isSending { return isBatch ? "Forwarding \(batch.completedCount)/\(request.messages.count)…" : "Forwarding…" }
        return batch.errorMessage == nil ? "Forward" : "Try again"
    }

    private var success: some View {
        Button(action: completeForward) {
            HStack(spacing: 14) {
                ForwardSuccessMark()
                    .frame(width: 44, height: 44)
                    .accessibilityHidden(true)
                Text(isBatch ? "Messages forwarded" : "Message forwarded")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.primary)
                    .accessibilityIdentifier("forward-success")
            }
            .padding(.horizontal, 24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // Center within the whole confirmation card, including its bottom safe area.
        .ignoresSafeArea(.container, edges: .bottom)
        .accessibilityHint("Closes confirmation and opens the destination")
        .task {
            do {
                try await Task.sleep(for: .seconds(voiceOverEnabled ? 5 : 2))
                completeForward()
            } catch { }
        }
    }

    private func completeForward() {
        guard !didComplete, let selected else { return }
        didComplete = true
        onComplete(selected.conversation)
        dismiss()
    }

    private func rebuildDestinations() {
        destinations = MessageForwardCatalog.build(conversations: model.conversations, contacts: model.contacts,
            contactConversations: model.contacts.compactMap { model.conversationForContact($0) },
            ownAccountID: model.account?.accountId ?? "")
    }

    private func messagePreview(_ message: ChatMessage) -> String {
        message.text.nonEmpty ?? (message.voiceMessage != nil ? "Voice message" : "\(message.attachments.count) attachments")
    }

    private func forward() {
        guard let selected, !batch.isSending else { return }
        focusedField = nil
        Task {
            _ = await model.forward(request.messages, caption: caption, from: request.sourceConversation,
                                    to: selected.conversation, batch: batch)
        }
    }
}

private struct ForwardDestinationRow: View {
    let destination: MessageForwardDestination
    let selected: Bool
    let onSelect: () -> Void

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 10) {
                avatar
                VStack(alignment: .leading, spacing: 2) {
                    Text(destination.label).font(.body.weight(.semibold)).foregroundStyle(.primary)
                    Text(destination.context).font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                VStack(alignment: .trailing, spacing: 4) {
                    if destination.conversation.lastActivityAt > .distantPast {
                        Text(activityLabel).font(.caption2).foregroundStyle(.secondary)
                    }
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .font(.title3)
                        .foregroundStyle(selected ? KordiTheme.signalBlue : .secondary)
                }
                .accessibilityHidden(true)
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("forward-destination-\(destination.id)")
    }

    private var activityLabel: String {
        let date = destination.conversation.lastActivityAt
        if Calendar.current.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
        if Calendar.current.isDateInYesterday(date) { return "Yesterday" }
        return date.formatted(date: .abbreviated, time: .omitted)
    }

    @ViewBuilder private var avatar: some View {
        let conversation = destination.conversation
        if conversation.kind == .group {
            GroupAvatarStack(participants: conversation.groupParticipants, size: 34)
        } else {
            IdentityAvatar(name: conversation.agentDisplayName?.nonEmpty ?? conversation.displayName,
                imageSource: conversation.avatarSource, kind: conversation.kind, size: 34,
                seed: conversation.agentId?.nonEmpty ?? conversation.peerAccountId.nonEmpty ?? conversation.sessionId)
        }
    }
}

private struct ForwardSuccessMark: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = false
    @State private var drawn = false

    var body: some View {
        ZStack {
            Circle()
                .stroke(KordiTheme.signalBlue.opacity(0.3), lineWidth: 1)
                .scaleEffect(appeared && !reduceMotion ? 1.3 : 1)
                .opacity(appeared ? 0 : 1)
            Circle()
                .fill(KordiTheme.signalBlue.opacity(0.12))
            ForwardCheckmark()
                .trim(from: 0, to: drawn ? 1 : 0)
                .stroke(KordiTheme.signalBlue, style: StrokeStyle(lineWidth: 2.8, lineCap: .round, lineJoin: .round))
                .padding(12)
        }
        .scaleEffect(appeared || reduceMotion ? 1 : 0.92)
        .opacity(appeared ? 1 : 0)
        .onAppear {
            withAnimation(reduceMotion ? .easeOut(duration: 0.2) : .spring(duration: 0.5, bounce: 0.2)) {
                appeared = true
            }
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.25).delay(0.12)) {
                drawn = true
            }
        }
    }
}

private struct ForwardCheckmark: Shape {
    func path(in rect: CGRect) -> Path {
        Path { path in
            path.move(to: CGPoint(x: rect.minX, y: rect.midY))
            path.addLine(to: CGPoint(x: rect.minX + rect.width * 0.38, y: rect.maxY * 0.85))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY + rect.height * 0.15))
        }
    }
}
