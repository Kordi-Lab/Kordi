import LiveKit
import SwiftUI

struct KordiCallView: View {
    @EnvironmentObject private var coordinator: KordiCallCoordinator
    @ObservedObject var room: Room

    private var presentation: KordiCallPresentation? { coordinator.activeCall }

    var body: some View {
        ZStack {
            CallBackdrop(
                color: presentation?.conversation.kind == .group
                    ? KordiTheme.signalBlue
                    : Color.indigo
            )

            if let presentation {
                VStack(spacing: 0) {
                    CallTopBar(
                        title: presentation.call.kind == .meeting ? "Kordi meeting" : "Kordi call",
                        onMinimize: coordinator.minimize
                    )

                    CallParticipantStage(
                        presentation: presentation,
                        room: room,
                        previewVideoTrack: coordinator.previewVideoTrack,
                        isPreviewCameraEnabled: coordinator.isCameraEnabled
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity)

                    CallIdentitySection(
                        name: presentation.conversation.displayName,
                        phase: coordinator.phase,
                        connectedAt: coordinator.connectedAt
                    )
                    .padding(.bottom, 24)

                    Group {
                        if coordinator.isAwaitingIncomingAnswer {
                            IncomingCallControlDeck(
                                onDecline: { Task { await coordinator.declineIncomingCall() } },
                                onAnswer: { Task { await coordinator.answerIncomingCall() } }
                            )
                        } else {
                            CallControlDeck(
                                isMicrophoneEnabled: coordinator.isMicrophoneEnabled,
                                isCameraEnabled: coordinator.isCameraEnabled,
                                allowsVideo: presentation.call.kind.allowsVideo,
                                onMicrophone: {
                                    Task {
                                        await coordinator.setMicrophoneEnabled(!coordinator.isMicrophoneEnabled)
                                    }
                                },
                                onCamera: {
                                    Task {
                                        await coordinator.setCameraEnabled(!coordinator.isCameraEnabled)
                                    }
                                },
                                onParticipants: { coordinator.isParticipantListPresented = true },
                                onLeave: { Task { await coordinator.leave() } }
                            )
                        }
                    }
                    .padding(.bottom, 28)
                }
            }
        }
        .preferredColorScheme(.dark)
        .interactiveDismissDisabled()
        .sheet(isPresented: $coordinator.isParticipantListPresented) {
            if let presentation {
                CallParticipantList(
                    call: presentation.call,
                    room: room,
                    conversationName: presentation.conversation.displayName
                )
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
            }
        }
    }
}

private struct CallParticipantStage: View {
    let presentation: KordiCallPresentation
    @ObservedObject var room: Room
    let previewVideoTrack: LocalVideoTrack?
    let isPreviewCameraEnabled: Bool

    var body: some View {
        if presentation.isPreview {
            PreviewCallParticipantStage(
                presentation: presentation,
                videoTrack: previewVideoTrack,
                isCameraEnabled: isPreviewCameraEnabled
            )
        } else {
            LiveCallParticipantStage(presentation: presentation, room: room)
        }
    }
}

private struct PreviewCallParticipantStage: View {
    let presentation: KordiCallPresentation
    let videoTrack: LocalVideoTrack?
    let isCameraEnabled: Bool
    private let remoteParticipants: [CloudCallParticipant]

    init(
        presentation: KordiCallPresentation,
        videoTrack: LocalVideoTrack?,
        isCameraEnabled: Bool
    ) {
        self.presentation = presentation
        self.videoTrack = videoTrack
        self.isCameraEnabled = isCameraEnabled
        remoteParticipants = presentation.call.participants.filter {
            $0.accountId != presentation.call.createdByAccountId
        }
    }

    var body: some View {
        if presentation.call.kind == .meeting {
            ScrollView {
                LazyVGrid(
                    columns: [
                        GridItem(.flexible(), spacing: 10),
                        GridItem(.flexible(), spacing: 10),
                    ],
                    spacing: 10
                ) {
                    if isCameraEnabled, let videoTrack {
                        PreviewCameraTile(track: videoTrack)
                            .aspectRatio(0.78, contentMode: .fit)
                    } else {
                        CallPreviewParticipantPlaceholder(
                            name: "You",
                            avatarSource: nil,
                            seed: presentation.call.createdByAccountId
                        )
                        .aspectRatio(0.78, contentMode: .fit)
                    }

                    ForEach(remoteParticipants) { participant in
                        CallPreviewParticipantPlaceholder(
                            name: participant.displayName?.nonEmpty ?? "Participant",
                            avatarSource: participant.avatarUrl,
                            seed: participant.accountId
                        )
                        .aspectRatio(0.78, contentMode: .fit)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
        } else if isCameraEnabled, let videoTrack {
            PreviewCameraTile(track: videoTrack)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
        } else {
            CallWaitingStage(
                conversation: presentation.conversation,
                participants: presentation.call.participants,
                isPreview: true
            )
            .padding(.horizontal, 24)
        }
    }
}

private struct LiveCallParticipantStage: View {
    let presentation: KordiCallPresentation
    @ObservedObject var room: Room

    private var participants: [CallRoomParticipantItem] {
        CallRoomParticipantItem.make(from: room)
    }

    var body: some View {
        let participantItems = participants
        if presentation.call.kind == .voice || participantItems.isEmpty {
            CallWaitingStage(
                conversation: presentation.conversation,
                participants: presentation.call.participants,
                isPreview: false
            )
            .padding(.horizontal, 24)
        } else if presentation.call.kind != .meeting,
                  let remote = participantItems.first(where: { !$0.isLocal }) {
            DirectCallParticipantStage(
                remote: remote,
                local: participantItems.first(where: { $0.isLocal })
            )
        } else {
            GroupCallParticipantGrid(participants: participantItems)
        }
    }
}

private struct DirectCallParticipantStage: View {
    let remote: CallRoomParticipantItem
    let local: CallRoomParticipantItem?

    var body: some View {
        ZStack(alignment: .topTrailing) {
            LiveCallParticipantTile(item: remote)
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            if let local {
                LiveCallParticipantTile(item: local)
                    .frame(width: 112, height: 158)
                    .shadow(color: .black.opacity(0.34), radius: 14, y: 7)
                    .padding(14)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}

private struct GroupCallParticipantGrid: View {
    let participants: [CallRoomParticipantItem]

    private var columns: [GridItem] {
        participants.count == 1
            ? [GridItem(.flexible())]
            : [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]
    }

    var body: some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 10) {
                ForEach(participants) { item in
                    LiveCallParticipantTile(item: item)
                        .aspectRatio(participants.count == 1 ? 0.82 : 0.78, contentMode: .fit)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
    }
}

private struct PreviewCameraTile: View {
    let track: LocalVideoTrack

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            SwiftUIVideoView(track, layoutMode: .fill)

            Label("You", systemImage: "video.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(.black.opacity(0.48), in: Capsule())
                .padding(12)
        }
        .compositingGroup()
        .clipShape(.rect(cornerRadius: 24))
        .overlay {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(.white.opacity(0.12), lineWidth: 1)
        }
        .aspectRatio(0.82, contentMode: .fit)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Your camera preview")
    }
}

private struct CallPreviewParticipantPlaceholder: View {
    let name: String
    let avatarSource: String?
    let seed: String

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(.black.opacity(0.28))

            IdentityAvatar(
                name: name,
                imageSource: avatarSource,
                kind: .person,
                size: 76,
                seed: seed
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            HStack(spacing: 6) {
                Image(systemName: "video.slash.fill")
                    .font(.caption)
                Text(name)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(.black.opacity(0.48), in: Capsule())
            .padding(10)
        }
        .compositingGroup()
        .clipShape(.rect(cornerRadius: 24))
        .overlay {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(.white.opacity(0.08), lineWidth: 1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(name), camera off")
    }
}

private struct CallBackdrop: View {
    let color: Color

    var body: some View {
        LinearGradient(
            colors: [color.opacity(0.88), color.opacity(0.48), Color.black],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
        .overlay {
            Circle()
                .fill(.white.opacity(0.09))
                .frame(width: 320, height: 320)
                .blur(radius: 50)
                .offset(x: 150, y: -260)
        }
        .ignoresSafeArea()
    }
}

private struct CallTopBar: View {
    let title: String
    let onMinimize: () -> Void

    var body: some View {
        HStack {
            Button(action: onMinimize) {
                Image(systemName: "chevron.down")
                    .font(.headline.weight(.bold))
                    .frame(width: 44, height: 44)
                    .background(.black.opacity(0.22), in: Circle())
            }
            .accessibilityLabel("Minimize call")

            Spacer()

            Text(title)
                .font(.subheadline.weight(.semibold))

            Spacer()

            Color.clear.frame(width: 44, height: 44)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }
}

private struct CallIdentitySection: View {
    let name: String
    let phase: KordiCallPhase
    let connectedAt: Date?

    var body: some View {
        VStack(spacing: 5) {
            Text(name)
                .font(.title2.weight(.bold))
                .lineLimit(1)
            if let connectedAt, phase == .connected {
                TimelineView(.periodic(from: connectedAt, by: 1)) { context in
                    Text(CallDurationFormatter.string(from: connectedAt, to: context.date))
                        .monospacedDigit()
                }
                .font(.subheadline)
                .foregroundStyle(.white.opacity(0.72))
            } else {
                Label(
                    phase.label,
                    systemImage: phase == .reconnecting
                        ? "arrow.triangle.2.circlepath"
                        : "waveform"
                )
                .font(.subheadline)
                .foregroundStyle(phase.isFailure ? Color.red.opacity(0.9) : .white.opacity(0.72))
            }
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 24)
    }
}

private extension KordiCallPhase {
    var isFailure: Bool {
        if case .failed = self { return true }
        return false
    }
}

private enum CallDurationFormatter {
    static func string(from start: Date, to end: Date) -> String {
        let seconds = max(0, Int(end.timeIntervalSince(start)))
        return String(format: "%02d:%02d", seconds / 60, seconds % 60)
    }
}

private struct CallControlDeck: View {
    let isMicrophoneEnabled: Bool
    let isCameraEnabled: Bool
    let allowsVideo: Bool
    let onMicrophone: () -> Void
    let onCamera: () -> Void
    let onParticipants: () -> Void
    let onLeave: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            CallControlButton(
                label: isMicrophoneEnabled ? "Mute" : "Unmute",
                symbol: isMicrophoneEnabled ? "mic.fill" : "mic.slash.fill",
                isSelected: !isMicrophoneEnabled,
                action: onMicrophone
            )

            if allowsVideo {
                CallControlButton(
                    label: isCameraEnabled ? "Camera" : "Camera off",
                    symbol: isCameraEnabled ? "video.fill" : "video.slash.fill",
                    isSelected: !isCameraEnabled,
                    action: onCamera
                )
            }

            CallAudioRouteControl()

            CallControlButton(
                label: "People",
                symbol: "person.2.fill",
                isSelected: false,
                action: onParticipants
            )

            CallControlButton(
                label: "Leave",
                symbol: "phone.down.fill",
                isSelected: true,
                tint: .red,
                action: onLeave
            )
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity)
        .background(.black.opacity(0.32), in: .rect(cornerRadius: 36))
        .overlay {
            RoundedRectangle(cornerRadius: 36, style: .continuous)
                .stroke(.white.opacity(0.08), lineWidth: 1)
        }
        .padding(.horizontal, 12)
    }
}

private struct IncomingCallControlDeck: View {
    let onDecline: () -> Void
    let onAnswer: () -> Void

    var body: some View {
        HStack(spacing: 52) {
            CallControlButton(
                label: "Decline",
                symbol: "phone.down.fill",
                isSelected: true,
                tint: .red,
                action: onDecline
            )
            CallControlButton(
                label: "Answer",
                symbol: "phone.fill",
                isSelected: true,
                tint: .green,
                action: onAnswer
            )
        }
        .padding(.horizontal, 32)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity)
        .background(.black.opacity(0.32), in: .rect(cornerRadius: 36))
        .overlay {
            RoundedRectangle(cornerRadius: 36, style: .continuous)
                .stroke(.white.opacity(0.08), lineWidth: 1)
        }
        .padding(.horizontal, 28)
    }
}

private struct CallControlButton: View {
    let label: String
    let symbol: String
    let isSelected: Bool
    var tint: Color = .orange
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 7) {
                Image(systemName: symbol)
                    .font(.title3.weight(.semibold))
                    .frame(width: 54, height: 54)
                    .background(
                        isSelected ? tint.opacity(0.88) : Color.white.opacity(0.13),
                        in: Circle()
                    )
                Text(label)
                    .font(.caption2.weight(.medium))
                    .lineLimit(1)
            }
            .foregroundStyle(.white)
        }
        .buttonStyle(.plain)
        .frame(maxWidth: 62)
        .accessibilityLabel(label)
    }
}

private struct CallAudioRouteControl: View {
    var body: some View {
        VStack(spacing: 7) {
            SwiftUIAudioRoutePickerButton()
                .frame(width: 54, height: 54)
                .background(Color.white.opacity(0.13), in: Circle())
                .tint(.white)
            Text("Audio")
                .font(.caption2.weight(.medium))
                .foregroundStyle(.white)
        }
        .frame(maxWidth: 62)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Choose audio output")
    }
}

private struct CallWaitingStage: View {
    let conversation: ConversationSummary
    let participants: [CloudCallParticipant]
    let isPreview: Bool

    var body: some View {
        VStack(spacing: 22) {
            if conversation.kind == .group {
                GroupAvatarStack(participants: conversation.groupParticipants, size: 132)
            } else {
                IdentityAvatar(
                    name: conversation.displayName,
                    imageSource: conversation.avatarSource,
                    kind: .person,
                    size: 132,
                    seed: conversation.peerAccountId
                )
            }

            let joined = participants.filter { $0.state == "joined" }.count
            Text(isPreview || joined > 1 ? "Everyone is connected" : "Waiting for others to join")
                .font(.headline)
                .foregroundStyle(.white.opacity(0.82))
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct CallRoomParticipantItem: Identifiable {
    let id: String
    let participant: Participant
    let isLocal: Bool

    static func make(from room: Room) -> [CallRoomParticipantItem] {
        var result: [CallRoomParticipantItem] = []
        let local = room.localParticipant
        if let identity = local.identity?.stringValue {
            result.append(CallRoomParticipantItem(id: identity, participant: local, isLocal: true))
        }
        result += room.remoteParticipants.values.compactMap { participant in
            guard let identity = participant.identity?.stringValue else { return nil }
            return CallRoomParticipantItem(id: identity, participant: participant, isLocal: false)
        }
        return result.sorted {
            if $0.isLocal != $1.isLocal { return $0.isLocal }
            let leftDate = $0.participant.joinedAt ?? .distantPast
            let rightDate = $1.participant.joinedAt ?? .distantPast
            if leftDate != rightDate { return leftDate < rightDate }
            return $0.id < $1.id
        }
    }
}

private struct LiveCallParticipantTile: View {
    let item: CallRoomParticipantItem
    @ObservedObject private var participant: Participant

    init(item: CallRoomParticipantItem) {
        self.item = item
        participant = item.participant
    }

    private var videoTrack: VideoTrack? {
        participant.firstCameraVideoTrack
            ?? participant.firstCameraPublication?.track as? VideoTrack
    }

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(.black.opacity(0.28))

            if let videoTrack {
                SwiftUIVideoView(videoTrack, layoutMode: .fill)
            } else {
                IdentityAvatar(
                    name: participant.name?.nonEmpty ?? item.id,
                    imageSource: nil,
                    kind: .person,
                    size: 92,
                    seed: item.id
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }

            HStack(spacing: 6) {
                if participant.firstAudioPublication?.isMuted != false {
                    Image(systemName: "mic.slash.fill")
                        .font(.caption)
                }
                Text(item.isLocal ? "You" : participant.name?.nonEmpty ?? item.id)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(.black.opacity(0.48), in: Capsule())
            .padding(10)
        }
        .compositingGroup()
        .clipShape(.rect(cornerRadius: 24))
        .overlay {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(participant.isSpeaking ? Color.green : .white.opacity(0.08), lineWidth: 2)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(item.isLocal ? "You" : participant.name?.nonEmpty ?? item.id)
    }
}

private struct CallParticipantList: View {
    @EnvironmentObject private var coordinator: KordiCallCoordinator
    let call: CloudCall
    @ObservedObject var room: Room
    let conversationName: String
    @State private var isInviting = false
    @State private var invitationNotice: String?

    private var liveParticipants: [CallRoomParticipantItem] {
        CallRoomParticipantItem.make(from: room)
    }

    private var displayedCall: CloudCall {
        coordinator.activeCall?.call ?? call
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if liveParticipants.isEmpty {
                        ForEach(displayedCall.participants) { participant in
                            participantRow(
                                name: participant.displayName?.nonEmpty ?? participant.accountId,
                                state: participant.state,
                                isSpeaking: false
                            )
                        }
                    } else {
                        ForEach(liveParticipants) { item in
                            participantRow(
                                name: item.isLocal
                                    ? "You"
                                    : item.participant.name?.nonEmpty ?? item.id,
                                state: "joined",
                                isSpeaking: item.participant.isSpeaking
                            )
                        }
                    }
                } header: {
                    Text("In \(conversationName)")
                } footer: {
                    Text("Conversation members are invited automatically when a meeting starts.")
                }
            }
            .navigationTitle("Participants")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if displayedCall.kind == .meeting {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            Task { await inviteConversationMembers() }
                        } label: {
                            if isInviting {
                                ProgressView()
                            } else {
                                Label("Invite", systemImage: "person.badge.plus")
                            }
                        }
                        .disabled(isInviting)
                    }
                }
            }
            .alert(
                "Meeting invitation",
                isPresented: Binding(
                    get: { invitationNotice != nil },
                    set: { if !$0 { invitationNotice = nil } }
                )
            ) {
                Button("OK", role: .cancel) { invitationNotice = nil }
            } message: {
                Text(invitationNotice ?? "")
            }
        }
    }

    private func inviteConversationMembers() async {
        isInviting = true
        defer { isInviting = false }
        do {
            try await coordinator.inviteParticipants()
            invitationNotice = "Conversation members who are not connected were invited again."
        } catch {
            invitationNotice = error.localizedDescription
        }
    }

    private func participantRow(name: String, state: String, isSpeaking: Bool) -> some View {
        HStack(spacing: 12) {
            IdentityAvatar(name: name, imageSource: nil, kind: .person, size: 40, seed: name)
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(.body.weight(.medium))
                Text(state.capitalized).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if isSpeaking {
                Image(systemName: "waveform")
                    .foregroundStyle(.green)
                    .accessibilityLabel("Speaking")
            }
        }
    }
}
