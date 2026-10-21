import PhotosUI
import SwiftUI
import UIKit

/// The "Edit profile" screen: banner, avatar, and a flat table of rows.
struct ProfileSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var callCoordinator: KordiCallCoordinator
    @State private var draft = ProfileDraft()
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var avatarDraft: String?
    @State private var avatarMutation: CanonicalAvatarMutation?
    @State private var isSaving = false
    @State private var didLoad = false
    @State private var isVerifyingEmail: Bool
    @State private var isChoosingAvatar = false
    @State private var isPickingPhoto = false
    @State private var isPickingTimeZone = false
    @State private var isEditingBirthday = false

    private static let labelWidth: CGFloat = 96
    private static let avatarSize: CGFloat = 80
    private static let avatarRing: CGFloat = 4
    private static let bannerHeight: CGFloat = 120

    init(openingEmailVerification: Bool = false) {
        _isVerifyingEmail = State(initialValue: openingEmailVerification)
    }

    private var savedDraft: ProfileDraft { ProfileDraft(account: model.account) }

    private var canSave: Bool {
        !isSaving
            && !draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (avatarMutation != nil || draft.hasChanges(from: savedDraft))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                table
                    .padding(.top, 16)
                if let error = model.errorMessage.nonEmpty {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(KordiTheme.destructiveText)
                        .padding(.horizontal, 16)
                        .padding(.top, 10)
                        .accessibilityIdentifier("profile-error")
                }
                signOutRow
                    .padding(.top, 24)
            }
            .padding(.bottom, 32)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Self.pageBackground.ignoresSafeArea())
        .navigationTitle("Edit profile")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") {
                    model.profileFieldError = nil
                    dismiss()
                }
                .tint(.primary)
            }
            ToolbarItem(placement: .confirmationAction) {
                if isSaving {
                    ProgressView()
                } else {
                    Button("Save") { Task { await save() } }
                        .fontWeight(.semibold)
                        .tint(KordiTheme.profileAccent)
                        .disabled(!canSave)
                        .accessibilityIdentifier("profile-save")
                }
            }
        }
        .navigationDestination(isPresented: $isPickingTimeZone) {
            TimeZonePickerView(selection: $draft.timeZone)
        }
        .confirmationDialog("Profile photo", isPresented: $isChoosingAvatar, titleVisibility: .hidden) {
            Button("Upload photo") { isPickingPhoto = true }
            Button("Random avatar") { updateGeneratedAvatarPreview() }
        }
        .photosPicker(isPresented: $isPickingPhoto, selection: $selectedPhoto, matching: .images)
        .sheet(isPresented: $isVerifyingEmail) {
            AccountEmailVerificationSheet(email: model.account?.primaryEmail.nonEmpty ?? "")
                .environmentObject(model)
        }
        .onAppear { loadOnce() }
        .onChange(of: selectedPhoto) { _, item in
            guard let item else { return }
            Task { await loadAvatar(item) }
        }
        .onChange(of: draft) { old, new in
            if let error = model.profileFieldError, old.value(for: error.field) != new.value(for: error.field) {
                model.profileFieldError = nil
            }
        }
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 0) {
            banner
                .frame(height: Self.bannerHeight)
                .frame(maxWidth: .infinity)
            Button { isChoosingAvatar = true } label: { avatar }
                .buttonStyle(.plain)
                .disabled(isSaving)
                .padding(.leading, 16 - Self.avatarRing)
                .padding(.top, -(Self.avatarSize / 2 + Self.avatarRing))
                .accessibilityLabel("Change profile photo")
                .accessibilityIdentifier("profile-avatar")
        }
    }

    private var banner: some View {
        let hue = ProfileFormatting.bannerHue(seed: model.account?.avatar.seed ?? model.account?.accountId ?? "kordi")
        return LinearGradient(
            colors: [Self.bannerColor(hue: hue, stop: 0), Self.bannerColor(hue: hue, stop: 1)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
        .accessibilityHidden(true)
    }

    private var avatar: some View {
        ZStack {
            IdentityAvatar(
                name: draft.name.nonEmpty ?? model.account?.preferredName ?? "Me",
                imageSource: avatarDraft?.nonEmpty ?? model.account?.avatar.imageSource,
                kind: .person,
                size: Self.avatarSize,
                seed: model.account?.accountId,
                cornerRadius: Self.avatarSize / 2,
                showsInitials: false
            )
            Circle().fill(Color.black.opacity(0.45))
            Image(systemName: "camera")
                .font(.system(size: 22))
                .foregroundStyle(.white)
        }
        .frame(width: Self.avatarSize, height: Self.avatarSize)
        .clipShape(Circle())
        .padding(Self.avatarRing)
        .background(Circle().fill(Self.pageBackground))
    }

    // MARK: Table

    private var table: some View {
        VStack(alignment: .leading, spacing: 0) {
            Divider()
            row("Name") {
                TextField("Name", text: $draft.name, prompt: placeholder("Name"))
                    .textContentType(.name)
                    .autocorrectionDisabled()
                    .foregroundStyle(KordiTheme.profileAccent)
            }
            kordiIdRow
            row("About", field: .about, alignment: .top) {
                TextField("About", text: capped(\.about, ProfileDraft.aboutLimit), prompt: placeholder("Add a bio"), axis: .vertical)
                    .lineLimit(1...4)
                    .foregroundStyle(valueColor(.about))
            }
            row("Location", field: .location) {
                TextField("Location", text: capped(\.location, ProfileDraft.locationLimit), prompt: placeholder("Add your location"))
                    .textContentType(.addressCityAndState)
                    .foregroundStyle(valueColor(.location))
            }
            timeZoneRow
            row("Website", field: .website) {
                TextField("Website", text: capped(\.website, ProfileDraft.websiteLimit), prompt: placeholder("Add your website"))
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .foregroundStyle(valueColor(.website))
            }
            birthdayRow
            emailRow
        }
    }

    @ViewBuilder
    private var kordiIdRow: some View {
        if let lockedUntil = ProfileFormatting.kordiIdLockedUntil(model.account?.kordiIdChangeAvailableAt) {
            // Changed within the last year: read-only until the date shown.
            row("Kordi ID", field: .kordiId) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("@\(model.account?.kordiId?.nonEmpty ?? model.account?.accountNumber ?? "")")
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Text(ProfileFormatting.kordiIdUnlockCaption(lockedUntil))
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("profile-kordi-id-locked")
            }
        } else {
            editableKordiIdRow
        }
    }

    private var editableKordiIdRow: some View {
        row("Kordi ID", field: .kordiId) {
            HStack(spacing: 0) {
                Text("@").foregroundStyle(.secondary)
                TextField(
                    "Kordi ID",
                    text: Binding(
                        get: { draft.kordiId },
                        set: { draft.kordiId = ProfileDraft.sanitizedKordiId($0) }
                    ),
                    prompt: placeholder(model.account?.accountNumber?.nonEmpty ?? ProfileDraft.accountNumber(model.account?.kordiId) ?? "Account number")
                )
                .keyboardType(.asciiCapable)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textContentType(.username)
                .foregroundStyle(valueColor(.kordiId))
                .accessibilityIdentifier("profile-kordi-id")
            }
        }
    }

    private var timeZoneRow: some View {
        Button { isPickingTimeZone = true } label: {
            row("Time zone", field: .timeZone) {
                HStack(spacing: 8) {
                    if let label = ProfileFormatting.timeZoneLabel(draft.timeZone) {
                        Text(label).foregroundStyle(valueColor(.timeZone))
                    } else {
                        Text("Automatic").foregroundStyle(.tertiary)
                    }
                    Spacer(minLength: 0)
                    SettingsChevron()
                }
                .multilineTextAlignment(.leading)
                .contentShape(Rectangle())
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("profile-time-zone")
    }

    private var birthdayRow: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                if draft.birthday.isEmpty {
                    draft.birthday = ProfileFormatting.birthdayString(ProfileFormatting.defaultBirthday)
                    isEditingBirthday = true
                } else {
                    withAnimation(.easeOut(duration: 0.2)) { isEditingBirthday.toggle() }
                }
            } label: {
                row("Birthday", field: .birthday, divider: !isEditingBirthday) {
                    HStack {
                        if let label = ProfileFormatting.birthdayLabel(draft.birthday) {
                            Text(label).foregroundStyle(valueColor(.birthday))
                        } else {
                            Text("Add your birthday").foregroundStyle(.tertiary)
                        }
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
            }
            .buttonStyle(.plain)
            .contextMenu {
                if !draft.birthday.isEmpty {
                    Button("Clear", role: .destructive) { clearBirthday() }
                }
            }
            .accessibilityIdentifier("profile-birthday")

            if isEditingBirthday {
                VStack(alignment: .trailing, spacing: 0) {
                    DatePicker(
                        "Birthday",
                        selection: Binding(
                            get: { ProfileFormatting.birthdayDate(draft.birthday) ?? ProfileFormatting.defaultBirthday },
                            set: { draft.birthday = ProfileFormatting.birthdayString($0) }
                        ),
                        in: ProfileFormatting.birthdayRange,
                        displayedComponents: .date
                    )
                    .datePickerStyle(.wheel)
                    .labelsHidden()
                    .environment(\.timeZone, ProfileFormatting.calendar.timeZone)
                    .environment(\.calendar, ProfileFormatting.calendar)
                    .frame(maxWidth: .infinity)
                    Button("Clear") { clearBirthday() }
                        .font(.subheadline)
                        .foregroundStyle(KordiTheme.destructiveText)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 8)
                }
                Divider()
            }
        }
    }

    private var emailRow: some View {
        // No hairline here: the Sign out row brings its own after a 24pt gap.
        row("Email", divider: false) {
            VStack(alignment: .leading, spacing: 4) {
                Text(model.account?.primaryEmail.nonEmpty ?? "")
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if model.account?.primaryEmailVerified == false {
                    HStack(spacing: 12) {
                        AccountEmailVerificationStatus(verified: false)
                        Button("Verify") {
                            model.errorMessage = nil
                            isVerifyingEmail = true
                        }
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(KordiTheme.profileAccent)
                        .accessibilityIdentifier("profile-verify-email")
                    }
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("profile-email")
        }
    }

    private var signOutRow: some View {
        VStack(spacing: 0) {
            Divider()
            Button {
                Task {
                    await callCoordinator.prepareForAccountTeardown()
                    await model.signOut()
                }
            } label: {
                Text("Sign out")
                    .foregroundStyle(KordiTheme.destructiveText)
                    .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
                    .padding(.horizontal, 16)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Divider()
        }
    }

    // MARK: Row building

    private func row<Value: View>(
        _ label: String,
        field: ProfileField? = nil,
        alignment: VerticalAlignment = .firstTextBaseline,
        divider: Bool = true,
        @ViewBuilder value: () -> Value
    ) -> some View {
        VStack(spacing: 0) {
            HStack(alignment: alignment, spacing: 0) {
                Text(label)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.primary)
                    .frame(width: Self.labelWidth, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                VStack(alignment: .leading, spacing: 4) {
                    value()
                    if let field, let error = model.profileFieldError, error.field == field {
                        Text(error.message)
                            .font(.system(size: 13))
                            .foregroundStyle(KordiTheme.destructiveText)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("profile-field-error")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .frame(minHeight: 52)
            if divider { Divider() }
        }
    }

    /// Uses the system placeholder colour, the text field's tertiary tone.
    private func placeholder(_ text: String) -> Text {
        Text(text).foregroundStyle(Color(uiColor: .placeholderText))
    }

    private func valueColor(_ field: ProfileField) -> Color {
        model.profileFieldError?.field == field ? KordiTheme.destructiveText : KordiTheme.profileAccent
    }

    private func capped(_ keyPath: WritableKeyPath<ProfileDraft, String>, _ limit: Int) -> Binding<String> {
        Binding(
            get: { draft[keyPath: keyPath] },
            set: { draft[keyPath: keyPath] = ProfileDraft.capped($0, limit) }
        )
    }

    private func clearBirthday() {
        withAnimation(.easeOut(duration: 0.2)) {
            isEditingBirthday = false
            draft.birthday = ""
        }
    }

    // MARK: Colours

    /// Black in dark mode, white in light mode, also inside sheets.
    private static let pageBackground = Color(
        uiColor: UIColor { $0.userInterfaceStyle == .dark ? .black : .white }
    )

    private static func bannerColor(hue: Double, stop: Int) -> Color {
        let shifted = (hue + Double(stop) * 0.014).truncatingRemainder(dividingBy: 1)
        return Color(
            uiColor: UIColor { traits in
                traits.userInterfaceStyle == .dark
                    ? UIColor(hue: shifted, saturation: 0.32, brightness: stop == 0 ? 0.25 : 0.18, alpha: 1)
                    : UIColor(hue: shifted, saturation: stop == 0 ? 0.10 : 0.15, brightness: stop == 0 ? 0.94 : 0.90, alpha: 1)
            }
        )
    }

    // MARK: Loading and saving

    private func loadOnce() {
        guard !didLoad else { return }
        didLoad = true
        draft = savedDraft
        avatarDraft = model.account?.avatar.imageSource
        avatarMutation = nil
        model.errorMessage = nil
        model.profileFieldError = nil
    }

    private func loadAvatar(_ item: PhotosPickerItem) async {
        guard let data = try? await item.loadTransferable(type: Data.self),
              let prepared = SignupAvatarRenderer.uploadedImage(from: data) else {
            model.errorMessage = "Choose a supported photo up to 2 MiB."
            return
        }
        avatarDraft = prepared.dataURL
        avatarMutation = .upload(
            prepared.dataURL,
            expectedVersion: model.account?.avatar.version
        )
        model.errorMessage = nil
    }

    private func save() async {
        guard canSave else { return }
        isSaving = true
        defer { isSaving = false }
        let changes = draft.changes(from: savedDraft)
        let saved = await model.updateProfile(
            displayName: draft.name,
            avatarMutation: avatarMutation,
            kordiId: changes.kordiId,
            details: changes.details
        )
        guard saved else { return }
        avatarMutation = nil
        selectedPhoto = nil
        isEditingBirthday = false
        draft = savedDraft
    }

    private func updateGeneratedAvatarPreview() {
        guard let account = model.account else { return }
        let seed = CanonicalAvatarSystem.newSeed()
        guard let previewURL = CanonicalAvatarSystem.previewURL(
            style: account.avatar.style,
            seed: seed
        ) else { return }
        avatarDraft = previewURL.absoluteString
        avatarMutation = .regenerate(
            seed: seed,
            expectedVersion: account.avatar.version
        )
        model.errorMessage = nil
    }
}

/// Searchable list of time zones; "Automatic" clears the choice.
private struct TimeZonePickerView: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var selection: String
    @State private var query = ""

    private struct Zone: Identifiable {
        let id: String
        let name: String
        let offset: String
    }

    private static let zones: [Zone] = TimeZone.knownTimeZoneIdentifiers.compactMap { identifier in
        guard let zone = TimeZone(identifier: identifier) else { return nil }
        return Zone(id: identifier, name: ProfileFormatting.timeZoneName(zone), offset: ProfileFormatting.gmtOffset(zone))
    }

    private var filtered: [Zone] {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return Self.zones }
        return Self.zones.filter {
            $0.id.localizedCaseInsensitiveContains(text)
                || $0.name.localizedCaseInsensitiveContains(text)
                || $0.offset.localizedCaseInsensitiveContains(text)
        }
    }

    var body: some View {
        List {
            if query.isEmpty {
                choice(id: "", selected: selection.isEmpty) {
                    Text("Automatic")
                }
            }
            ForEach(filtered) { zone in
                choice(id: zone.id, selected: selection == zone.id) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(zone.name), \(zone.offset)")
                        Text(zone.id)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .listStyle(.plain)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always))
        .navigationTitle("Time zone")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func choice<Label: View>(id: String, selected: Bool, @ViewBuilder label: () -> Label) -> some View {
        Button {
            selection = id
            dismiss()
        } label: {
            HStack {
                label()
                Spacer(minLength: 8)
                if selected {
                    Image(systemName: "checkmark")
                        .foregroundStyle(KordiTheme.profileAccent)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
