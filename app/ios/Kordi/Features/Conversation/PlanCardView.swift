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

    private var view: PlanCard { current ?? card }
    private var me: PlanCardParticipant? { view.participant(ownAccountId) }
    private var canRespond: Bool { me != nil && view.state != .canceled && onAction != nil }
    private var canConfirm: Bool { (me?.organizer ?? false) && view.state == .awaitingConfirmation && onAction != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(view.state.label.uppercased())
                    .font(.system(size: 10.5, weight: .semibold))
                    .tracking(0.4)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(stateTint.opacity(0.16), in: Capsule())
                    .foregroundStyle(stateTint)
                Spacer(minLength: 0)
                if view.state == .confirmed, !view.participants.isEmpty {
                    Text("\(view.goingCount) going")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }
            Text(view.title)
                .font(.system(size: 15, weight: .semibold))
                .strikethrough(view.state == .canceled)
                .foregroundStyle(view.state == .canceled ? .secondary : .primary)
                .fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 3) {
                if let when = whenLabel {
                    Label(when, systemImage: "calendar.badge.clock")
                }
                if let location = view.location, !location.isEmpty {
                    Label(location, systemImage: "mappin.and.ellipse")
                }
                if !view.unresolvedFields.isEmpty {
                    Text("unresolved: \(view.unresolvedFields.joined(separator: ", "))")
                        .foregroundStyle(Color(red: 0.71, green: 0.40, blue: 0.05))
                }
            }
            .font(.system(size: 12.5))
            .foregroundStyle(.secondary)
            participantsRow
            if canRespond || canConfirm {
                HStack(spacing: 6) {
                    if canRespond, let accountId = ownAccountId {
                        actionButton("I'm in", systemImage: "checkmark", active: me?.rsvp == .yes) {
                            await perform(.rsvp(view, accountId: accountId, going: true))
                        }
                        actionButton("Can't make it", systemImage: "xmark", active: me?.rsvp == .no) {
                            await perform(.rsvp(view, accountId: accountId, going: false))
                        }
                    }
                    if canConfirm, let accountId = ownAccountId {
                        actionButton("Confirm for everyone", systemImage: nil, active: false, primary: true) {
                            await perform(.confirm(view, accountId: accountId))
                        }
                    }
                }
                .padding(.top, 2)
            }
            if let notice {
                Text(notice)
                    .font(.caption2)
                    .foregroundStyle(.red)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(minWidth: 220, maxWidth: 320, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.primary.opacity(0.08)))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Plan card, \(view.state.label), \(view.title)")
        .onChange(of: card) { _, latest in
            // A newer server snapshot wins over an optimistic local one.
            if let current, latest.revision >= current.revision { self.current = nil }
        }
    }

    private var participantsRow: some View {
        FlowLayout(spacing: 6) {
            ForEach(view.participants) { participant in
                HStack(spacing: 5) {
                    ZStack {
                        Circle()
                            .fill(participant.rsvp == .yes ? Color.green : Color.secondary.opacity(0.18))
                        if participant.rsvp == .no {
                            Circle().strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [3]))
                                .foregroundStyle(.secondary)
                        }
                        Text(initials(participant.displayName))
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(participant.rsvp == .yes ? .white : .primary)
                    }
                    .frame(width: 22, height: 22)
                    Text(participant.displayName)
                        .font(.system(size: 12))
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
            HStack(spacing: 5) {
                if let systemImage { Image(systemName: systemImage).font(.system(size: 11, weight: .semibold)) }
                Text(title)
            }
            .font(.system(size: 12, weight: .medium))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                primary ? Color.accentColor : (active ? Color.accentColor.opacity(0.14) : Color.clear),
                in: RoundedRectangle(cornerRadius: 9, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
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
            notice = "Could not update the plan card."
        }
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
