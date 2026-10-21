import SwiftUI

// Profile controls: Home's switcher, the New profile sheet, and the Rename,
// Edit focus and Delete actions shared by the switcher and the Card screen.

/// Horizontally scrolling chips, one per profile, plus "+". Long-press a
/// chip for Rename, Edit focus and Delete.
struct CommonGroundProfileSwitcher: View {
    @EnvironmentObject private var model: CommonGroundModel
    @State private var creates = false
    @State private var editing: CommonGroundProfileEditTarget?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(model.profiles) { profile in
                    chip(profile)
                }
                Button { creates = true } label: {
                    Image(systemName: "plus")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 36, height: 36)
                        .background(Color(uiColor: .tertiarySystemFill), in: Circle())
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .disabled(model.profiles.count >= 5)
                .accessibilityLabel("New profile")
            }
            .padding(.horizontal, 16)
        }
        .scrollClipDisabled()
        .sheet(isPresented: $creates) {
            CommonGroundNewProfileSheet()
                .environmentObject(model)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .commonGroundProfileEditor($editing)
    }

    private func chip(_ profile: CommonGroundProfileSummary) -> some View {
        let selected = profile.profileId == model.currentProfileID
        return Button {
            Task { await model.selectProfile(profile.profileId) }
        } label: {
            Text(profile.title)
                .font(.subheadline.weight(.medium))
                .lineLimit(1)
                .foregroundStyle(selected ? Color.white : Color.primary)
                .padding(.horizontal, 14)
                .frame(height: 36)
                .background(selected ? AnyShapeStyle(commonGroundTint) : AnyShapeStyle(Color(uiColor: .secondarySystemGroupedBackground)), in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .contextMenu { CommonGroundProfileMenuItems(profile: profile, editing: $editing) }
    }
}

/// What a profile action asks for: a new name, a new focus, or a confirm.
struct CommonGroundProfileEditTarget: Identifiable {
    enum Action { case rename, focus, delete }
    let action: Action
    let profile: CommonGroundProfileSummary
    var id: String { "\(action)|\(profile.profileId)" }
}

struct CommonGroundProfileMenuItems: View {
    let profile: CommonGroundProfileSummary
    @Binding var editing: CommonGroundProfileEditTarget?

    var body: some View {
        Button { editing = .init(action: .rename, profile: profile) } label: { Label("Rename", systemImage: "pencil") }
        Button { editing = .init(action: .focus, profile: profile) } label: { Label("Edit focus", systemImage: "scope") }
        Button(role: .destructive) { editing = .init(action: .delete, profile: profile) } label: { Label("Delete", systemImage: "trash") }
    }
}

extension View {
    /// Presents Rename, Edit focus and Delete for `target`.
    func commonGroundProfileEditor(_ target: Binding<CommonGroundProfileEditTarget?>, onDelete: (() -> Void)? = nil) -> some View {
        modifier(CommonGroundProfileEditor(target: target, onDelete: onDelete))
    }
}

private struct CommonGroundProfileEditor: ViewModifier {
    @EnvironmentObject private var model: CommonGroundModel
    @Binding var target: CommonGroundProfileEditTarget?
    let onDelete: (() -> Void)?
    @State private var text = ""

    private func shows(_ actions: CommonGroundProfileEditTarget.Action...) -> Binding<Bool> {
        Binding(
            get: { target.map { actions.contains($0.action) } ?? false },
            set: { if !$0 { target = nil } }
        )
    }

    func body(content: Content) -> some View {
        content
            .alert(target?.action == .rename ? "Rename profile" : "Edit focus", isPresented: shows(.rename, .focus), presenting: target) { target in
                TextField(target.action == .rename ? "Name" : "Focus", text: $text)
                Button("Save") { save(target) }
                Button("Cancel", role: .cancel) {}
            }
            .confirmationDialog(
                "Delete \(target?.profile.title ?? "profile")?",
                isPresented: shows(.delete),
                titleVisibility: .visible,
                presenting: target
            ) { target in
                Button("Delete", role: .destructive) {
                    Task { if await model.deleteProfile(target.profile.profileId) { onDelete?() } }
                }
            } message: { _ in
                Text("Its card and matches go too.")
            }
            .onChange(of: target?.id) { _, _ in
                guard let target else { return }
                text = target.action == .rename ? target.profile.title : (target.profile.focus ?? "")
            }
    }

    private func save(_ target: CommonGroundProfileEditTarget) {
        let value = text
        Task {
            if target.action == .rename {
                await model.updateProfile(target.profile.profileId, name: value)
            } else {
                await model.updateProfile(target.profile.profileId, focus: value)
            }
        }
    }
}

/// Kind, a name for a custom profile, and an optional focus line.
struct CommonGroundNewProfileSheet: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Environment(\.dismiss) private var dismiss
    @State private var kind: CommonGroundProfileKind?
    @State private var name = ""
    @State private var focus = ""
    @State private var error: String?

    private var draft: CommonGroundNewProfile? {
        kind.map { CommonGroundNewProfile(kind: $0, name: name, focus: focus) }
    }

    var body: some View {
        VStack(spacing: 0) {
            Text("New profile")
                .font(.headline)
                .padding(.top, 22)
            SettingsPage {
                SettingsSectionTitle("Kind")
                ForEach(Array(CommonGroundProfileKind.allCases.enumerated()), id: \.element) { index, option in
                    if index > 0 { Divider() }
                    kindRow(option)
                }
                if kind == .custom {
                    SettingsDivider()
                    SettingsSectionTitle("Name")
                    TextField("Such as a lab or team", text: $name)
                        .font(.subheadline)
                        .frame(minHeight: SettingsMetrics.rowMinHeight)
                }
                SettingsDivider()
                SettingsSectionTitle("Focus")
                TextField("Optional", text: $focus, axis: .vertical)
                    .font(.subheadline)
                    .lineLimit(1...4)
                    .frame(minHeight: SettingsMetrics.rowMinHeight)
                if let error { SettingsErrorLabel(error) }
            }
            Button("Create") { Task { await create() } }
                .buttonStyle(CommonGroundPrimaryButtonStyle())
                .disabled(draft?.isValid != true || model.busy == "profile")
                .padding(.horizontal, 20)
                .padding(.bottom, 8)
        }
        .background(Color(uiColor: .systemBackground))
        .onAppear { kind = CommonGroundProfileKind.allCases.first(where: model.canCreate) }
    }

    private func kindRow(_ option: CommonGroundProfileKind) -> some View {
        let enabled = model.canCreate(option)
        return Button { kind = option } label: {
            SettingsRow {
                Text(option.title)
                    .font(.subheadline)
                    .foregroundStyle(enabled ? Color.primary : Color.secondary)
            } trailing: {
                if kind == option {
                    Image(systemName: "checkmark").font(.subheadline.weight(.semibold)).foregroundStyle(commonGroundTint)
                }
            }
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityAddTraits(kind == option ? .isSelected : [])
    }

    private func create() async {
        guard let draft else { return }
        error = nil
        if await model.createProfile(draft) != nil {
            dismiss()
        } else {
            // The sheet covers the toast, so the error shows here.
            error = model.notice
            model.notice = nil
        }
    }
}
