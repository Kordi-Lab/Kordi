use super::tests::{leased_run, FakeClient};
use super::*;

#[tokio::test]
async fn never_runs_a_memory_import() {
    let client = FakeClient::with_run(leased_run("import_fixture", true));
    let outcome = process_one_run(&client).await.unwrap();
    assert_eq!(
        outcome,
        RunnerStepOutcome::SkippedCancelled {
            run_id: "import_fixture".to_string()
        }
    );
    assert_eq!(client.calls(), vec!["lease"]);
}
