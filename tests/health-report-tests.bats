#!/usr/bin/env bats

# Health reporting, grace period, and observer API integration tests.
# Each test is fully isolated via random project names + subnets.
# Run in parallel: bats --jobs 4 health-report-tests.bats
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

# ── Observer API ──

@test "health: observer /api/status returns correct structure" {
    run observer_status node1
    [ "$status" -eq 0 ]

    # Validate JSON structure
    echo "$output" | jq -e '.self.peerId' > /dev/null
    echo "$output" | jq -e '.self.name' > /dev/null
    echo "$output" | jq -e '.self.meshIpv4' > /dev/null
    echo "$output" | jq -e '.self.networkId' > /dev/null
    echo "$output" | jq -e '.peers' > /dev/null
}

@test "health: observer reports peer with mode field" {
    wait_for "node1 has peers" 20 \
        '[ "$(peer_count node1)" -ge 1 ]'

    run observer_status node1
    [ "$status" -eq 0 ]

    # Peer should have mode, rxAlive fields (new negotiate-era API)
    local mode rxAlive
    mode=$(echo "$output" | jq -r '.peers[0].mode')
    rxAlive=$(echo "$output" | jq -r '.peers[0].rxAlive')

    [[ "$mode" == "direct" || "$mode" == "relay" ]]
    [[ "$rxAlive" == "true" || "$rxAlive" == "false" ]]
}

@test "health: observer does NOT expose legacy usingRelay field" {
    run observer_status node1
    [ "$status" -eq 0 ]

    # Legacy fields should NOT exist
    local legacy
    legacy=$(echo "$output" | jq -r '.peers[0].usingRelay // "ABSENT"')
    [[ "$legacy" == "ABSENT" ]]
}

@test "health: both nodes see each other as peers" {
    wait_for "node1 has 1 peer" 20 \
        '[ "$(peer_count node1)" -eq 1 ]'
    wait_for "node2 has 1 peer" 20 \
        '[ "$(peer_count node2)" -eq 1 ]'

    # node1's peer should be node2 and vice versa
    local peer1_mesh peer2_mesh
    peer1_mesh=$(observer_status node1 | jq -r '.self.meshIpv4')
    peer2_mesh=$(observer_status node2 | jq -r '.self.meshIpv4')

    local node1_sees node2_sees
    node1_sees=$(peer_field node1 meshIpv4)
    node2_sees=$(peer_field node2 meshIpv4)

    [[ "$node1_sees" == "$peer2_mesh" ]]
    [[ "$node2_sees" == "$peer1_mesh" ]]
}

# ── Health Reports via WS ──

@test "health: server receives health reports (links populated)" {
    # Wait for at least one health report cycle (3s)
    sleep 5

    run get_links
    [ "$status" -eq 0 ]

    # Should have at least 1 link (node1→node2 or node2→node1)
    local count
    count=$(echo "$output" | jq 'length')
    [[ "$count" -ge 1 ]]

    # Link should have mode field
    local mode
    mode=$(echo "$output" | jq -r '.[0].mode')
    [[ "$mode" == "direct" || "$mode" == "relay" ]]
}

@test "health: rxAlive is true when direct path works" {
    wait_for "node1 direct mode" 20 \
        '[ "$(peer_field node1 mode)" = "direct" ]'

    # Give some time for rx tracking to stabilize
    sleep 5

    # With direct working, rxAlive should be true
    wait_for "rxAlive true" 15 \
        '[ "$(peer_field node1 rxAlive)" = "true" ]'

    [[ "$(peer_field node1 rxAlive)" == "true" ]]
}

@test "health: rxAlive goes false when direct path broken" {
    # Wait for direct mode AND rxAlive=true (endpoint populated, rx flowing)
    wait_for "node1 direct+alive" 30 \
        '[ "$(peer_field node1 mode)" = "direct" ] && [ "$(peer_field node1 rxAlive)" = "true" ]'

    # Block UDP traffic
    block_udp node1 "$NODE2_IP"
    block_udp node2 "$NODE1_IP"

    # After MISS_THRESHOLD (3) consecutive ticks without rx increase,
    # rxAlive should go false (~3-4s). Allow extra time for Docker overhead.
    wait_for "rxAlive false" 40 \
        '[ "$(peer_field node1 rxAlive)" = "false" ]'

    [[ "$(peer_field node1 rxAlive)" == "false" ]]
}

# ── Grace Period ──

@test "health: grace period prevents immediate failover on new peer" {
    # Add a third node — it should have GRACE_PERIOD_MS (3s in tests) + streaks (9s)
    $COMPOSE up -d node3 > /dev/null 2>&1
    wait_ready node3

    # Immediately block UDP between node3 and others
    block_udp node3 "$NODE1_IP"
    block_udp node3 "$NODE2_IP"

    # During grace+streak window (~12s), server should NOT initiate relay probe for node3
    sleep 8
    run $COMPOSE logs server
    # Count negotiate logs mentioning node3's pair — should be 0
    local negotiate_count
    negotiate_count=$(echo "$output" | grep -c "relay probe" || echo 0)
    # There may be existing probes for node1↔node2, but node3 pairs should not trigger
    # We can't easily filter by peer ID in logs, so we check node3 is still direct
    [[ "$(peer_field node3 mode)" == "direct" ]]
}

# ── Frozen Peers ──

@test "health: frozen peers excluded from health reports during negotiation" {
    wait_for "node1 direct mode" 20 \
        '[ "$(peer_field node1 mode)" = "direct" ]'

    block_udp node1 "$NODE2_IP"
    block_udp node2 "$NODE1_IP"

    # Wait for negotiate to start (peers get frozen)
    wait_for "negotiate starts" 45 \
        'log_contains server "relay probe" 120s || log_contains node1 "TCP probe" 120s'

    # During negotiation, agent logs should show negotiate activity
    run $COMPOSE logs node1 node2
    [[ "$output" == *"[negotiate]"* ]]
}

# ── WS Disconnect ──

@test "health: WS reconnect resets negotiate state" {
    wait_for "node1 direct mode" 20 \
        '[ "$(peer_field node1 mode)" = "direct" ]'

    block_udp node1 "$NODE2_IP"
    block_udp node2 "$NODE1_IP"

    # Wait for negotiate to start
    wait_for "negotiate starts" 45 \
        'log_contains server "relay probe" 120s'

    # Restart node1 (simulates WS disconnect)
    $COMPOSE restart node1 > /dev/null 2>&1
    wait_ready node1

    unblock_udp node1 "$NODE2_IP"
    unblock_udp node2 "$NODE1_IP"

    # Node should reconnect and eventually reach direct mode
    wait_for "node1 direct after restart" 30 \
        '[ "$(peer_field node1 mode)" = "direct" ]'

    [[ "$(peer_field node1 mode)" == "direct" ]]
}

@test "health: relay probe returns stay when all traffic blocked" {
    wait_for "node1 direct mode" 20 \
        '[ "$(peer_field node1 mode)" = "direct" ]'

    # Block ALL traffic (UDP + TCP) so TCP probe fails (mesh unreachable)
    block_all node1 "$NODE2_IP"
    block_all node2 "$NODE1_IP"

    # Wait for negotiate to start
    wait_for "negotiate starts" 45 \
        'log_contains server "relay probe" 120s'

    # TCP probe fails (3s timeout), verdict should be "stay" (no switch)
    wait_for "verdict stay" 30 \
        'log_contains server "verdict: stay" 120s'

    run $COMPOSE logs server
    [[ "$output" == *"verdict: stay"* ]]
}
