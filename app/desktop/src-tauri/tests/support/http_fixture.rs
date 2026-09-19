use std::{
    io::{BufRead, BufReader, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use tauri::{
    ipc::{CallbackFn, InvokeBody, InvokeResponseBody},
    test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY},
    webview::InvokeRequest,
    Manager, WebviewWindow,
};

pub struct Desktop {
    window: Option<WebviewWindow<MockRuntime>>,
    app: Option<tauri::App<MockRuntime>>,
    cache: PathBuf,
}
impl Desktop {
    pub fn new() -> Self {
        let mut context = tauri::generate_context!();
        context.config_mut().identifier =
            format!("io.kordi.cloud.http-test-{}", uuid::Uuid::new_v4());
        let app = mock_builder()
            .plugin(tauri_plugin_http::init())
            .build(context)
            .unwrap();
        let cache = app.path().app_cache_dir().unwrap();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        Self {
            window: Some(window),
            app: Some(app),
            cache,
        }
    }
    pub fn window(&self) -> WebviewWindow<MockRuntime> {
        self.window.as_ref().unwrap().clone()
    }
    pub fn invoke(
        &self,
        command: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, serde_json::Value> {
        raw(&self.window(), command, body).map(|r| r.deserialize().unwrap())
    }
    pub fn drain(&self, rid: &serde_json::Value) -> Vec<u8> {
        let mut bytes = Vec::new();
        loop {
            let response = raw(
                &self.window(),
                "fetch_read_body",
                serde_json::json!({"rid":rid}),
            )
            .unwrap();
            let chunk = match response {
                InvokeResponseBody::Raw(bytes) => bytes,
                InvokeResponseBody::Json(value) => serde_json::from_str(&value).unwrap(),
            };
            if chunk == [1] {
                return bytes;
            }
            assert_eq!(chunk.last(), Some(&0));
            bytes.extend_from_slice(&chunk[..chunk.len() - 1]);
        }
    }
}
impl Drop for Desktop {
    fn drop(&mut self) {
        drop(self.window.take());
        drop(self.app.take());
        let _ = std::fs::remove_dir_all(&self.cache);
    }
}
pub fn raw(
    window: &WebviewWindow<MockRuntime>,
    command: &str,
    body: serde_json::Value,
) -> Result<InvokeResponseBody, serde_json::Value> {
    get_ipc_response(
        window,
        InvokeRequest {
            cmd: format!("plugin:http|{command}"),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
}

pub struct Server {
    pub address: SocketAddr,
    pub connections: Arc<AtomicUsize>,
    pub requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}
impl Server {
    pub fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let connections = Arc::new(AtomicUsize::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (count, log, stopped) = (connections.clone(), requests.clone(), stop.clone());
        let worker = thread::spawn(move || {
            let mut workers = Vec::new();
            while !stopped.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        count.fetch_add(1, Ordering::SeqCst);
                        let (log, stopped) = (log.clone(), stopped.clone());
                        workers.push(thread::spawn(move || serve(stream, address, log, stopped)));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(e) => panic!("test listener failed: {e}"),
                }
            }
            for worker in workers {
                worker.join().unwrap();
            }
        });
        Self {
            address,
            connections,
            requests,
            stop,
            worker: Some(worker),
        }
    }
    pub fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.address)
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.worker.take().unwrap().join().unwrap();
    }
}
fn serve(
    mut stream: TcpStream,
    address: SocketAddr,
    log: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
) {
    stream
        .set_read_timeout(Some(Duration::from_millis(200)))
        .unwrap();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    while !stop.load(Ordering::SeqCst) {
        let mut request = String::new();
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => return,
                Ok(_) => {}
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    if stop.load(Ordering::SeqCst) {
                        return;
                    }
                    continue;
                }
                Err(_) => return,
            }
            if line == "\r\n" {
                break;
            }
            request.push_str(&line);
        }
        let path = request.split_whitespace().nth(1).unwrap_or("").to_string();
        log.lock().unwrap().push(request);
        if path == "/slow" {
            while !stop.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(5));
            }
            return;
        }
        let response = match path.as_str() {
            "/redirect" => format!("HTTP/1.1 302 Found\r\nLocation: http://{address}/final\r\nContent-Length: 0\r\n\r\n"),
            "/stream" => "HTTP/1.1 200 OK\r\nContent-Length: 1024\r\n\r\na".to_string(),
            "/first" => "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nSet-Cookie: fixture_session=one; Path=/\r\n\r\nok".to_string(),
            _ => "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok".to_string(),
        };
        if stream.write_all(response.as_bytes()).is_err() {
            return;
        }
        if path == "/stream" {
            while !stop.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(5));
            }
            return;
        }
    }
}
