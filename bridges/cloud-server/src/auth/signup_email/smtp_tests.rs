use std::collections::HashMap;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use super::{check_plaintext_allowed, SignupCodeSender, SmtpSecurity, SmtpSignupCodeSender};

fn settings(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let values: HashMap<String, String> = pairs
        .iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();
    move |key| values.get(key).cloned()
}

fn mailpit_settings(host: &str, port: &str) -> Vec<(&'static str, String)> {
    vec![
        ("KORDI_AUTH_SMTP_SECURITY", "none".into()),
        ("KORDI_AUTH_SMTP_HOST", host.into()),
        ("KORDI_AUTH_SMTP_PORT", port.into()),
        (
            "KORDI_AUTH_SMTP_FROM",
            "Kordi Dev <no-reply@example.test>".into(),
        ),
    ]
}

fn build(
    pairs: &[(&'static str, String)],
    development_build: bool,
) -> Result<Option<SmtpSignupCodeSender>, &'static str> {
    let pairs: Vec<(&str, &str)> = pairs.iter().map(|(k, v)| (*k, v.as_str())).collect();
    SmtpSignupCodeSender::from_settings(settings(&pairs), development_build)
}

#[test]
fn security_defaults_to_starttls_and_parses_known_values() {
    assert_eq!(SmtpSecurity::parse(None), Ok(SmtpSecurity::StartTls));
    assert_eq!(SmtpSecurity::parse(Some("  ")), Ok(SmtpSecurity::StartTls));
    assert_eq!(
        SmtpSecurity::parse(Some("STARTTLS")),
        Ok(SmtpSecurity::StartTls)
    );
    assert_eq!(SmtpSecurity::parse(Some("tls")), Ok(SmtpSecurity::Tls));
    assert_eq!(SmtpSecurity::parse(Some(" none ")), Ok(SmtpSecurity::None));
    for value in ["ssl", "plain", "off", "false", "starttls,none"] {
        assert!(SmtpSecurity::parse(Some(value)).is_err(), "{value}");
    }
}

#[test]
fn security_default_ports_follow_the_transport() {
    assert_eq!(SmtpSecurity::StartTls.default_port(), 587);
    assert_eq!(SmtpSecurity::Tls.default_port(), 465);
    assert_eq!(SmtpSecurity::None.default_port(), 25);
}

#[test]
fn plaintext_is_allowed_for_local_hosts_in_development_builds() {
    for host in [
        "mailpit",
        "Mailpit",
        "mail-catcher",
        "localhost",
        "mail.localhost",
        "127.0.0.1",
        "127.10.0.3",
        "10.0.0.5",
        "172.18.0.4",
        "192.168.1.20",
        "::1",
        "[::1]",
        "fd00::25",
    ] {
        assert_eq!(check_plaintext_allowed(host, true, false), Ok(()), "{host}");
    }
}

#[test]
fn plaintext_is_refused_for_public_or_ambiguous_hosts() {
    for host in [
        "smtp.example.com",
        "mailpit.example.test",
        "mailpit.",
        "8.8.8.8",
        "172.32.0.1",
        "169.254.0.10",
        "2001:db8::25",
        "2130706433",
        "0x7f000001",
        "-mailpit",
        "mailpit-",
        "mail_pit",
        "",
    ] {
        assert!(
            check_plaintext_allowed(host, true, false).is_err(),
            "{host}"
        );
    }
}

#[test]
fn plaintext_is_refused_in_release_builds_even_for_local_hosts() {
    for host in ["mailpit", "localhost", "127.0.0.1"] {
        assert!(
            check_plaintext_allowed(host, false, false)
                .unwrap_err()
                .contains("development builds"),
            "{host}"
        );
    }
}

#[test]
fn plaintext_never_carries_credentials() {
    assert!(check_plaintext_allowed("mailpit", true, true)
        .unwrap_err()
        .contains("never sends credentials"));
}

#[test]
fn settings_refuse_plaintext_for_release_builds_and_public_hosts() {
    let local = mailpit_settings("mailpit", "1025");
    assert!(build(&local, true).unwrap().is_some());
    assert!(build(&local, false)
        .err()
        .unwrap()
        .contains("development builds"));
    let public = mailpit_settings("smtp.example.com", "25");
    assert!(build(&public, true)
        .err()
        .unwrap()
        .contains("Compose service host"));
}

#[test]
fn settings_without_a_host_stay_unconfigured_but_invalid_security_fails() {
    assert!(build(&[], false).unwrap().is_none());
    assert!(build(&[("KORDI_AUTH_SMTP_SECURITY", "none".into())], false)
        .unwrap()
        .is_none());
    assert!(build(&[("KORDI_AUTH_SMTP_SECURITY", "plain".into())], true).is_err());
}

#[test]
fn tls_settings_still_require_credentials() {
    let mut values = vec![
        ("KORDI_AUTH_SMTP_HOST", "smtp.example.com".to_string()),
        ("KORDI_AUTH_SMTP_FROM", "team@example.com".to_string()),
    ];
    assert!(build(&values, false).unwrap().is_none());
    values.push(("KORDI_AUTH_SMTP_USERNAME", "team@example.com".into()));
    values.push(("KORDI_AUTH_SMTP_PASSWORD", "synthetic-password".into()));
    assert!(build(&values, false).unwrap().is_some());
    values.push(("KORDI_AUTH_SMTP_SECURITY", "tls".into()));
    assert!(build(&values, false).unwrap().is_some());
}

/// A minimal mail catcher that advertises neither STARTTLS nor AUTH and
/// records every line the client sends.
async fn catch_one_message(listener: tokio::net::TcpListener) -> Vec<String> {
    let (stream, _) = listener.accept().await.unwrap();
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    write.write_all(b"220 catcher ESMTP\r\n").await.unwrap();
    let mut transcript = Vec::new();
    let mut in_data = false;
    while let Some(line) = lines.next_line().await.unwrap() {
        transcript.push(line.clone());
        let reply: &[u8] = if in_data {
            if line != "." {
                continue;
            }
            in_data = false;
            b"250 queued\r\n"
        } else {
            let command = line.to_ascii_uppercase();
            if command.starts_with("EHLO") {
                b"250-catcher\r\n250 8BITMIME\r\n"
            } else if command.starts_with("DATA") {
                in_data = true;
                b"354 send data\r\n"
            } else if command.starts_with("QUIT") {
                write.write_all(b"221 bye\r\n").await.unwrap();
                break;
            } else {
                b"250 OK\r\n"
            }
        };
        write.write_all(reply).await.unwrap();
    }
    transcript
}

#[tokio::test]
async fn plaintext_delivers_a_code_to_a_local_catcher_without_tls_or_auth() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port().to_string();
    let catcher = tokio::spawn(catch_one_message(listener));
    let sender = build(&mailpit_settings("127.0.0.1", &port), true)
        .unwrap()
        .unwrap();
    sender
        .send_code("new-member@example.test", "123456")
        .await
        .unwrap();
    let transcript = tokio::time::timeout(Duration::from_secs(5), catcher)
        .await
        .unwrap()
        .unwrap();
    assert!(transcript.iter().any(|line| line.contains("123456")));
    assert!(transcript
        .iter()
        .any(|line| line.eq_ignore_ascii_case("RCPT TO:<new-member@example.test>")));
    assert!(!transcript.iter().any(|line| {
        let command = line.to_ascii_uppercase();
        command.starts_with("STARTTLS") || command.starts_with("AUTH")
    }));
}
