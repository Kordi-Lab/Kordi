//! Run explicitly with NATS_SERVER_BINARY pointing to a local nats-server binary.
//! The test starts its own loopback server and removes only its temporary data.
use kordi_cloud_server::events::EventBus;
use std::{
    net::TcpListener,
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::Duration,
};

struct TestServer {
    child: Option<Child>,
    binary: String,
    directory: PathBuf,
    port: u16,
    token: String,
}
impl TestServer {
    fn start(&mut self) {
        self.child = Some(
            Command::new(&self.binary)
                .args([
                    "--jetstream",
                    "--auth",
                    &self.token,
                    "--addr",
                    "127.0.0.1",
                    "--port",
                    &self.port.to_string(),
                    "--store_dir",
                ])
                .arg(&self.directory)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
    }
    fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            child.wait().unwrap();
        }
    }
    async fn connect(&self) -> EventBus {
        let url = format!("nats://127.0.0.1:{}", self.port);
        for _ in 0..50 {
            if let Ok(bus) = EventBus::connect_with_token(&url, Some(&self.token)).await {
                return bus;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("Disposable NATS server failed to start");
    }
}
impl Drop for TestServer {
    fn drop(&mut self) {
        self.stop();
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

#[tokio::test]
#[ignore = "requires NATS_SERVER_BINARY; creates its own isolated server"]
async fn bootstrap_preserves_configuration_and_survives_restart() {
    let binary = std::env::var("NATS_SERVER_BINARY").expect("Set NATS_SERVER_BINARY");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let directory = std::env::temp_dir().join(format!("kordi-nats-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let mut server = TestServer {
        child: None,
        binary,
        directory,
        port,
        token: "synthetic-nats-test-token".to_string(),
    };
    server.start();
    let bus = server.connect().await;
    assert!(!bus.is_ready().await, "a connection alone is not readiness");
    let url = format!("nats://127.0.0.1:{}", server.port);
    assert!(EventBus::connect_with_token(&url, None).await.is_err());
    assert!(EventBus::connect_with_token(&url, Some("wrong-token"))
        .await
        .is_err());
    let bootstrap = Command::new(env!("CARGO_BIN_EXE_kordi-cloud-server"))
        .arg("initialize-event-stream")
        .env("NATS_URL", &url)
        .env("KORDI_NATS_TOKEN", &server.token)
        .output()
        .unwrap();
    assert!(
        bootstrap.status.success(),
        "Authenticated CLI bootstrap failed"
    );
    assert!(bus.is_ready().await, "CLI bootstrap must create the stream");
    bus.initialize_stream().await.unwrap();
    let js = async_nats::jetstream::new(bus.nats_client().unwrap());
    let mut config = js
        .get_stream("KORDI_EVENTS")
        .await
        .unwrap()
        .cached_info()
        .config
        .clone();
    config.max_age = Duration::from_secs(3600);
    js.update_stream(config).await.unwrap();
    bus.initialize_stream().await.unwrap();
    assert_eq!(
        js.get_stream("KORDI_EVENTS")
            .await
            .unwrap()
            .cached_info()
            .config
            .max_age,
        Duration::from_secs(3600)
    );
    let ack = js
        .publish("kordi.events.test", "synthetic-message".into())
        .await
        .unwrap()
        .await
        .unwrap();
    assert!(bus.is_ready().await);
    server.stop();
    server.start();
    let restarted = server.connect().await;
    restarted.initialize_stream().await.unwrap();
    let js = async_nats::jetstream::new(restarted.nats_client().unwrap());
    let stream = js.get_stream("KORDI_EVENTS").await.unwrap();
    let message = stream.get_raw_message(ack.sequence).await.unwrap();
    assert_eq!(message.payload.as_ref(), b"synthetic-message");
    assert_eq!(
        stream.cached_info().config.max_age,
        Duration::from_secs(3600)
    );
}
