//! Shared document tests. Pure tests always run; database tests live in
//! `tests/db.rs` and follow the connector tests' `DATABASE_URL` rule.

use super::access::DocumentRecord;
use super::model::{DocumentAuthor, DocumentFormat};
use super::public_page::{document_page, link_off_page, page_csp, PageInput};
use super::render::*;
use super::tokens::*;
use super::validate::*;

mod block_ids_tests;
mod collab_db;
mod db;
mod db_fixture;
mod editing_db;
mod formats;
mod sources_db;
mod stable_ids_db;

#[test]
fn share_tokens_have_the_invitation_shape_and_hash_stably() {
    let secret = b"0123456789abcdef0123456789abcdef";
    let id = new_share_id();
    assert!(id.starts_with("docshare_"));
    let token = share_token(secret, &id);
    assert!(token.starts_with("kordi_ds_"));
    assert_eq!(token.len(), "kordi_ds_".len() + 43);
    assert!(is_well_formed_token(&token));
    assert_eq!(
        token,
        share_token(secret, &id),
        "owners can rebuild the link"
    );
    assert_ne!(token, share_token(secret, &new_share_id()));
    assert_ne!(
        token,
        share_token(b"another-secret-of-thirty-two-bytes!", &id)
    );
    let hash = hash_share_token(&token);
    assert_eq!(hash.len(), 64);
    assert!(hash.chars().all(|ch| ch.is_ascii_hexdigit()));
    assert_eq!(hash, hash_share_token(&token));
    assert!(!hash.contains(&token[9..]));
    assert!(!is_well_formed_token("kordi_gi_abc"));
    assert!(!is_well_formed_token(&format!("{token}x")));
    assert!(!is_well_formed_token(&token.replace('_', "/")));
    assert_eq!(share_deep_link(&token), format!("kordi://document/{token}"));
    assert!(share_url(&token).ends_with(&format!("/d/{token}")));
}

const SAMPLE: &str = "## Summary\n\nFirst *paragraph*.\n\n```rust\nfn main() {}\n```\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quoted\n\n---\n";

#[test]
fn markdown_splits_into_top_level_blocks_in_source_order() {
    let blocks = markdown_blocks(SAMPLE);
    let ids: Vec<&str> = blocks.iter().map(|block| block.id.as_str()).collect();
    assert_eq!(ids, ["b0", "b1", "b2", "b3", "b4", "b5", "b6"]);
    let sources: Vec<&str> = blocks.iter().map(|block| block.source.as_str()).collect();
    assert_eq!(
        sources,
        [
            "## Summary",
            "First *paragraph*.",
            "```rust\nfn main() {}\n```",
            "- one\n- two",
            "| a | b |\n|---|---|\n| 1 | 2 |",
            "> quoted",
            "---",
        ]
    );
    assert_eq!(blocks[0].html, "<h2>Summary</h2>\n");
    assert!(blocks[1].html.contains("<em>paragraph</em>"));
    assert!(blocks[2]
        .html
        .contains("<pre><code class=\"language-rust\">"));
    assert!(blocks[3].html.starts_with("<ul>"));
    assert!(blocks[4].html.starts_with("<table>"));
    assert!(blocks[5].html.starts_with("<blockquote>"));
    assert!(blocks[6].html.starts_with("<hr"));
}

#[test]
fn markdown_rendering_drops_raw_html_and_unsafe_links() {
    let blocks = markdown_blocks(
        "<script>alert(1)</script>\n\nHi <b onclick=\"x\">there</b>.\n\n[bad](javascript:alert(1)) [ok](https://example.com) [mail](mailto:a@example.com)\n\n![plain](http://example.com/a.png) ![good](https://example.com/b.png)\n",
    );
    assert_eq!(blocks.len(), 4, "an HTML block still takes an id");
    assert_eq!(blocks[0].html, "");
    assert!(!blocks[1].html.contains("<b"));
    assert!(!blocks[1].html.contains("onclick"));
    assert!(blocks[1].html.contains("there"));
    let links = &blocks[2].html;
    assert!(!links.contains("javascript"));
    assert!(links.contains("bad"), "the text of a dropped link stays");
    assert!(links.contains(r#"<a rel="noopener noreferrer" href="https://example.com">ok</a>"#));
    assert!(links.contains(r#"<a rel="noopener noreferrer" href="mailto:a@example.com">"#));
    let images = &blocks[3].html;
    assert!(!images.contains("http://example.com/a.png"));
    assert!(!images.contains("plain"));
    assert!(images.contains(r#"src="https://example.com/b.png""#));
    assert!(!link_is_allowed(" JavaScript:alert(1)"));
    assert!(!link_is_allowed("/relative"));
    assert!(image_is_allowed("data:image/png;base64,AAAA"));
    assert!(!image_is_allowed("data:text/html,<b>"));
}

#[test]
fn titles_come_from_the_document_or_the_file_name() {
    assert_eq!(
        document_title(
            DocumentFormat::Markdown,
            "intro\n\n# Field `notes`\n",
            "x.md"
        ),
        "Field notes"
    );
    assert_eq!(
        document_title(DocumentFormat::Markdown, "## Only h2\n", "Weekly plan.md"),
        "Weekly plan"
    );
    assert_eq!(
        document_title(
            DocumentFormat::Html,
            "<html><head><TITLE> Q3 &amp; Q4 </TITLE></head></html>",
            "report.html"
        ),
        "Q3 & Q4"
    );
    assert_eq!(
        document_title(DocumentFormat::Html, "<p>no title</p>", "report.html"),
        "report"
    );
    let html_blocks = document_blocks(DocumentFormat::Html, "<p>x</p>");
    assert_eq!(html_blocks.len(), 1);
    assert_eq!(html_blocks[0].id, "b0");
    assert!(html_blocks[0].source.is_empty() && html_blocks[0].html.is_empty());
}

#[test]
fn document_format_follows_content_type_then_file_name() {
    use DocumentFormat::*;
    assert_eq!(
        document_format("text/markdown; charset=utf-8", ""),
        Some(Markdown)
    );
    assert_eq!(document_format("text/html", ""), Some(Html));
    assert_eq!(document_format("text/plain", "notes.md"), Some(Markdown));
    assert_eq!(document_format("", "page.htm"), Some(Html));
    assert_eq!(document_format("image/png", "notes.md"), None);
    assert_eq!(document_format("text/plain", "notes.txt"), None);
}

#[test]
fn validation_rules_match_the_contract() {
    assert!(is_valid_block_id("b0"));
    assert!(is_valid_block_id("b99999"));
    for invalid in ["b", "b123456", "B1", "b-1", "c1", "b1 "] {
        assert!(!is_valid_block_id(invalid), "{invalid}");
    }
    assert_eq!(
        clean_reaction(" \u{2764}\u{fe0f} ").as_deref(),
        Some("\u{2764}\u{fe0f}")
    );
    assert!(clean_reaction("\u{1f44d}").is_some());
    for invalid in ["", "ok", "<", "\u{1f44d}\u{1f44d}", "1"] {
        assert!(clean_reaction(invalid).is_none(), "{invalid}");
    }
    assert!(clean_body("  hi ").is_some());
    assert!(clean_body("   ").is_none());
    assert!(clean_body(&"a".repeat(4000)).is_some());
    assert!(clean_body(&"a".repeat(4001)).is_none());
    assert_eq!(clean_reader_name("  Priya ").as_deref(), Some("Priya"));
    assert!(clean_reader_name("").is_none());
    assert!(clean_reader_name(&"n".repeat(41)).is_none());
    assert!(clean_reader_name("a\u{7}b").is_none());
    assert!(is_valid_reader_key("abcdefghijklmnop"));
    assert!(is_valid_reader_key(&"A-_9".repeat(16)));
    assert!(!is_valid_reader_key("short"));
    assert!(!is_valid_reader_key(&"a".repeat(65)));
    assert!(!is_valid_reader_key("abcdefghijklmnop!"));
}

#[test]
fn agent_mentions_use_the_agent_name_or_at_agent() {
    assert!(mentions_agent(
        "@Lab agent what does this mean?",
        Some("Lab agent")
    ));
    assert!(mentions_agent("hey @lab AGENT", Some("Lab agent")));
    assert!(mentions_agent("ask @agent", None));
    assert!(!mentions_agent(
        "Lab agent without the at sign",
        Some("Lab agent")
    ));
    assert!(!mentions_agent("@Priya thanks", Some("Lab agent")));
}

fn sample_record(format: DocumentFormat, author_name: &str) -> DocumentRecord {
    DocumentRecord {
        attachment_id: "att_example".into(),
        requested_attachment_id: "att_example".into(),
        object_key: "attachments/acct_example/att_example".into(),
        owner_account_id: "acct_example".into(),
        content_type: "text/markdown".into(),
        size_bytes: Some(10),
        created_at: "2026-10-09T10:15:00Z".into(),
        format,
        file_name: "notes.md".into(),
        author: DocumentAuthor {
            account_id: "acct_example".into(),
            display_name: author_name.into(),
            kordi_id: "123456789".into(),
            avatar_url: None,
        },
        agent_name: Some("Lab agent".into()),
    }
}

#[test]
fn public_page_carries_the_csp_nonce_author_and_open_action() {
    let token = format!("kordi_ds_{}", "A".repeat(43));
    let record = sample_record(DocumentFormat::Markdown, "Alex <Morgan>");
    let source = "# Plan <b>&</b> \"notes\"\n\nBody text.\n";
    let page = document_page(
        &PageInput {
            token: &token,
            record: &record,
            source,
        },
        "nonceABC",
    );
    assert!(page.contains(r#"<style nonce="nonceABC">"#));
    assert!(page.contains(r#"<script nonce="nonceABC">"#));
    assert!(!page.contains("<script>"));
    assert!(
        !page.contains(" style=\""),
        "inline style attributes break the CSP"
    );
    assert!(page.contains("@Alex &lt;Morgan&gt;"));
    assert!(page.contains("Kordi 123 456 789"));
    assert!(page.contains("Add on Kordi"));
    assert!(page.contains(&format!(
        r#"href="kordi://document/{token}">Open in Kordi</a>"#
    )));
    assert!(page.contains("Shared by <b>Alex &lt;Morgan&gt;</b>"));
    assert!(page.contains("Oct 9, 2026"));
    assert!(page.contains("<title>Plan &amp; &quot;notes&quot; &middot; Kordi</title>"));
    assert!(!page.contains("<b>&</b>"));
    assert!(page.contains(r#"data-block="b1"><p>Body text.</p>"#));
    assert!(
        !page.contains(r#"data-block="b0""#),
        "the title heading is shown once"
    );
    assert!(
        !page.contains("font-family: \"Marcellus\""),
        "no serif fonts"
    );

    let csp = page_csp("nonceABC");
    for directive in [
        "default-src 'none'",
        "style-src 'nonce-nonceABC'",
        "script-src 'nonce-nonceABC'",
        "img-src https: data:",
        "connect-src 'self'",
        "frame-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
    ] {
        assert!(csp.contains(directive), "{directive}");
    }
}

#[test]
fn public_html_documents_render_in_a_sandboxed_frame() {
    let token = format!("kordi_ds_{}", "B".repeat(43));
    let record = sample_record(DocumentFormat::Html, "Alex Morgan");
    let page = document_page(
        &PageInput {
            token: &token,
            record: &record,
            source: "<title>Report</title><script>alert(1)</script>",
        },
        "n1",
    );
    assert!(page.contains(&format!(
        r#"<iframe class="frame" sandbox src="/d/{token}/raw""#
    )));
    assert!(!page.contains("alert(1)"));
    assert!(page.contains("<h1>Report</h1>"));
}

#[test]
fn revoked_page_says_the_link_is_off() {
    let page = link_off_page("n2");
    assert!(page.contains("This link is off"));
    assert!(page.contains(r#"<style nonce="n2">"#));
    assert!(!page.contains("<script"));
}

#[tokio::test]
async fn public_writes_are_limited_per_address_while_reads_continue() {
    use super::{observe_public_address, PublicAccess};
    use crate::auth::rate_limit::{CloudRateLimitConfig, CloudRateLimiter, RateLimitDecision};
    use std::net::{IpAddr, Ipv4Addr};

    let limiter = CloudRateLimiter::memory(CloudRateLimitConfig::production());
    let reader = Some(IpAddr::V4(Ipv4Addr::new(203, 0, 113, 7)));
    let other = Some(IpAddr::V4(Ipv4Addr::new(203, 0, 113, 8)));
    for attempt in 1..=30 {
        assert!(
            observe_public_address(&limiter, reader, PublicAccess::Write)
                .await
                .is_ok(),
            "write {attempt}"
        );
    }
    let limited = observe_public_address(&limiter, reader, PublicAccess::Write)
        .await
        .unwrap_err();
    assert_eq!(limited.status(), axum::http::StatusCode::TOO_MANY_REQUESTS);
    assert!(limited.headers().contains_key("Retry-After"));
    for attempt in 1..=20 {
        assert!(
            observe_public_address(&limiter, reader, PublicAccess::Read)
                .await
                .is_ok(),
            "read {attempt}"
        );
    }
    assert!(observe_public_address(&limiter, other, PublicAccess::Write)
        .await
        .is_ok());
    assert_eq!(
        limiter.observe_ip(reader).await,
        RateLimitDecision::Allowed,
        "documents leave the sign-in budget alone"
    );
}
