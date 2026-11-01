#[tokio::main]
async fn main() {
    if kordi_cloud_server::human_simulator::serve().await.is_err() {
        eprintln!(
            "Simulator API startup or shutdown failed; verify private service configuration."
        );
        std::process::exit(1);
    }
}
