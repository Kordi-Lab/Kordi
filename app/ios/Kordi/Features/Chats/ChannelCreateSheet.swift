import SwiftUI

struct ChannelCreateSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @FocusState private var nameFocused: Bool
    @State private var name = ""
    @State private var isCreating = false
    @State private var error: String?
    @State private var creationAttempt: ChannelCreationAttempt?
    let space: GroupSpaceSummary
    let onCreated: (ConversationSummary) -> Void

    var body: some View {
        ZStack {
            Color.black.opacity(0.3).ignoresSafeArea()

            VStack(spacing: 18) {
                VStack(spacing: 6) {
                    Text("Create channel")
                        .font(.headline)
                        .accessibilityAddTraits(.isHeader)
                    Text("In \(space.displayName)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }

                TextField("Channel name", text: $name)
                    .textFieldStyle(.roundedBorder)
                    .focused($nameFocused)
                    .submitLabel(.done)
                    .onSubmit { create() }
                    .disabled(isCreating)
                    .accessibilityIdentifier("channel-name")

                if let error {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }

                HStack(spacing: 12) {
                    Button { dismiss() } label: {
                        Text("Cancel").frame(maxWidth: .infinity, minHeight: 28)
                    }
                    .buttonStyle(.bordered)
                    .disabled(isCreating)

                    Button { create() } label: {
                        Text(isCreating ? "Creating…" : "Create")
                            .frame(maxWidth: .infinity, minHeight: 28)
                    }
                    .buttonStyle(.borderedProminent)
                        .disabled(isCreating || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name.count > 200)
                }
            }
            .padding(24)
            .frame(maxWidth: 340)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24))
            .padding(24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .defaultFocus($nameFocused, true)
        .task {
            // Request the keyboard once the modal has finished appearing.
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            nameFocused = true
        }
        .interactiveDismissDisabled(isCreating)
    }

    private func create() {
        let title = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isCreating, !title.isEmpty, title.count <= 200 else { return }
        let attempt = ChannelCreationAttempt(title: title, previous: creationAttempt)
        creationAttempt = attempt
        isCreating = true
        error = nil
        Task {
            if let created = await model.createChannel(in: space, title: attempt.title, sessionID: attempt.sessionID) {
                dismiss()
                onCreated(created)
            } else {
                error = model.errorMessage ?? "Could not create this channel. Try again."
                isCreating = false
            }
        }
    }
}

struct ChannelCreationAttempt {
    let title: String
    let sessionID: String

    init(title: String, previous: ChannelCreationAttempt? = nil) {
        self.title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if let previous, previous.title == self.title {
            sessionID = previous.sessionID
        } else {
            // A previous attempt may already have saved its title on the server.
            sessionID = "session:group:\(UUID().uuidString.lowercased())"
        }
    }
}
