use super::*;

#[test]
fn classifies_package_sources() {
    assert!(matches!(
        classify_package_source("npm:demo"),
        PackageSource::Npm(_)
    ));
    assert!(matches!(
        classify_package_source("git:https://x"),
        PackageSource::Git(_)
    ));
    assert!(matches!(
        classify_package_source("./local"),
        PackageSource::LocalPath(_)
    ));
}

#[test]
fn extension_bootstrap_splits_package_sources_from_paths() {
    let cwd = tempdir().unwrap();
    let bootstrap = ExtensionBootstrap::from_cli_values(
        cwd.path(),
        &[
            "npm:demo-skill".to_string(),
            "./local-ext".to_string(),
            "https://example.com/ext.tgz".to_string(),
        ],
    );

    assert_eq!(
        bootstrap.package_sources,
        vec![
            "npm:demo-skill".to_string(),
            "https://example.com/ext.tgz".to_string(),
        ]
    );
    assert_eq!(bootstrap.paths.len(), 1);
    assert!(bootstrap.paths[0].ends_with("local-ext"));
}

#[test]
fn discovers_package_resources_from_manifest() {
    let cwd = tempdir().unwrap();
    let package_dir = cwd.path().join("demo-package");
    fs::create_dir_all(package_dir.join("pkg-extensions")).unwrap();
    fs::create_dir_all(package_dir.join("pkg-skills")).unwrap();
    fs::create_dir_all(package_dir.join("pkg-prompts")).unwrap();
    fs::write(
        package_dir.join("package.json"),
        r#"{
                "name": "demo-package",
                "kordi": {
                    "extensions": ["./pkg-extensions"],
                    "skills": ["./pkg-skills"],
                    "prompts": ["./pkg-prompts"]
                }
            }"#,
    )
    .unwrap();

    let resources = discover_package_resources(&package_dir, cwd.path()).unwrap();
    assert_eq!(
        resources.extensions,
        vec![normalize_path(package_dir.join("pkg-extensions"))]
    );
    assert_eq!(
        resources.skills,
        vec![normalize_path(package_dir.join("pkg-skills"))]
    );
    assert_eq!(
        resources.prompts,
        vec![normalize_path(package_dir.join("pkg-prompts"))]
    );
}

#[tokio::test]
async fn loads_package_skills_and_prompts_from_settings() {
    let cwd = tempdir().unwrap();
    let package_dir = cwd.path().join("skills-package");
    fs::create_dir_all(package_dir.join("skills/review")).unwrap();
    fs::create_dir_all(package_dir.join("prompts")).unwrap();
    fs::write(
        package_dir.join("package.json"),
        r#"{
                "name": "skills-package",
                "kordi": {
                    "skills": ["./skills"],
                    "prompts": ["./prompts"]
                }
            }"#,
    )
    .unwrap();
    fs::write(
        package_dir.join("skills/review/SKILL.md"),
        "---\nname: package-review\ndescription: package review skill\n---\nReview carefully.",
    )
    .unwrap();
    fs::write(
        package_dir.join("prompts/summarize.md"),
        "Summarize the package state.",
    )
    .unwrap();

    let settings = Settings {
        packages: vec![PackageEntry::Simple(package_dir.display().to_string())],
        ..Settings::default()
    };
    let support =
        load_runtime_extension_support(cwd.path(), &settings, &ExtensionBootstrap::default())
            .await
            .unwrap();

    assert!(
        support
            .session_resources
            .skills
            .iter()
            .any(|skill| skill.info.name == "package-review")
    );
    assert!(
        support
            .session_resources
            .prompts
            .iter()
            .any(|prompt| prompt.info.name == "summarize")
    );
}

#[tokio::test]
async fn bundled_super_collaboration_skill_is_loaded_by_default() {
    let cwd = tempdir().unwrap();
    let settings = Settings::default();

    let support =
        load_runtime_extension_support(cwd.path(), &settings, &ExtensionBootstrap::default())
            .await
            .unwrap();

    let skill = support
        .session_resources
        .skills
        .iter()
        .find(|skill| skill.info.name == "super-collaboration")
        .expect("super-collaboration bundled skill should load by default");

    assert!(
        skill.info.description.contains("multi-user")
            || skill.info.description.contains("multi-agent"),
        "description should trigger on collaborative sessions: {:?}",
        skill.info.description
    );
    assert!(
        std::path::Path::new(&skill.info.source_info.path).exists(),
        "model-readable bundled skill path should exist: {}",
        skill.info.source_info.path
    );

    let section = build_skill_system_prompt_section(&support.session_resources);
    assert!(section.contains("<name>super-collaboration</name>"));
    assert!(section.contains("super-collaboration/SKILL.md</location>"));
}

#[test]
fn super_collaboration_skill_covers_deliberation_requirements() {
    let skill = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../skills/super-collaboration/SKILL.md"),
    )
    .expect("super collaboration skill file");

    for required in [
        "Topic",
        "Participants",
        "Positions",
        "Deliberation map",
        "agreement",
        "disagreement",
        "Do not invent opinions",
        "Do not impersonate",
        "replyAs",
        "Decision summary",
    ] {
        assert!(skill.contains(required), "missing {required:?}\n{skill}");
    }
}

#[tokio::test]
async fn disabled_skills_are_excluded_from_runtime_resources() {
    let cwd = tempdir().unwrap();
    let package_dir = cwd.path().join("skills-package");
    fs::create_dir_all(package_dir.join("skills/alpha")).unwrap();
    fs::create_dir_all(package_dir.join("skills/beta")).unwrap();
    fs::write(
        package_dir.join("package.json"),
        r#"{
                "name": "skills-package",
                "kordi": { "skills": ["./skills"] }
            }"#,
    )
    .unwrap();
    fs::write(
        package_dir.join("skills/alpha/SKILL.md"),
        "---\nname: alpha\ndescription: alpha skill\n---\nBody.",
    )
    .unwrap();
    fs::write(
        package_dir.join("skills/beta/SKILL.md"),
        "---\nname: beta\ndescription: beta skill\n---\nBody.",
    )
    .unwrap();

    // Load with no disabled list first — both should be visible.
    let settings_all = Settings {
        packages: vec![PackageEntry::Simple(package_dir.display().to_string())],
        ..Settings::default()
    };
    let support_all =
        load_runtime_extension_support(cwd.path(), &settings_all, &ExtensionBootstrap::default())
            .await
            .unwrap();
    let names_all: Vec<String> = support_all
        .session_resources
        .skills
        .iter()
        .map(|s| s.info.name.clone())
        .collect();
    assert!(names_all.iter().any(|n| n == "alpha"));
    assert!(names_all.iter().any(|n| n == "beta"));

    // Now disable `alpha` — source file is still on disk, but it must not
    // show up in the session resources.
    let settings_disabled = Settings {
        packages: vec![PackageEntry::Simple(package_dir.display().to_string())],
        disabled_skills: vec!["alpha".to_string()],
        ..Settings::default()
    };
    let support_disabled = load_runtime_extension_support(
        cwd.path(),
        &settings_disabled,
        &ExtensionBootstrap::default(),
    )
    .await
    .unwrap();
    let names_disabled: Vec<String> = support_disabled
        .session_resources
        .skills
        .iter()
        .map(|s| s.info.name.clone())
        .collect();
    assert!(!names_disabled.iter().any(|n| n == "alpha"));
    assert!(names_disabled.iter().any(|n| n == "beta"));
    assert!(
        package_dir.join("skills/alpha/SKILL.md").exists(),
        "disable must not delete the source file"
    );
}

#[test]
fn project_scoped_package_settings_round_trip() {
    let cwd = tempdir().unwrap();
    let package_dir = cwd.path().join("local-package");
    fs::create_dir_all(&package_dir).unwrap();

    install_package(
        package_dir.to_str().unwrap(),
        SettingsScope::Project,
        cwd.path(),
    )
    .unwrap();

    let listed = list_packages(Some(SettingsScope::Project), cwd.path());
    assert_eq!(listed, vec![package_dir.display().to_string()]);

    let updated = update_packages(Some(SettingsScope::Project), cwd.path()).unwrap();
    assert_eq!(updated, vec![package_dir.display().to_string()]);

    assert!(
        remove_package(
            package_dir.to_str().unwrap(),
            SettingsScope::Project,
            cwd.path(),
        )
        .unwrap()
    );
    assert!(list_packages(Some(SettingsScope::Project), cwd.path()).is_empty());
}

#[test]
fn package_identity_controls_remove_and_listing() {
    let cwd = tempdir().unwrap();
    // Use Settings::merge to test package dedup
    let global = Settings {
        packages: vec![PackageEntry::Simple("npm:@demo/pkg@1.0.0".to_string())],
        ..Settings::default()
    };
    let project = Settings {
        packages: vec![PackageEntry::Simple("npm:@demo/pkg@2.0.0".to_string())],
        ..Settings::default()
    };
    let merged = Settings::merge(&global, &project);
    assert_eq!(merged.packages.len(), 1);
    assert_eq!(merged.packages[0].source(), "npm:@demo/pkg@2.0.0");

    let settings = Settings {
        packages: vec![PackageEntry::Simple("npm:@demo/pkg@2.0.0".to_string())],
        ..Settings::default()
    };
    settings.save_project(cwd.path()).unwrap();

    assert!(remove_package("npm:@demo/pkg", SettingsScope::Project, cwd.path()).unwrap());
    assert!(list_packages(Some(SettingsScope::Project), cwd.path()).is_empty());
}

#[test]
fn update_skips_pinned_package_sources() {
    let cwd = tempdir().unwrap();
    let package_dir = cwd.path().join("local-package");
    fs::create_dir_all(&package_dir).unwrap();

    let settings = Settings {
        packages: vec![
            PackageEntry::Simple(package_dir.display().to_string()),
            PackageEntry::Simple("npm:@demo/pinned@1.2.3".to_string()),
            PackageEntry::Simple("git:https://example.com/repo@v1".to_string()),
        ],
        ..Settings::default()
    };
    settings.save_project(cwd.path()).unwrap();

    let updated = update_packages(Some(SettingsScope::Project), cwd.path()).unwrap();
    assert!(updated.contains(&package_dir.display().to_string()));
    assert!(!updated.contains(&"npm:@demo/pinned@1.2.3".to_string()));
    assert!(!updated.contains(&"git:https://example.com/repo@v1".to_string()));
}

#[test]
fn filter_matches_patterns() {
    let root = Path::new("/pkg");

    // None filter = include all
    assert!(filter_matches(Path::new("/pkg/ext/a.ts"), root, None));

    // Empty filter = include none
    assert!(!filter_matches(Path::new("/pkg/ext/a.ts"), root, Some(&[])));

    // Exact positive match
    assert!(filter_matches(
        Path::new("/pkg/ext/a.ts"),
        root,
        Some(&["ext/a.ts".to_string()])
    ));

    // No match
    assert!(!filter_matches(
        Path::new("/pkg/ext/b.ts"),
        root,
        Some(&["ext/a.ts".to_string()])
    ));

    // Glob exclusion
    assert!(!filter_matches(
        Path::new("/pkg/ext/legacy.ts"),
        root,
        Some(&["ext/*".to_string(), "!ext/legacy*".to_string()])
    ));

    // Force include overrides exclusion
    assert!(filter_matches(
        Path::new("/pkg/ext/legacy.ts"),
        root,
        Some(&["!ext/legacy*".to_string(), "+ext/legacy.ts".to_string()])
    ));

    // Force exclude
    assert!(!filter_matches(
        Path::new("/pkg/ext/a.ts"),
        root,
        Some(&["ext/*".to_string(), "-ext/a.ts".to_string()])
    ));

    // Glob: *.ts matches .ts files
    assert!(filter_matches(
        Path::new("/pkg/ext/a.ts"),
        root,
        Some(&["ext/*.ts".to_string()])
    ));

    // Glob: *.ts should NOT match .js files
    assert!(!filter_matches(
        Path::new("/pkg/ext/a.js"),
        root,
        Some(&["ext/*.ts".to_string()])
    ));

    // Glob: **/*.md matches nested .md files
    assert!(filter_matches(
        Path::new("/pkg/skills/review/SKILL.md"),
        root,
        Some(&["**/*.md".to_string()])
    ));

    // Glob: **/*.md matches top-level .md files too
    assert!(filter_matches(
        Path::new("/pkg/README.md"),
        root,
        Some(&["**/*.md".to_string()])
    ));

    // Glob: **/*.md should NOT match .ts files
    assert!(!filter_matches(
        Path::new("/pkg/ext/a.ts"),
        root,
        Some(&["**/*.md".to_string()])
    ));
}

#[tokio::test]
async fn filtered_package_loads_only_matching_resources() {
    let cwd = tempdir().unwrap();
    let package_dir = cwd.path().join("filtered-pkg");
    fs::create_dir_all(package_dir.join("skills/review")).unwrap();
    fs::create_dir_all(package_dir.join("skills/debug")).unwrap();
    fs::create_dir_all(package_dir.join("prompts")).unwrap();
    fs::write(
        package_dir.join("package.json"),
        r#"{
                "name": "filtered-pkg",
                "kordi": {
                    "skills": ["./skills"],
                    "prompts": ["./prompts"]
                }
            }"#,
    )
    .unwrap();
    fs::write(
        package_dir.join("skills/review/SKILL.md"),
        "---\nname: review\ndescription: review skill\n---\nReview.",
    )
    .unwrap();
    fs::write(
        package_dir.join("skills/debug/SKILL.md"),
        "---\nname: debug\ndescription: debug skill\n---\nDebug.",
    )
    .unwrap();
    fs::write(package_dir.join("prompts/summarize.md"), "Summarize.").unwrap();
    fs::write(package_dir.join("prompts/fixtest.md"), "Fix tests.").unwrap();

    // Load with filter: only review skill, no prompts
    let settings = Settings {
        packages: vec![PackageEntry::Filtered(
            kordi_core::settings::PackageFilter {
                source: package_dir.display().to_string(),
                extensions: None,
                skills: Some(vec!["**/review/**".to_string()]),
                prompts: Some(vec![]),
            },
        )],
        ..Settings::default()
    };
    let support =
        load_runtime_extension_support(cwd.path(), &settings, &ExtensionBootstrap::default())
            .await
            .unwrap();

    // Only review skill should be loaded
    let skill_names: Vec<&str> = support
        .session_resources
        .skills
        .iter()
        .map(|s| s.info.name.as_str())
        .collect();
    assert!(skill_names.contains(&"review"), "review should be loaded");
    assert!(
        !skill_names.contains(&"debug"),
        "debug should be filtered out"
    );

    // No prompts should be loaded (empty filter)
    assert!(
        support.session_resources.prompts.is_empty(),
        "prompts should be empty"
    );
}

#[test]
fn auto_install_skips_local_and_already_installed() {
    let cwd = tempdir().unwrap();
    let local_dir = cwd.path().join("local-pkg");
    fs::create_dir_all(&local_dir).unwrap();

    // Settings with a local path — should be silently skipped.
    let settings = Settings {
        packages: vec![PackageEntry::Simple(local_dir.display().to_string())],
        ..Settings::default()
    };

    // Should not panic or error — local paths are skipped.
    auto_install_missing_packages(cwd.path(), &settings);
}

#[test]
fn resolve_package_directory_prefers_project_root_install_from_nested_cwd() {
    let repo = tempdir().unwrap();
    fs::write(repo.path().join("Cargo.toml"), "[package]\nname='demo'\n").unwrap();
    let nested = repo.path().join("crates").join("inner");
    fs::create_dir_all(&nested).unwrap();

    let spec = "@demo/pkg";
    let package_name = npm_package_name(spec).unwrap();
    let install_root = package_install_root("npm", spec, SettingsScope::Project, &nested);
    let package_dir = install_root.join("node_modules").join(&package_name);
    fs::create_dir_all(&package_dir).unwrap();

    let resolved = resolve_package_directory(&nested, &format!("npm:{spec}")).unwrap();
    assert_eq!(resolved, package_dir);
    assert!(resolved.starts_with(normalize_path(repo.path().join(".kordi"))));
}

#[test]
fn auto_install_identifies_missing_npm_package_dir() {
    // Verify that an npm: package whose install directory does not exist
    // is recognised as needing installation (the actual npm install will
    // fail in the test environment, but the function handles the error
    // gracefully via tracing::warn).
    let cwd = tempdir().unwrap();

    // Use a unique spec so previous test runs can't leave stale dirs.
    let unique = format!("@test/nonexistent-{}", std::process::id());
    let source = format!("npm:{unique}");

    // Check the project-scoped root (under temp cwd) — guaranteed fresh.
    let root = package_install_root("npm", &unique, SettingsScope::Project, cwd.path());
    assert!(
        !root.exists(),
        "install root should not exist before auto-install"
    );

    let settings = Settings {
        packages: vec![PackageEntry::Simple(source)],
        ..Settings::default()
    };

    // Should attempt install and handle the failure without panicking.
    auto_install_missing_packages(cwd.path(), &settings);
}

#[test]
fn build_skill_section_includes_skills_and_prompts() {
    let resources = SessionResourceBootstrap {
        skills: vec![SkillDefinition {
            info: SkillInfo {
                name: "demo-review".to_string(),
                description: "Review code carefully".to_string(),
                source_info: SourceInfo {
                    path: "/skills/demo-review/SKILL.md".to_string(),
                    source: "settings:project".to_string(),
                },
            },
            content: "Review the code.".to_string(),
        }],
        prompts: vec![PromptTemplateDefinition {
            info: PromptTemplateInfo {
                name: "fix-tests".to_string(),
                description: "Fix all failing tests".to_string(),
                source_info: SourceInfo {
                    path: "/prompts/fix-tests.md".to_string(),
                    source: "settings:project".to_string(),
                },
            },
            content: "Fix tests.".to_string(),
        }],
        ..SessionResourceBootstrap::default()
    };
    let section = build_skill_system_prompt_section(&resources);
    assert!(section.contains("<available_skills>"));
    assert!(section.contains("<name>demo-review</name>"));
    assert!(section.contains("Review code carefully"));
    assert!(section.contains("<location>/skills/demo-review/SKILL.md</location>"));
    assert!(section.contains("/fix-tests"));
    assert!(section.contains("Fix all failing tests"));
}

#[test]
fn build_skill_section_empty_when_no_resources() {
    let resources = SessionResourceBootstrap::default();
    let section = build_skill_system_prompt_section(&resources);
    assert!(section.is_empty());
}
