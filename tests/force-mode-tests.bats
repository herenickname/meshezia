#!/usr/bin/env bats

# Force mode (admin override) integration tests.
# Each test is fully isolated via random project names + subnets.
# Run in parallel: bats --jobs 4 force-mode-tests.bats
#
# Prerequisites: docker compose build (images must exist)

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

# ── Force Relay ──

@test "force-mode: force-relay switches both peers to relay" {
    wait_for "node1 direct mode" 20 \
        '[ "$(peer_field node1 mode)" = "direct" ]'
    wait_for "node2 direct mode" 20 \
        '[ "$(peer_field node2 mode)" = "direct" ]'

    local peer1_id peer2_id
    peer1_id=$(self_peer_id node1)
    peer2_id=$(self_peer_id node2)

    # Admin forces relay
    force_mode "$peer1_id" "$peer2_id" "force-relay"

    # Both nodes should switch to relay without needing UDP block
    wait_for "node1 relay after force" 15 \
        '[ "$(peer_field node1 mode)" = "relay" ]'
    wait_for "node2 relay after force" 15 \
        '[ "$(peer_field node2 mode)" = "relay" ]'

    [[ "$(peer_field node1 mode)" == "relay" ]]
    [[ "$(peer_field node2 mode)" == "relay" ]]
}

@test "force-mode: force-direct switches both peers to direct" {
    wait_for "node1 direct mode" 20 \
        '[ "$(peer_field node1 mode)" = "direct" ]'

    local peer1_id peer2_id
    peer1_id=$(self_peer_id node1)
    peer2_id=$(self_peer_id node2)

    # First force to relay
    force_mode "$peer1_id" "$peer2_id" "force-relay"
    wait_for "node1 relay" 15 \
        '[ "$(peer_field node1 mode)" = "relay" ]'

    # Then force back to direct
    force_mode "$peer1_id" "$peer2_id" "force-direct"

    wait_for "node1 direct after force" 20 \
        '[ "$(peer_field node1 mode)" = "direct" ]'
    wait_for "node2 direct after force" 20 \
        '[ "$(peer_field node2 mode)" = "direct" ]'

    [[ "$(peer_field node1 mode)" == "direct" ]]
    [[ "$(peer_field node2 mode)" == "direct" ]]
}

@test "force-mode: auto restores negotiation control" {
    wait_for "node1 direct mode" 20 \
        '[ "$(peer_field node1 mode)" = "direct" ]'

    local peer1_id peer2_id
    peer1_id=$(self_peer_id node1)
    peer2_id=$(self_peer_id node2)

    # Force relay, then back to auto
    force_mode "$peer1_id" "$peer2_id" "force-relay"
    wait_for "node1 relay" 15 \
        '[ "$(peer_field node1 mode)" = "relay" ]'

    force_mode "$peer1_id" "$peer2_id" "auto"

    # In auto mode, server should eventually probe direct and switch back
    # (since UDP is not blocked, direct probe will succeed)
    wait_for "node1 direct via auto" 60 \
        '[ "$(peer_field node1 mode)" = "direct" ]'

    [[ "$(peer_field node1 mode)" == "direct" ]]
}

@test "force-mode: forced mode blocks negotiate initiation" {
    wait_for "node1 direct mode" 20 \
        '[ "$(peer_field node1 mode)" = "direct" ]'

    local peer1_id peer2_id
    peer1_id=$(self_peer_id node1)
    peer2_id=$(self_peer_id node2)

    # Force direct mode
    force_mode "$peer1_id" "$peer2_id" "force-direct"
    sleep 2

    # Block UDP — would normally trigger relay failover
    block_udp node1 "$NODE2_IP"
    block_udp node2 "$NODE1_IP"

    # Wait enough time for grace period + streaks to build up
    sleep 35

    # Should still be in direct mode because forced
    [[ "$(peer_field node1 mode)" == "direct" ]]

    # Server logs should show "skipped: forced mode"
    run $COMPOSE logs server
    [[ "$output" == *"forced mode"* ]]
}

@test "force-mode: aborts active negotiation" {
    wait_for "node1 direct mode" 20 \
        '[ "$(peer_field node1 mode)" = "direct" ]'

    local peer1_id peer2_id
    peer1_id=$(self_peer_id node1)
    peer2_id=$(self_peer_id node2)

    # Block UDP to trigger negotiate
    block_udp node1 "$NODE2_IP"
    block_udp node2 "$NODE1_IP"

    # Wait for TCP probe phase (probe-relay-ready = TCP server started, ~3s before completion)
    wait_for "negotiate in TCP phase" 90 \
        'log_contains server "probe-relay-ready" 300s'

    # Force mode during active TCP probe — should abort negotiation
    force_mode "$peer1_id" "$peer2_id" "force-relay"

    # Should switch to relay (via force, not negotiate verdict)
    wait_for "node1 relay after abort" 15 \
        '[ "$(peer_field node1 mode)" = "relay" ]'

    # Server logs should show force-mode was applied
    run $COMPOSE logs server
    [[ "$output" == *"force-mode"* ]] || [[ "$output" == *"admin-force"* ]]
}

@test "force-mode: API validates parameters" {
    # Missing mode
    run curl -sf -X POST "$SERVER_URL/api/links/force-mode" \
        -H "Authorization: Bearer $ADMIN_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{"peerA":"aaa","peerB":"bbb"}'
    [[ "$status" -ne 0 ]]

    # Invalid mode value
    run curl -s -o /dev/null -w "%{http_code}" -X POST "$SERVER_URL/api/links/force-mode" \
        -H "Authorization: Bearer $ADMIN_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{"peerA":"aaa","peerB":"bbb","mode":"invalid"}'
    [[ "$output" == "400" ]]

    # No auth
    run curl -s -o /dev/null -w "%{http_code}" -X POST "$SERVER_URL/api/links/force-mode" \
        -H "Content-Type: application/json" \
        -d '{"peerA":"aaa","peerB":"bbb","mode":"force-relay"}'
    [[ "$output" == "401" ]]
}

@test "force-mode: AWG endpoint updates on force-relay" {
    wait_for "node1 direct mode" 20 \
        '[ "$(peer_field node1 mode)" = "direct" ]'

    local peer1_id peer2_id
    peer1_id=$(self_peer_id node1)
    peer2_id=$(self_peer_id node2)

    force_mode "$peer1_id" "$peer2_id" "force-relay"

    wait_for "node1 relay" 15 \
        '[ "$(peer_field node1 mode)" = "relay" ]'

    # AWG endpoint should point to localhost relay proxy
    run $COMPOSE exec -T node1 awg show all endpoints
    [[ "$output" == *"127.0.0.1"* ]]
}
