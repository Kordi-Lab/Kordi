//! The public page's treatment of agent replies: markup hooks, styles, and
//! script hygiene.

use std::io::Write;
use std::process::{Command, Stdio};

use super::super::model::DocumentFormat;
use super::super::public_page::{document_page, PageInput};
use super::sample_record;

const SCRIPTS: [(&str, &str); 3] = [
    ("page-agent.js", include_str!("../assets/page-agent.js")),
    ("page.js", include_str!("../assets/page.js")),
    ("page-menu.js", include_str!("../assets/page-menu.js")),
];
const STYLES: &str = include_str!("../assets/page.css");

fn page(nonce: &str) -> String {
    let token = format!("kordi_ds_{}", "E".repeat(43));
    document_page(
        &PageInput {
            token: &token,
            record: &sample_record(DocumentFormat::Markdown, "Alex Morgan"),
            source: "# Plan\n\nBody text.\n",
        },
        nonce,
    )
}

#[test]
fn public_page_ships_the_agent_hooks_and_styles() {
    let page = page("n6");
    assert!(
        page.contains(r#"<button type="button" class="at" hidden></button>"#),
        "the mention button starts hidden in the composer template"
    );
    let agent_script = page.find("window.KordiAgent = {").unwrap();
    let core_script = page.find("window.KordiDoc = {").unwrap();
    assert!(agent_script < core_script, "agent pieces load first");
    for hook in [
        "'av agent'",
        "'tag', 'Agent'",
        "'sys'",
        "'work'",
        "'dots'",
        "' is working'",
        "'fail'",
        "'Could not answer'",
        "'retry', 'Retry'",
        "createElementNS",
        "c.kind === 'agent'",
        "r.kind === 'system'",
        "querySelector('.at')",
    ] {
        assert!(page.contains(hook), "{hook}");
    }
    for rule in [
        ".av.agent {",
        ".n .tag {",
        ".sys {",
        ".work, .fail {",
        ".dots i {",
        "@keyframes dot",
        "@media (prefers-reduced-motion: reduce) { .dots i { animation: none;",
        ".fail .retry {",
        ".cmtbox button.at {",
    ] {
        assert!(STYLES.contains(rule), "{rule}");
        assert!(page.contains(rule), "{rule}");
    }
    assert!(!page.contains("AGENT"), "sentence case, no all-caps labels");
}

#[test]
fn public_page_scripts_build_the_dom_without_markup_strings() {
    for (name, source) in SCRIPTS {
        for banned in [
            "innerHTML",
            "outerHTML",
            "insertAdjacentHTML",
            "document.write",
        ] {
            assert!(!source.contains(banned), "{name} uses {banned}");
        }
        assert!(source.lines().count() < 500, "{name} is too long");
    }
    assert!(STYLES.lines().count() < 500);
    assert!(!page("n7").contains("innerHTML"));
}

#[test]
fn public_page_scripts_parse() {
    for (name, source) in SCRIPTS {
        let spawned = Command::new("node")
            .args(["--check", "-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn();
        let mut child = match spawned {
            Ok(child) => child,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                eprintln!("node is not installed; skipping the syntax check of {name}");
                return;
            }
            Err(error) => panic!("node --check {name}: {error}"),
        };
        child
            .stdin
            .take()
            .unwrap()
            .write_all(source.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{name}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
