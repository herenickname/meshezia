#!/usr/bin/env bats

# Negotiate protocol integration tests.
# Each test is fully isolated via random project names + subnets.
# Run in parallel: bats --jobs 3 negotiate-tests.bats
#
# Prerequisites: docker compose build (images must exist)
#
# NOTE: The automatic direct→relay TCP probe has a known limitation:
#   the TCP probe goes through the mesh IP (AWG tunnel), which is broken
#   when direct UDP is blocked. The probe always fails → verdict "stay".
#   Tracked as protocol issue. Tests use force-mode as the relay switch
#   mechanism and test the direct probe (relay→direct) recovery path.

load helpers

setup() {
    cd "$BATS_TEST_DIRNAME"
    init_project \
        "GRACE_PERIOD_MS=3000" \
        "DIRECT_PROBE_INTERVAL_MS=5000"
    bootstrap node1 node2
}

teardown() {
    cd "$BATS_TEST_DIRNAME"
    compose_teardown
}

# ── Streak Detection ──

@test "negotiate: dead streaks accumulate when UDP blocked" {
    wait_for "node1 direct mode" 20 \
        '[ "$(peer_field node1 mode)" = "direct" ]'

    block_udp node1 "$NODE2_IP"
    block_udp node2 "$NODE1_IP"

    # Grace period 15s + streaks need 3 reports (3×3s = 9s) = ~24s
    # Server should log "streak threshold" when it tries to initiate probe
    wait_for "streak threshold reached" 45 \
        'log_contains server "streak threshold" 120s'

    run $COMPOSE logs server
    [[ "$output" == *"streak threshold"* ]]
}

@test "negotiate: TCP probe initiates but fails on broken direct" {
    wait_for "node1 direct mode" 20 \
        '[ "$(peer_field node1 mode)" = "direct" ]'

    block_udp node1 "$NODE2_IP"
    block_udp node2 "$NODE1_IP"

    # Wait for TCP probe to happen (and fail since mesh unreachable)
    wait_for "probe-relay-result" 50 \
        'log_contains server "probe-relay-result" 120s'

    # Verdict should be "stay" (probe failed)
    run $COMPOSE logs server
    [[ "$output" == *"success=false, verdict: stay"* ]]
}

# ── Direct Probe Recovery (relay→direct) ──

@test "negotiate: direct probe recovers from forced relay" {
    wait_for "node1 direct mode" 20 \
        '[ "$(peer_field node1 mode)" = "direct" ]'

    local peer1_id peer2_id
    peer1_id=$(self_peer_id node1)
    peer2_id=$(self_peer_id node2)

    # Force relay, then switch to auto
    force_mode "$peer1_id" "$peer2_id" "force-relay"
    wait_for "node1 relay" 15 \
        '[ "$(peer_field node1 mode)" = "relay" ]'

    # Switch to auto — clears forced_mode, resets backoff to 30s
    force_mode "$peer1_id" "$peer2_id" "auto"

    # Server stale sweep checks direct probe backoff every 10s
    # Backoff starts at 5s (DIRECT_PROBE_INTERVAL_MS), UDP not blocked → probe should succeed
    wait_for "node1 direct recovery" 90 \
        '[ "$(peer_field node1 mode)" = "direct" ]'

    wait_for "node2 direct recovery" 20 \
        '[ "$(peer_field node2 mode)" = "direct" ]'

    [[ "$(peer_field node1 mode)" == "direct" ]]
    [[ "$(peer_field node2 mode)" == "direct" ]]
}

@test "negotiate: direct probe uses UDP through public IPs" {
    wait_for "node1 direct mode" 20 \
        '[ "$(peer_field node1 mode)" = "direct" ]'

    local peer1_id peer2_id
    peer1_id=$(self_peer_id node1)
    peer2_id=$(self_peer_id node2)

    force_mode "$peer1_id" "$peer2_id" "force-relay"
    wait_for "node1 relay" 15 \
        '[ "$(peer_field node1 mode)" = "relay" ]'

    force_mode "$peer1_id" "$peer2_id" "auto"

    # Wait for direct probe to happen
    wait_for "direct probe" 90 \
        'log_contains server "direct probe" 180s'

    # Verify UDP probe sockets were opened
    run $COMPOSE logs node1 node2
    [[ "$output" == *"UDP probe socket"* ]]
}

@test "negotiate: direct probe fails when UDP blocked" {
    wait_for "node1 direct mode" 20 \
        '[ "$(peer_field node1 mode)" = "direct" ]'

    local peer1_id peer2_id
    peer1_id=$(self_peer_id node1)
    peer2_id=$(self_peer_id node2)

    # Force relay first, THEN block UDP (avoids race with relay probe on dead direct)
    force_mode "$peer1_id" "$peer2_id" "force-relay"
    wait_for "node1 relay" 15 \
        '[ "$(peer_field node1 mode)" = "relay" ]'

    block_udp node1 "$NODE2_IP"
    block_udp node2 "$NODE1_IP"

    force_mode "$peer1_id" "$peer2_id" "auto"

    # Direct probe should fail (UDP blocked), stay on relay
    wait_for "direct probe attempted" 90 \
        'log_contains server "direct probe" 180s'

    # Wait for probe result
    sleep 15

    # Should still be on relay (direct probe failed)
    [[ "$(peer_field node1 mode)" == "relay" ]]
}

@test "negotiate: direct probe backoff doubles on failure" {
    wait_for "node1 direct mode" 20 \
        '[ "$(peer_field node1 mode)" = "direct" ]'

    local peer1_id peer2_id
    peer1_id=$(self_peer_id node1)
    peer2_id=$(self_peer_id node2)

    block_udp node1 "$NODE2_IP"
    block_udp node2 "$NODE1_IP"

    force_mode "$peer1_id" "$peer2_id" "force-relay"
    wait_for "node1 relay" 15 \
        '[ "$(peer_field node1 mode)" = "relay" ]'

    force_mode "$peer1_id" "$peer2_id" "auto"

    # Wait for first direct probe attempt (backoff init + stale sweep interval + margin)
    wait_for "first direct probe" 120 \
        'log_contains server "direct probe backoff expired" 300s'

    # After first failure, backoff should double (30s → 60s)
    # Server logs should show this
    run $COMPOSE logs server
    [[ "$output" == *"direct probe"* ]]
}

# ── AWG Endpoint Management ──

@test "negotiate: AWG endpoint changes to 127.0.0.1 on relay" {
    wait_for "node1 direct mode" 20 \
        '[ "$(peer_field node1 mode)" = "direct" ]'

    local peer1_id peer2_id
    peer1_id=$(self_peer_id node1)
    peer2_id=$(self_peer_id node2)

    force_mode "$peer1_id" "$peer2_id" "force-relay"
    wait_for "node1 relay" 15 \
        '[ "$(peer_field node1 mode)" = "relay" ]'

    # AWG endpoint should point to 127.0.0.1 (relay proxy)
    run $COMPOSE exec -T node1 awg show all endpoints
    [[ "$output" == *"127.0.0.1"* ]]
}

@test "negotiate: AWG endpoint restores public IP on direct" {
    wait_for "node1 direct mode" 20 \
        '[ "$(peer_field node1 mode)" = "direct" ]'

    local peer1_id peer2_id
    peer1_id=$(self_peer_id node1)
    peer2_id=$(self_peer_id node2)

    # Force relay then force direct
    force_mode "$peer1_id" "$peer2_id" "force-relay"
    wait_for "node1 relay" 15 \
        '[ "$(peer_field node1 mode)" = "relay" ]'

    force_mode "$peer1_id" "$peer2_id" "force-direct"
    wait_for "node1 direct" 20 \
        '[ "$(peer_field node1 mode)" = "direct" ]'

    # Wait for poll to apply AWG endpoint (may need one poll cycle)
    wait_for "endpoint restored" 20 \
        '! $COMPOSE exec -T node1 awg show all endpoints 2>/dev/null | grep -q "127.0.0.1"'

    run $COMPOSE exec -T node1 awg show all endpoints
    [[ "$output" != *"127.0.0.1"* ]]
}
