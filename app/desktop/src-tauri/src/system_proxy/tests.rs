use super::{
    plan_proxy_environment, translate_system_exclusion, ProxySource, SystemProxySettings,
    REQUIRED_DIRECT_HOSTS,
};
use std::{
    collections::BTreeMap,
    net::{Ipv4Addr, TcpListener},
};

fn environment(values: &[(&str, &str)]) -> BTreeMap<String, String> {
    values
        .iter()
        .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
        .collect()
}

fn unused_local_proxy_url(scheme: &str) -> String {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("allocate test proxy port");
    let address = listener.local_addr().expect("test proxy address");
    format!("{scheme}://{address}")
}

fn system_proxy() -> SystemProxySettings {
    let proxy_url = unused_local_proxy_url("http");
    SystemProxySettings {
        http_url: Some(proxy_url.clone()),
        https_url: Some(proxy_url),
        exclusions: vec!["*.internal.example".to_string(), "10.0.0.0/8".to_string()],
        ..SystemProxySettings::default()
    }
}

#[test]
fn system_http_and_https_proxies_are_installed_when_environment_is_empty() {
    let settings = system_proxy();
    let expected_proxy = settings.http_url.as_deref();
    let plan = plan_proxy_environment(&environment(&[]), Some(&settings));

    assert_eq!(plan.source, ProxySource::MacOsSystem);
    assert_eq!(plan.value("HTTP_PROXY"), expected_proxy);
    assert_eq!(plan.value("http_proxy"), expected_proxy);
    assert_eq!(plan.value("HTTPS_PROXY"), expected_proxy);
    assert_eq!(plan.value("https_proxy"), expected_proxy);
    assert_eq!(
        plan.value("NO_PROXY"),
        Some("localhost,127.0.0.1,::1,.internal.example,10.0.0.0/8")
    );
}

#[test]
fn explicit_all_proxy_has_precedence_over_every_system_proxy() {
    let explicit_proxy = unused_local_proxy_url("socks5h");
    let existing = environment(&[("ALL_PROXY", explicit_proxy.as_str())]);
    let plan = plan_proxy_environment(&existing, Some(&system_proxy()));

    assert_eq!(plan.source, ProxySource::ExplicitEnvironment);
    assert_eq!(plan.value("HTTP_PROXY"), None);
    assert_eq!(plan.value("HTTPS_PROXY"), None);
}

#[test]
fn explicit_scheme_proxy_is_preserved_while_missing_scheme_uses_system() {
    let explicit_proxy = unused_local_proxy_url("http");
    let existing = environment(&[("https_proxy", explicit_proxy.as_str())]);
    let settings = system_proxy();
    let expected_http_proxy = settings.http_url.as_deref();
    let plan = plan_proxy_environment(&existing, Some(&settings));

    assert_eq!(plan.source, ProxySource::ExplicitEnvironment);
    assert_eq!(plan.value("HTTPS_PROXY"), None);
    assert_eq!(plan.value("https_proxy"), None);
    assert_eq!(plan.value("HTTP_PROXY"), expected_http_proxy);
}

#[test]
fn uppercase_and_lowercase_no_proxy_are_merged_with_loopback_and_system_exclusions() {
    let existing = environment(&[
        ("NO_PROXY", "api.example, localhost"),
        ("no_proxy", ".corp.example,API.EXAMPLE"),
    ]);
    let plan = plan_proxy_environment(&existing, Some(&system_proxy()));
    let entries = plan
        .value("NO_PROXY")
        .expect("NO_PROXY update")
        .split(',')
        .collect::<Vec<_>>();

    for expected in [
        "api.example",
        ".corp.example",
        ".internal.example",
        "10.0.0.0/8",
    ] {
        assert!(entries.contains(&expected), "missing {expected:?}");
    }
    for loopback in REQUIRED_DIRECT_HOSTS {
        assert!(entries.contains(&loopback), "missing {loopback:?}");
    }
    assert_eq!(
        entries
            .iter()
            .filter(|entry| **entry == "localhost")
            .count(),
        1
    );
    assert_eq!(
        entries
            .iter()
            .filter(|entry| **entry == "api.example")
            .count(),
        1
    );
    assert_eq!(plan.value("NO_PROXY"), plan.value("no_proxy"));
}

#[test]
fn disabled_system_proxy_does_not_install_proxy_endpoints() {
    let plan = plan_proxy_environment(&environment(&[]), Some(&SystemProxySettings::default()));

    assert_eq!(plan.source, ProxySource::Direct);
    assert_eq!(plan.value("HTTP_PROXY"), None);
    assert_eq!(plan.value("HTTPS_PROXY"), None);
    assert_eq!(plan.value("NO_PROXY"), Some("localhost,127.0.0.1,::1"));
}

#[test]
fn automatic_configuration_with_static_fallback_reports_limitation() {
    let proxy_url = unused_local_proxy_url("http");
    let settings = SystemProxySettings {
        http_url: Some(proxy_url.clone()),
        socks_url: Some(unused_local_proxy_url("socks5h")),
        automatic_configuration: true,
        ..SystemProxySettings::default()
    };
    let plan = plan_proxy_environment(&environment(&[]), Some(&settings));

    assert!(plan.automatic_configuration_unsupported);
    assert!(!plan.socks_only_unsupported);
    assert_eq!(plan.source, ProxySource::MacOsSystem);
    assert_eq!(plan.value("HTTP_PROXY"), Some(proxy_url.as_str()));
}

#[test]
fn socks_only_setting_reports_actionable_unsupported_state() {
    let settings = SystemProxySettings {
        socks_url: Some(unused_local_proxy_url("socks5h")),
        ..SystemProxySettings::default()
    };
    let plan = plan_proxy_environment(&environment(&[]), Some(&settings));

    assert!(plan.socks_only_unsupported);
    assert_eq!(plan.source, ProxySource::Direct);
}

#[test]
fn macos_suffix_wildcards_translate_to_no_proxy_domains() {
    assert_eq!(
        translate_system_exclusion("*.example.com"),
        Some(".example.com".to_string())
    );
    assert_eq!(translate_system_exclusion("*middle.example.com"), None);
    assert_eq!(
        translate_system_exclusion("<local>"),
        Some("localhost".to_string())
    );
    assert_eq!(translate_system_exclusion("*"), Some("*".to_string()));
    assert_eq!(
        translate_system_exclusion("169.254/16"),
        Some("169.254.0.0/16".to_string())
    );
    assert_eq!(
        translate_system_exclusion("10/8"),
        Some("10.0.0.0/8".to_string())
    );
}

#[cfg(target_os = "macos")]
#[test]
fn macos_local_proxy_routes_both_native_http_stacks_and_bypasses_loopback() {
    const CHILD_MARKER: &str = "KORDI_MACOS_PROXY_INTEGRATION_CHILD";
    if std::env::var_os(CHILD_MARKER).is_some() {
        run_macos_local_proxy_integration_child();
        return;
    }

    let current_exe = std::env::current_exe().expect("current test executable");
    let mut child = std::process::Command::new(current_exe);
    child
        .args([
            "--exact",
            "system_proxy::tests::macos_local_proxy_routes_both_native_http_stacks_and_bypasses_loopback",
            "--nocapture",
        ])
        .env(CHILD_MARKER, "1");
    for key in super::TRACKED_ENVIRONMENT_KEYS {
        child.env_remove(key);
    }
    let output = child.output().expect("spawn isolated proxy test");
    assert!(
        output.status.success(),
        "isolated proxy test failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(target_os = "macos")]
fn run_macos_local_proxy_integration_child() {
    use std::{
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        thread,
        time::Duration,
    };

    fn read_request(stream: &mut TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("set request read timeout");
        let mut request = Vec::new();
        let mut buffer = [0_u8; 1024];
        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
            let count = stream.read(&mut buffer).expect("read proxy request");
            assert!(count > 0, "proxy request closed before headers");
            request.extend_from_slice(&buffer[..count]);
            assert!(request.len() < 16 * 1024, "proxy request headers too large");
        }
        String::from_utf8(request).expect("ASCII proxy request")
    }

    fn write_response(stream: &mut TcpStream, body: &str) {
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .expect("write local HTTP response");
    }

    fn reject_tunnel(stream: &mut TcpStream) {
        write!(
            stream,
            "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
        .expect("reject local proxy tunnel");
    }

    // Match the updater plugin's initialization before constructing its
    // reqwest 0.13 client.
    let _ = rustls::crypto::ring::default_provider().install_default();

    let proxy = TcpListener::bind(("127.0.0.1", 0)).expect("bind local proxy");
    proxy.set_nonblocking(false).expect("configure local proxy");
    let proxy_port = proxy.local_addr().expect("proxy address").port();
    let proxy_thread = thread::spawn(move || {
        for expected_path in ["/provider", "/updater"] {
            let (mut stream, _) = proxy.accept().expect("accept proxied request");
            let request = read_request(&mut stream);
            let request_line = request.lines().next().unwrap_or_default();
            assert!(
                request_line.starts_with("GET http://kordi-proxy-test.invalid")
                    && request_line.contains(expected_path),
                "request did not use the local forwarding proxy: {request_line:?}"
            );
            write_response(&mut stream, "proxied");
        }
        for _ in 0..2 {
            let (mut stream, _) = proxy.accept().expect("accept HTTPS proxy tunnel");
            let request = read_request(&mut stream);
            let request_line = request.lines().next().unwrap_or_default();
            assert_eq!(
                request_line, "CONNECT kordi-proxy-test.invalid:443 HTTP/1.1",
                "HTTPS request did not use the local forwarding proxy"
            );
            reject_tunnel(&mut stream);
        }
    });

    let settings = SystemProxySettings {
        http_url: Some(format!("http://127.0.0.1:{proxy_port}")),
        https_url: Some(format!("http://127.0.0.1:{proxy_port}")),
        ..SystemProxySettings::default()
    };
    let plan = plan_proxy_environment(&BTreeMap::new(), Some(&settings));
    for (key, value) in plan.updates {
        unsafe { std::env::set_var(key, value) };
    }

    let provider_response = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("build provider HTTP client")
        .get("http://kordi-proxy-test.invalid/provider")
        .send()
        .expect("provider request through proxy")
        .text()
        .expect("provider response body");
    assert_eq!(provider_response, "proxied");

    let updater_response = reqwest_updater_stack::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("build updater HTTP client")
        .get("http://kordi-proxy-test.invalid/updater")
        .send()
        .expect("updater request through proxy")
        .text()
        .expect("updater response body");
    assert_eq!(updater_response, "proxied");

    let provider_secure_result = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("build secure provider HTTP client")
        .get("https://kordi-proxy-test.invalid/provider")
        .send();
    assert!(
        provider_secure_result.is_err(),
        "test proxy should reject provider CONNECT"
    );
    let updater_secure_result = reqwest_updater_stack::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("build secure updater HTTP client")
        .get("https://kordi-proxy-test.invalid/updater")
        .send();
    assert!(
        updater_secure_result.is_err(),
        "test proxy should reject updater CONNECT"
    );
    proxy_thread.join().expect("local proxy thread");

    let direct = TcpListener::bind(("127.0.0.1", 0)).expect("bind loopback server");
    let direct_port = direct.local_addr().expect("loopback address").port();
    let direct_thread = thread::spawn(move || {
        for expected_path in ["/provider-direct", "/updater-direct"] {
            let (mut stream, _) = direct.accept().expect("accept direct request");
            let request = read_request(&mut stream);
            let expected_prefix = format!("GET {expected_path} ");
            assert!(
                request
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .starts_with(&expected_prefix),
                "loopback request unexpectedly used proxy form"
            );
            write_response(&mut stream, "direct");
        }
    });
    let direct_response = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("build loopback HTTP client")
        .get(format!("http://127.0.0.1:{direct_port}/provider-direct"))
        .send()
        .expect("direct loopback request")
        .text()
        .expect("direct response body");
    assert_eq!(direct_response, "direct");
    let updater_direct_response = reqwest_updater_stack::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("build updater loopback HTTP client")
        .get(format!("http://127.0.0.1:{direct_port}/updater-direct"))
        .send()
        .expect("direct updater loopback request")
        .text()
        .expect("direct updater response body");
    assert_eq!(updater_direct_response, "direct");
    direct_thread.join().expect("loopback server thread");
}
