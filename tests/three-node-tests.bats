#!/usr/bin/env bats

# 3-node mesh integration tests — verify pair isolation, partial failures, TTL reaper.
# Each test is fully isolated via random project names + subnets.
# Run in parallel: bats --jobs 3 three-node-tests.bats
#
# Prerequisites: docker compose build (images must exist)

load helpers

setup() {
    cd "$BATS_TEST_DIRNAME"
    init_project \
        "GRACE_PERIOD_MS=3000" \
        "DIRECT_PROBE_INTERVAL_MS=5000"
    bootstrap node1 node2 node3
}

teardown() {
    cd "$BATS_TEST_DIRNAME"
    compose_teardown
}

# ── 3-node mesh basics ──

@test "3node: all nodes see 2 peers each" {
    wait_for "node1 has 2 peers" 30 \
        '[ "$(peer_count node1)" -eq 2 ]'
    wait_for "node2 has 2 peers" 30 \
        '[ "$(peer_count node2)" -eq 2 ]'
    wait_for "node3 has 2 peers" 30 \
        '[ "$(peer_count node3)" -eq 2 ]'

    [[ "$(peer_count node1)" -eq 2 ]]
    [[ "$(peer_count node2)" -eq 2 ]]
    [[ "$(peer_count node3)" -eq 2 ]]
}

@test "3node: all pairs start in direct mode" {
    wait_for "node1 peers direct" 25 \
        '[ "$(observer_status node1 | jq "[.peers[].mode] | all(. == \"direct\")" )" = "true" ]'
    wait_for "node2 peers direct" 25 \
        '[ "$(observer_status node2 | jq "[.peers[].mode] | all(. == \"direct\")" )" = "true" ]'
    wait_for "node3 peers direct" 25 \
        '[ "$(observer_status node3 | jq "[.peers[].mode] | all(. == \"direct\")" )" = "true" ]'
}

# ── Pair isolation ──

@test "3node: force-relay on one pair does not affect others" {
    wait_for "all direct" 25 \
        '[ "$(observer_status node1 | jq "[.peers[].mode] | all(. == \"direct\")" )" = "true" ]'

    local peer1_id peer2_id peer3_id
    peer1_id=$(self_peer_id node1)
    peer2_id=$(self_peer_id node2)
    peer3_id=$(self_peer_id node3)

    # Force relay only for node1↔node2
    force_mode "$peer1_id" "$peer2_id" "force-relay"

    wait_for "node1→node2 relay" 40 \
        '[ "$(peer_field_by_id node1 '"$peer2_id"' mode)" = "relay" ]'

    # node1→node3 should still be direct
    [[ "$(peer_field_by_id node1 "$peer3_id" mode)" == "direct" ]]

    # node2→node3 should still be direct
    [[ "$(peer_field_by_id node2 "$peer3_id" mode)" == "direct" ]]

    # node3 should see all peers as direct (it's not affected)
    [[ "$(observer_status node3 | jq '[.peers[].mode] | all(. == "direct")')" == "true" ]]
}

@test "3node: two pairs can be forced to relay independently" {
    wait_for "all direct" 25 \
        '[ "$(observer_status node1 | jq "[.peers[].mode] | all(. == \"direct\")" )" = "true" ]'

    local peer1_id peer2_id peer3_id
    peer1_id=$(self_peer_id node1)
    peer2_id=$(self_peer_id node2)
    peer3_id=$(self_peer_id node3)

    # Force relay for node1↔node2 AND node1↔node3
    force_mode "$peer1_id" "$peer2_id" "force-relay"
    force_mode "$peer1_id" "$peer3_id" "force-relay"

    # Both pairs involving node1 should go relay
    wait_for "node1 all relay" 25 \
        '[ "$(observer_status node1 | jq "[.peers[].mode] | all(. == \"relay\")" )" = "true" ]'

    # node2↔node3 should still be direct (wait for node2 to have synced peers)
    wait_for "node2→node3 direct" 15 \
        '[ "$(peer_field_by_id node2 '"$peer3_id"' mode)" = "direct" ]'
}

# ── Node removal mid-mesh ──

@test "3node: removing a node cleans up peer state" {
    wait_for "all direct" 25 \
        '[ "$(observer_status node1 | jq "[.peers[].mode] | all(. == \"direct\")" )" = "true" ]'

    # Stop node3
    $COMPOSE stop node3 > /dev/null 2>&1

    # Delete node3 peer via API
    local peer3_id
    peer3_id=$(get_peers | jq -r '.[] | select(.name == "node-3") | .id')

    if [[ -n "$peer3_id" ]]; then
        curl -sf -X DELETE "$SERVER_URL/api/peers/$peer3_id" \
            -H "Authorization: Bearer $ADMIN_TOKEN" > /dev/null
    fi

    # Wait for remaining nodes to reconcile (next poll cycle)
    wait_for "node1 has 1 peer" 25 \
        '[ "$(peer_count node1)" -eq 1 ]'

    [[ "$(peer_count node1)" -eq 1 ]]
    [[ "$(peer_count node2)" -eq 1 ]]
}

@test "3node: peer-removed push triggers immediate reconcile" {
    wait_for "node1 has 2 peers" 30 \
        '[ "$(peer_count node1)" -eq 2 ]'

    local peer3_id
    peer3_id=$(get_peers | jq -r '.[] | select(.name == "node-3") | .id')

    # Delete node3 via API (should trigger WS push)
    curl -sf -X DELETE "$SERVER_URL/api/peers/$peer3_id" \
        -H "Authorization: Bearer $ADMIN_TOKEN" > /dev/null

    # Nodes should see peer-removed and reconcile quickly (not wait for next poll)
    wait_for "node1 has 1 peer" 15 \
        '[ "$(peer_count node1)" -eq 1 ]'

    [[ "$(peer_count node1)" -eq 1 ]]
}

# ── Relay toggle ──

@test "3node: relay disabled blocks force-mode negotiate" {
    wait_for "all direct" 25 \
        '[ "$(observer_status node1 | jq "[.peers[].mode] | all(. == \"direct\")" )" = "true" ]'

    # Disable relay for the network
    curl -sf -X PATCH "$SERVER_URL/api/networks/$NETWORK_ID" \
        -H "Authorization: Bearer $ADMIN_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{"relayEnabled": false}' > /dev/null

    # Block UDP
    block_udp node1 "$NODE2_IP"
    block_udp node2 "$NODE1_IP"

    # Wait for grace period + enough dead streaks to accumulate
    sleep 35

    # Should still be direct because relay is disabled
    [[ "$(peer_field node1 mode)" == "direct" ]]

    # Server logs should show "relay disabled"
    run $COMPOSE logs server
    [[ "$output" == *"relay disabled"* ]]
}

# ── Server restart resilience ──

@test "3node: agents reconnect after server restart" {
    wait_for "all direct" 25 \
        '[ "$(observer_status node1 | jq "[.peers[].mode] | all(. == \"direct\")" )" = "true" ]'

    # Restart server
    $COMPOSE restart server > /dev/null 2>&1

    # Re-discover port (restart may remap)
    local new_port=""
    for _ in $(seq 1 10); do
        new_port=$($COMPOSE port server 3000 2>/dev/null | grep -oE '[0-9]+$')
        [[ -n "$new_port" ]] && break
        sleep 1
    done
    [[ -n "$new_port" ]]
    SERVER_URL="http://localhost:${new_port}"

    # Wait for server to be back (may take time under parallel load)
    wait_for "server up" 60 \
        "curl -sf \"$SERVER_URL/api/networks\" -H \"Authorization: Bearer $ADMIN_TOKEN\" > /dev/null"

    # Agents should reconnect WS and resume health reports
    sleep 10

    # Verify links are populated again (server lost in-memory state but DB persists)
    run get_links
    local count
    count=$(echo "$output" | jq 'length')
    [[ "$count" -ge 2 ]]

    # All nodes should still function
    [[ "$(peer_count node1)" -eq 2 ]]
}
