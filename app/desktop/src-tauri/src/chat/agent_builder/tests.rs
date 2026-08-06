//! Agent Builder contract and workspace regression tests.

use super::*;

#[test]
fn factory_prompt_covers_multiple_kordi_resource_types() {
    assert!(BUILDER_SYSTEM_PROMPT.starts_with("You are Kordi Factory"));
    for resource in [
        "agent definitions",
        "skills",
        "tool and plugin selections",
        "workflow instructions",
        "supporting draft files",
    ] {
        assert!(
            BUILDER_SYSTEM_PROMPT.contains(resource),
            "Factory prompt should cover {resource}"
        );
    }
}

#[test]
fn clean_slug_produces_safe_skill_names() {
    assert_eq!(clean_slug(" Repository Review "), "repository-review");
    assert_eq!(clean_slug("../Unsafe Name"), "unsafe-name");
}

#[test]
fn factory_target_parsing_preserves_legacy_agent_ids() {
    assert_eq!(
        artifact_kind_from_target("device:agent:agent:kordi"),
        "agent"
    );
    assert_eq!(
        fallback_name_from_target("device:agent:agent:kordi", "agent"),
        "agent:kordi"
    );
    assert_eq!(
        artifact_kind_from_target("account:user-1:create:plugin:build-1"),
        "plugin"
    );
    assert_eq!(
        fallback_name_from_target("account:user-1:create:plugin:build-1", "plugin"),
        "build 1"
    );
}

#[test]
fn untouched_creation_builds_stay_out_of_the_catalog() {
    for target_key in [
        "create-agent",
        "account:user-1:create-skill",
        "device:create:tool:build-1",
        "account:user-1:create:plugin:build-2",
    ] {
        let metadata = DesktopAgentBuilderMetadata {
            draft_id: uuid::Uuid::new_v4().to_string(),
            target_key: target_key.to_string(),
            session_id: "session:agent-builder:new".to_string(),
            status: "draft".to_string(),
            created_at_ms: 10,
            updated_at_ms: 10,
        };
        assert!(is_untouched_creation(&metadata), "{target_key}");
    }

    let started = DesktopAgentBuilderMetadata {
        draft_id: uuid::Uuid::new_v4().to_string(),
        target_key: "account:user-1:create:skill:build-1".to_string(),
        session_id: "session:agent-builder:started".to_string(),
        status: "draft".to_string(),
        created_at_ms: 10,
        updated_at_ms: 11,
    };
    assert!(!is_untouched_creation(&started));
}

#[test]
fn build_catalog_collapses_scoped_and_legacy_associations() {
    let legacy = DesktopAgentBuilderSummary {
        draft_id: "legacy-draft".to_string(),
        target_key: "agent:cloud-agent:agent-1".to_string(),
        session_id: "session:agent-builder:legacy".to_string(),
        artifact_kind: "agent".to_string(),
        name: "Agent one".to_string(),
        lifecycle: "draft".to_string(),
        updated_at_ms: 10,
        available: true,
    };
    let scoped = DesktopAgentBuilderSummary {
        draft_id: "scoped-draft".to_string(),
        target_key: "account:user-1:agent:cloud-agent:agent-1".to_string(),
        session_id: "session:agent-builder:scoped".to_string(),
        artifact_kind: "agent".to_string(),
        name: "Agent one".to_string(),
        lifecycle: "draft".to_string(),
        updated_at_ms: 20,
        available: true,
    };

    let summaries = deduplicate_builder_summaries([legacy, scoped]);
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].draft_id, "scoped-draft");
}

#[test]
fn frontmatter_name_requires_frontmatter() {
    assert_eq!(
        frontmatter_name("---\nname: repo-review\ndescription: Test\n---\n"),
        Some("repo-review".to_string())
    );
    assert_eq!(
        frontmatter_field(
            "---\nname: repo-review\ndescription: Test\n---\n",
            "description"
        ),
        Some("Test".to_string())
    );
    assert_eq!(frontmatter_name("# repo-review"), None);
}

#[test]
fn relative_paths_reject_parent_components() {
    assert!(is_safe_relative_path(Path::new("skills/review/SKILL.md")));
    assert!(!is_safe_relative_path(Path::new("../SKILL.md")));
    assert!(!is_safe_relative_path(Path::new("/tmp/SKILL.md")));
    assert!(is_canonical_skill_file_path(Path::new(
        "skills/review/SKILL.md"
    )));
    assert!(is_skill_bundle_file_path(Path::new(
        "skills/review/scripts/check.sh"
    )));
    assert!(!is_canonical_skill_file_path(Path::new(
        "skills/review/notes.md"
    )));
}

#[test]
fn validates_materialized_workspace_and_invalidates_changed_fingerprint() {
    let workspace =
        std::env::temp_dir().join(format!("kordi-agent-builder-test-{}", uuid::Uuid::new_v4()));
    let seed = DesktopAgentBuilderSeed {
        name: "Repository reviewer".to_string(),
        role: "Code review agent".to_string(),
        access: "only-me".to_string(),
        tools: vec!["read".to_string(), "grep".to_string()],
        skills: vec![DesktopAgentBuilderSkillSeed {
            name: "repository-review".to_string(),
            description: "Review a repository safely".to_string(),
            content: None,
        }],
        ..DesktopAgentBuilderSeed::default()
    };

    materialize_seed(&workspace, Some(&seed)).expect("materialize builder workspace");
    let (draft, validation) = validate_workspace(&workspace);
    assert!(validation.valid, "{:?}", validation.errors);
    assert_eq!(draft.expect("validated draft").skills.len(), 1);

    let original_fingerprint = validation.fingerprint;
    fs::write(
        workspace.join(PROMPT_FILE),
        "You are a careful repository reviewer.\n",
    )
    .expect("update prompt");
    let (_, changed_validation) = validate_workspace(&workspace);
    assert!(changed_validation.valid);
    assert_ne!(changed_validation.fingerprint, original_fingerprint);
    let _ = fs::remove_dir_all(workspace);
}

#[test]
fn proactive_and_mention_permissions_round_trip_through_the_builder() {
    let workspace =
        std::env::temp_dir().join(format!("kordi-agent-builder-test-{}", uuid::Uuid::new_v4()));
    let seed = DesktopAgentBuilderSeed {
        name: "Group facilitator".to_string(),
        role: "Collaboration agent".to_string(),
        access: "participant-conversations".to_string(),
        proactive: DesktopAgentBuilderProactive {
            enabled: true,
            skill_pack: "proact-v1".to_string(),
        },
        mention_permissions: DesktopAgentBuilderMentionPermissions {
            people: true,
            agents: false,
        },
        ..DesktopAgentBuilderSeed::default()
    };

    materialize_seed(&workspace, Some(&seed)).expect("materialize builder workspace");
    let (draft, validation) = validate_workspace(&workspace);
    assert!(validation.valid, "{:?}", validation.errors);
    let draft = draft.expect("validated draft");
    assert!(draft.proactive.enabled);
    assert_eq!(draft.proactive.skill_pack, "proact-v1");
    assert!(draft.mention_permissions.people);
    assert!(!draft.mention_permissions.agents);

    let mut private_draft = draft;
    private_draft.access = "only-me".to_string();
    write_draft(&workspace, private_draft).expect("write invalid private proactive draft");
    let (_, invalid) = validate_workspace(&workspace);
    assert!(!invalid.valid);
    assert!(invalid
        .errors
        .iter()
        .any(|error| error.contains("requires participant-conversations access")));
    let _ = fs::remove_dir_all(workspace);
}

#[test]
fn rejects_skill_paths_that_do_not_match_the_skill_name() {
    let skill = DesktopAgentBuilderSkillFile {
        name: "repository-review".to_string(),
        description: "Review repositories".to_string(),
        path: Some("skills/other/SKILL.md".to_string()),
    };
    let error = skill_path(&skill).expect_err("mismatched path should fail");
    assert!(error.contains("skills/repository-review/SKILL.md"));
}

#[test]
fn rejects_unpublished_files_outside_the_draft_contract() {
    let workspace =
        std::env::temp_dir().join(format!("kordi-agent-builder-test-{}", uuid::Uuid::new_v4()));
    let seed = DesktopAgentBuilderSeed {
        name: "Focused agent".to_string(),
        role: "Test agent".to_string(),
        access: "only-me".to_string(),
        ..DesktopAgentBuilderSeed::default()
    };
    materialize_seed(&workspace, Some(&seed)).expect("materialize builder workspace");
    fs::write(workspace.join("unpublished.txt"), "not part of the agent")
        .expect("write unsupported file");

    let (_, validation) = validate_workspace(&workspace);
    assert!(!validation.valid);
    assert!(validation
        .errors
        .iter()
        .any(|error| error.contains("Unsupported file")));
    let _ = fs::remove_dir_all(workspace);
}

#[test]
fn validates_and_fingerprints_declared_skill_support_files() {
    let workspace =
        std::env::temp_dir().join(format!("kordi-agent-builder-test-{}", uuid::Uuid::new_v4()));
    let seed = DesktopAgentBuilderSeed {
        name: "Repository reviewer".to_string(),
        role: "Code review agent".to_string(),
        access: "only-me".to_string(),
        skills: vec![DesktopAgentBuilderSkillSeed {
            name: "repository-review".to_string(),
            description: "Review a repository safely".to_string(),
            content: None,
        }],
        ..DesktopAgentBuilderSeed::default()
    };
    materialize_seed(&workspace, Some(&seed)).expect("materialize builder workspace");
    let script = workspace.join("skills/repository-review/scripts/check.sh");
    fs::create_dir_all(script.parent().expect("script parent")).expect("create scripts");
    fs::write(&script, "#!/bin/sh\nexit 0\n").expect("write supporting script");

    let (_, validation) = validate_workspace(&workspace);
    assert!(validation.valid, "{:?}", validation.errors);
    assert!(validation.files.iter().any(|file| {
        file.path == "skills/repository-review/scripts/check.sh"
            && file.kind == "skill-support"
            && file.valid
    }));
    let original_fingerprint = validation.fingerprint;
    fs::write(&script, "#!/bin/sh\nexit 1\n").expect("change supporting script");
    let (_, changed) = validate_workspace(&workspace);
    assert!(changed.valid, "{:?}", changed.errors);
    assert_ne!(changed.fingerprint, original_fingerprint);
    let _ = fs::remove_dir_all(workspace);
}

#[test]
fn atomic_workspace_updates_reject_stale_fingerprints() {
    let container =
        std::env::temp_dir().join(format!("kordi-agent-builder-test-{}", uuid::Uuid::new_v4()));
    let workspace = container.join(WORKSPACE_DIR);
    let seed = DesktopAgentBuilderSeed {
        name: "Focused agent".to_string(),
        role: "Test agent".to_string(),
        access: "only-me".to_string(),
        ..DesktopAgentBuilderSeed::default()
    };
    materialize_seed(&workspace, Some(&seed)).expect("materialize builder workspace");
    let original = workspace_fingerprint(&workspace)
        .expect("fingerprint workspace")
        .0;
    atomically_update_workspace(&workspace, &original, |staged| {
        fs::write(staged.join(PROMPT_FILE), "Updated prompt\n").map_err(|error| error.to_string())
    })
    .expect("apply atomic update");
    let changed = workspace_fingerprint(&workspace)
        .expect("fingerprint updated workspace")
        .0;
    assert_ne!(changed, original);
    let error = atomically_update_workspace(&workspace, &original, |_| Ok(()))
        .expect_err("stale update should fail");
    assert!(error.contains("changed in another session"));
    assert_eq!(
        fs::read_to_string(workspace.join(PROMPT_FILE)).expect("read updated prompt"),
        "Updated prompt\n"
    );
    let _ = fs::remove_dir_all(container);
}

#[test]
fn legacy_drafts_migrate_into_a_metadata_isolated_workspace() {
    let container =
        std::env::temp_dir().join(format!("kordi-agent-builder-test-{}", uuid::Uuid::new_v4()));
    let workspace = container.join(WORKSPACE_DIR);
    let seed = DesktopAgentBuilderSeed {
        name: "Migrated agent".to_string(),
        role: "Migration test".to_string(),
        access: "only-me".to_string(),
        ..DesktopAgentBuilderSeed::default()
    };
    materialize_seed(&container, Some(&seed)).expect("materialize legacy draft");
    migrate_legacy_workspace(&container, &workspace).expect("migrate legacy draft");
    materialize_builder_skills(&container).expect("materialize protected resources");

    assert!(workspace.join(AGENT_FILE).is_file());
    assert!(workspace.join(PROMPT_FILE).is_file());
    assert!(!workspace.join(METADATA_FILE).exists());
    assert!(resources_root(&container)
        .join("agent-creator/SKILL.md")
        .is_file());
    assert!(!resources_root(&container).starts_with(&workspace));
    let _ = fs::remove_dir_all(container);
}

#[test]
fn artifact_association_stays_on_the_exact_session_and_reports_missing_storage() {
    let root = std::env::temp_dir().join(format!(
        "kordi-builder-association-test-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&root).expect("create association root");
    let target_key = "account:test:agent:agent-1";
    let published = DesktopAgentBuilderMetadata {
        draft_id: uuid::Uuid::new_v4().to_string(),
        target_key: target_key.to_string(),
        session_id: "session:agent-builder:published".to_string(),
        status: "published".to_string(),
        created_at_ms: 10,
        updated_at_ms: 20,
    };
    let draft = DesktopAgentBuilderMetadata {
        draft_id: uuid::Uuid::new_v4().to_string(),
        target_key: target_key.to_string(),
        session_id: "session:agent-builder:draft".to_string(),
        status: "draft".to_string(),
        created_at_ms: 30,
        updated_at_ms: 40,
    };
    for metadata in [&published, &draft] {
        let container = root.join(&metadata.draft_id);
        fs::create_dir_all(&container).expect("create draft container");
        write_json(&metadata_path(&container), metadata).expect("write builder metadata");
    }

    let first = resolve_builder_in(&root, target_key)
        .expect("resolve legacy association")
        .expect("associated builder");
    assert_eq!(first.session_id, draft.session_id);

    let newer = DesktopAgentBuilderMetadata {
        draft_id: uuid::Uuid::new_v4().to_string(),
        target_key: target_key.to_string(),
        session_id: "session:agent-builder:newer-but-unrelated".to_string(),
        status: "draft".to_string(),
        created_at_ms: 50,
        updated_at_ms: 60,
    };
    let newer_container = root.join(&newer.draft_id);
    fs::create_dir_all(&newer_container).expect("create newer container");
    write_json(&metadata_path(&newer_container), &newer).expect("write newer metadata");
    let still_exact = resolve_builder_in(&root, target_key)
        .expect("resolve persisted association")
        .expect("associated builder");
    assert_eq!(still_exact.session_id, draft.session_id);

    fs::remove_dir_all(root.join(&draft.draft_id)).expect("remove associated draft");
    let error =
        resolve_builder_in(&root, target_key).expect_err("missing session must be explicit");
    assert!(error.contains("unavailable"));
    let _ = fs::remove_dir_all(root);
}
