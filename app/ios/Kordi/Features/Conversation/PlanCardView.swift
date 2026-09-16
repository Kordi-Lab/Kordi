import SwiftUI

/// A shared plan card inside a Pip message. Buttons act for the signed-in
/// member; the returned snapshot replaces the displayed one until the next
/// Pip message arrives with the server's version.
struct PlanCardView: View {
    let card: PlanCard
    let ownAccountId: String?
    let onAction: ((PlanCardAction) async -> PlanCard?)?

    @State private var current: PlanCard?
    @State private var busy = false
    @State private var notice: String?

    // A tap updates the card at once; a newer snapshot from the transcript
    // then takes over, so the card never sticks on an old local result.
    private var view: PlanCard {
        if let current, current.revision > card.revision { return current }
        return card
    }
    private var me: PlanCardParticipant? { view.participant(ownAccountId) }
    private var canRespond: Bool { me != nil && view.state != .canceled && !view.isPolling && onAction != nil }
    private var canConfirm: Bool {
        guard me?.organizer ?? false, onAction != nil else { return false }
        return view.state == .awaitingConfirmation || (view.isPolling && view.leadingOption != nil)
    }
    private var stateLabel: String {
        if view.state == .confirmed, !view.participants.isEmpty { return "\(view.goingCount) going" }
        return view.isPolling ? "Vote" : view.state.label
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "calendar.badge.clock")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(view.title)
                        .font(.system(size: 13, weight: .semibold))
                        .strikethrough(view.state == .canceled)
                        .foregroundStyle(view.state == .canceled ? .secondary : .primary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let meta = metaLine {
                        Text(meta)
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 6)
                Text(stateLabel)
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(stateTint)
                    .monospacedDigit()
            }
            if view.isPolling {
                optionsList
            } else {
                participantsRow
            }
            if canRespond || canConfirm {
                HStack(spacing: 6) {
                    Spacer(minLength: 0)
                    if canRespond, let accountId = ownAccountId {
                        actionButton("Can't make it", systemImage: "xmark", active: me?.rsvp == .no) {
                            await perform(.rsvp(view, accountId: accountId, going: false))
                        }
                        actionButton("I'm in", systemImage: "checkmark", active: me?.rsvp == .yes, primary: me?.rsvp != .yes) {
                            await perform(.rsvp(view, accountId: accountId, going: true))
                        }
                    }
                    if canConfirm, let accountId = ownAccountId {
                        let leading = view.isPolling ? view.leadingOption : nil
                        actionButton("Confirm", systemImage: nil, active: false, primary: true) {
                            await perform(.confirm(view, accountId: accountId, optionId: leading?.id))
                        }
                    }
                }
            }
            if let notice {
                Text(notice)
                    .font(.system(size: 11))
                    .foregroundStyle(.red)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(minWidth: 230, maxWidth: 340, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.primary.opacity(0.08)))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Plan card, \(view.state.label), \(view.title)")
        .onChange(of: card) { _, latest in
            // A newer server snapshot wins over an optimistic local one.
            if let current, latest.revision >= current.revision { self.current = nil }
        }
    }

    private var metaLine: String? {
        var parts: [String] = []
        if let when = whenLabel { parts.append(when) }
        if let location = view.location, !location.isEmpty { parts.append(location) }
        if !view.isPolling, !view.unresolvedFields.isEmpty {
            parts.append("still open: \(view.unresolvedFields.joined(separator: ", "))")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var totalVotes: Int { view.options.reduce(0) { $0 + $1.votes.count } }

    private func percent(_ option: PlanCardOption) -> Int {
        totalVotes == 0 ? 0 : Int((Double(option.votes.count) / Double(totalVotes) * 100).rounded())
    }

    private var optionsList: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(view.options) { option in
                let mine = ownAccountId.map { option.votes.contains($0) } ?? false
                let share = percent(option)
                Button {
                    guard let accountId = ownAccountId, me != nil else { return }
                    Task { await perform(.vote(view, accountId: accountId, optionId: option.id)) }
                } label: {
                    HStack(spacing: 8) {
                        ZStack {
                            Circle().strokeBorder(mine ? Color.accentColor : Color.secondary.opacity(0.6), lineWidth: 1)
                            if mine {
                                Circle().fill(Color.accentColor)
                                Image(systemName: "checkmark").font(.system(size: 8, weight: .bold)).foregroundStyle(.white)
                            }
                        }
                        .frame(width: 14, height: 14)
                        Text(option.label)
                            .font(.system(size: 12))
                            .lineLimit(3)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 4)
                        Text("\(share)%")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                    .padding(.horizontal, 9)
                    .padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(alignment: .leading) {
                        GeometryReader { proxy in
                            (mine ? Color.accentColor.opacity(0.18) : Color.secondary.opacity(0.14))
                                .frame(width: proxy.size.width * CGFloat(share) / 100)
                                .animation(.easeOut(duration: 0.24), value: share)
                        }
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).stroke(mine ? Color.accentColor : Color.primary.opacity(0.12)))
                    .contentShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(busy || me == nil || onAction == nil)
                .contextMenu {
                    if option.votes.isEmpty {
                        Text("No votes yet")
                    } else {
                        Section("\(option.votes.count) \(option.votes.count == 1 ? "vote" : "votes")") {
                            ForEach(option.votes, id: \.self) { voter in
                                Label(name(of: voter), systemImage: voter == ownAccountId ? "person.fill.checkmark" : "person")
                            }
                        }
                    }
                }
                .accessibilityLabel("\(option.label), \(share) percent\(mine ? ", your vote" : "")")
                .accessibilityHint("Touch and hold to see who voted")
            }
        }
    }

    private var participantsRow: some View {
        FlowLayout(spacing: 6) {
            ForEach(view.participants) { participant in
                HStack(spacing: 4) {
                    ZStack {
                        Circle()
                            .fill(participant.rsvp == .yes ? Color.green : Color.secondary.opacity(0.18))
                        if participant.rsvp == .no {
                            Circle().strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [3]))
                                .foregroundStyle(.secondary)
                        }
                        Text(initials(participant.displayName))
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(participant.rsvp == .yes ? .white : .primary)
                    }
                    .frame(width: 18, height: 18)
                    Text(participant.displayName)
                        .font(.system(size: 11.5))
                        .strikethrough(participant.rsvp == .no)
                        .opacity(participant.rsvp == .no ? 0.7 : 1)
                }
                .accessibilityLabel("\(participant.displayName)\(participant.organizer ? ", organizer" : ""), \(participant.rsvp.rawValue)")
            }
        }
    }

    private func actionButton(
        _ title: String,
        systemImage: String?,
        active: Bool,
        primary: Bool = false,
        action: @escaping () async -> Void
    ) -> some View {
        Button {
            Task { await action() }
        } label: {
            HStack(spacing: 4) {
                if let systemImage { Image(systemName: systemImage).font(.system(size: 10, weight: .semibold)) }
                Text(title)
            }
            .font(.system(size: 11, weight: primary ? .semibold : .medium))
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(
                primary ? Color.accentColor : (active ? Color.accentColor.opacity(0.14) : Color.clear),
                in: RoundedRectangle(cornerRadius: 8, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(primary || active ? Color.accentColor : Color.primary.opacity(0.12))
            )
            .foregroundStyle(primary ? Color.white : Color.primary)
        }
        .buttonStyle(.plain)
        .disabled(busy)
    }

    private func perform(_ action: PlanCardAction) async {
        guard !busy, let onAction else { return }
        busy = true
        notice = nil
        defer { busy = false }
        if let updated = await onAction(action) {
            current = updated
        } else {
            current = nil
            notice = "Could not update the plan. Try again."
        }
    }

    private func name(of accountId: String) -> String {
        view.participants.first { $0.participantId == accountId }?.displayName ?? "Member"
    }

    private var stateTint: Color {
        switch view.state {
        case .polling: Color(red: 0.30, green: 0.37, blue: 0.84)
        case .awaitingConfirmation: Color(red: 0.71, green: 0.40, blue: 0.05)
        case .confirmed: Color(red: 0.12, green: 0.54, blue: 0.37)
        case .canceled: Color(red: 0.70, green: 0.23, blue: 0.23)
        case .unknown: Color.secondary
        }
    }

    private var whenLabel: String? {
        guard let start = view.startDate else { return nil }
        let day = start.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
        let time = start.formatted(date: .omitted, time: .shortened)
        return "\(day) · \(time)"
    }

    private func initials(_ name: String) -> String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first }.map { String($0).uppercased() }
        return letters.isEmpty ? "?" : letters.joined()
    }
}

/// Minimal wrapping row for participant chips.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: width == .infinity ? x : width, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
