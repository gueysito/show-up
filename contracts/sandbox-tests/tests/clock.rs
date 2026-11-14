mod common;

#[tokio::test]
async fn sandbox_clock_matches_pinned_fast_mode() {
    let (worker, _node) = common::start_node().await;
    let before = worker.view_block().await.unwrap().timestamp();
    worker.fast_forward(100).await.unwrap();
    let after = worker.view_block().await.unwrap().timestamp();
    let delta_ms = (after - before) / 1_000_000;
    eprintln!("Sandbox 2.13.4: 100 skipped blocks advanced {delta_ms}ms");
    assert!(
        delta_ms >= 29_000,
        "Fast-forward did not advance the pinned clock (target includes normally produced blocks)"
    );
}
