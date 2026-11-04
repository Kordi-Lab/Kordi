use super::*;

fn endpoint(url: &str) -> Endpoint {
    Endpoint::of(&PgConnectOptions::from_str(url).unwrap())
}

#[test]
fn loopback_hosts_and_sockets_are_local() {
    for url in [
        "postgresql://postgres@127.0.0.1:5432/postgres",
        "postgresql://postgres@127.0.0.2/postgres",
        "postgresql://postgres@localhost/postgres",
        "postgresql://postgres@LOCALHOST:5433/postgres",
        "postgresql://postgres@[::1]:5432/postgres",
        "postgresql://postgres@127.0.0.1/postgres?sslmode=disable",
    ] {
        assert!(endpoint(url).is_local(), "{url}");
        assert!(local_server(url).is_ok(), "{url}");
    }
    // A Unix socket is always on this machine.
    let socket = endpoint("postgresql:///postgres?host=/tmp");
    assert_eq!(socket, Endpoint::Socket("/tmp".into()));
    assert!(socket.is_local());
    assert!(endpoint("postgresql://%2Ftmp/postgres").is_local());
}

#[test]
fn remote_hosts_are_refused_before_connecting() {
    for url in [
        "postgresql://postgres@db.example.test:5432/postgres",
        "postgresql://postgres@10.0.0.5/postgres",
        "postgresql://postgres@[2001:db8::1]/postgres",
        "postgresql://postgres@localhost.example.test/postgres",
        // The parsed host wins over the URL authority.
        "postgresql://postgres@127.0.0.1/postgres?host=db.example.test",
        "postgresql://postgres@localhost/postgres?hostaddr=10.0.0.5",
        "postgresql://postgres@127.0.0.1@db.example.test/postgres",
    ] {
        let error = local_server(url).unwrap_err().to_string();
        assert!(error.contains("on this machine"), "{url}: {error}");
    }
    assert!(local_server("not a url").is_err());
}

#[test]
fn generated_names_are_unique_and_disposable() {
    let first = new_name();
    let second = new_name();
    assert_ne!(first, second);
    for name in [&first, &second] {
        assert!(is_disposable_name(name), "{name}");
        assert!(name.starts_with(&format!("kordi_eval_{}_", std::process::id())));
    }
}

#[test]
fn only_generated_names_are_disposable() {
    assert!(is_disposable_name("kordi_eval_123_1700000000_abcdef01"));
    for name in [
        "",
        "kordi_eval_",
        "postgres",
        "kordi_cloud",
        "kordi_eval_X",
        "kordi_eval_1; DROP DATABASE postgres",
        "kordi_eval_1\"",
        "kordi_eval_1-2",
        &format!("kordi_eval_{}", "1".repeat(60)),
    ] {
        assert!(!is_disposable_name(name), "{name}");
    }
}

#[test]
fn the_run_database_url_keeps_the_server_and_replaces_the_database() {
    let name = "kordi_eval_1_2_abcdef01";
    let url = url_for(
        "postgresql://postgres:secret@127.0.0.1:57775/postgres?sslmode=disable&dbname=other",
        name,
    )
    .unwrap();
    let options = PgConnectOptions::from_str(&url).unwrap();
    assert_eq!(options.get_database(), Some(name));
    assert_eq!(options.get_host(), "127.0.0.1");
    assert_eq!(options.get_port(), 57775);
    assert_eq!(options.get_username(), "postgres");
    assert!(url.contains("sslmode=disable"), "{url}");
    assert!(!url.contains("dbname"), "{url}");

    let socket = url_for("postgresql:///postgres?host=/tmp", name).unwrap();
    let options = PgConnectOptions::from_str(&socket).unwrap();
    assert_eq!(options.get_database(), Some(name));
    assert_eq!(Endpoint::of(&options), Endpoint::Socket("/tmp".into()));

    assert!(url_for("postgresql://127.0.0.1/postgres", "postgres").is_err());
}
