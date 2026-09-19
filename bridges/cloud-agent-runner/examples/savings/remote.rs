//! Optional task-owned SSH transport. The benchmark never receives the remote API key.
use serde_json::Value;
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex,
};

struct Pipes {
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    _child: Child,
}
pub struct Remote {
    pub model: String,
    pipes: Mutex<Pipes>,
}
impl Remote {
    pub async fn start(helper: &str) -> anyhow::Result<Self> {
        let mut child = Command::new(helper)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let input = child.stdin.take().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(45), output.read_line(&mut line)).await??;
        let ready: Value = serde_json::from_str(&line)?;
        anyhow::ensure!(
            ready["ready"] == true,
            "Remote development provider unavailable"
        );
        let model = ready["model"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Remote model missing"))?
            .to_string();
        Ok(Self {
            model,
            pipes: Mutex::new(Pipes {
                input,
                output,
                _child: child,
            }),
        })
    }
    pub async fn complete(&self, body: &Value) -> Result<Value, &'static str> {
        let mut pipes = self.pipes.lock().await;
        let text = serde_json::to_string(body).map_err(|_| "Invalid benchmark request")? + "\n";
        pipes
            .input
            .write_all(text.as_bytes())
            .await
            .map_err(|_| "Remote provider pipe closed")?;
        pipes
            .input
            .flush()
            .await
            .map_err(|_| "Remote provider pipe closed")?;
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(70), pipes.output.read_line(&mut line))
            .await
            .map_err(|_| "Remote provider timed out")?
            .map_err(|_| "Remote provider pipe closed")?;
        serde_json::from_str(&line).map_err(|_| "Invalid remote provider response")
    }
}
