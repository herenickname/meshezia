#!/usr/bin/env bash
# Shared test helpers for meshezia BATS test suites.
# Source this from any .bats file: load helpers
#
# Each test gets a unique COMPOSE_PROJECT_NAME + subnet + ports,
# derived from a random suffix — allowing full parallel execution.

COMPOSE="docker compose"
ADMIN_TOKEN="test-admin-token"

# ── Random isolation ──

# Generate short random hex suffix for project/volume/network isolation
_rand_suffix() {
    head -c 4 /dev/urandom | xxd -p
}

# Set up isolated docker compose environment with random names.
# Call this in setup() of each test.
# Usage: init_project [extra_env_key=value ...]
init_project() {
    local suffix
    suffix=$(_rand_suffix)

    # Unique project name prevents container/volume collisions
    export COMPOSE_PROJECT_NAME="mzt-${suffix}"

    # Use 10.{100-199}.{0-255}.0/24 — avoids Docker's default 172.x pool.
    # Use /dev/urandom for better entropy than RANDOM (15-bit) in parallel runs.
    local rand_bytes
    rand_bytes=$(od -An -N2 -tu2 /dev/urandom | tr -d ' ')
    local second_octet=$(( 100 + (rand_bytes % 100) ))
    rand_bytes=$(od -An -N2 -tu2 /dev/urandom | tr -d ' ')
    local third_octet=$(( rand_bytes % 256 ))
    export MESH_SUBNET="10.${second_octet}.${third_octet}.0/24"
    export SERVER_IP="10.${second_octet}.${third_octet}.10"
    export NODE1_IP="10.${second_octet}.${third_octet}.11"
    export NODE2_IP="10.${second_octet}.${third_octet}.12"
    export NODE3_IP="10.${second_octet}.${third_octet}.13"

    # Let Docker assign a random host port (eliminates TOCTOU race with --jobs)
    export SERVER_HOST_PORT=0

    # Apply any extra env vars passed as arguments
    for kv in "$@"; do
        export "$kv"
    done

    # SERVER_URL is set after server starts (compose_up_server discovers actual port)
    SERVER_URL=""
}

# ── Docker Compose wrappers ──

compose_up_server() {
    $COMPOSE up -d server > /dev/null 2>&1 || true

    # Discover actual mapped port (Docker assigned random host port)
    local actual_port=""
    for _ in $(seq 1 40); do
        actual_port=$($COMPOSE port server 3000 2>/dev/null | grep -oE '[0-9]+$')
        [[ -n "$actual_port" ]] && break
        sleep 0.5
    done

    if [[ -z "$actual_port" ]]; then
        echo "=== Failed to discover server port ===" >&2
        $COMPOSE ps >&2
        return 1
    fi

    SERVER_URL="http://localhost:${actual_port}"

    # Retry-friendly wait: server may take a few seconds to bind
    if ! wait_for "server up" 60 \
        "curl -sf \"$SERVER_URL/api/networks\" -H \"Authorization: Bearer $ADMIN_TOKEN\" > /dev/null"; then
        echo "=== Server failed to start. Logs: ===" >&2
        $COMPOSE logs --tail 40 server >&2
        echo "=== docker compose ps: ===" >&2
        $COMPOSE ps >&2
        return 1
    fi
}

create_network() {
    local response
    response=$(curl -sf --retry 3 --retry-all-errors --retry-delay 1 \
        -X POST "$SERVER_URL/api/networks" \
        -H "Authorization: Bearer $ADMIN_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{"name":"test","subnet":"10.100.0.0/24","listenPort":51820,"jc":4,"jmin":40,"jmax":70,"s1":71,"s2":92,"h1":123456,"h2":654321,"h3":111111,"h4":222222}')

    export NETWORK_ID=$(echo "$response" | jq -r '.id')
    export NETWORK_TOKEN=$(echo "$response" | jq -r '.token')

    if [[ -z "$NETWORK_ID" || "$NETWORK_ID" == "null" ]]; then
        echo "=== create_network failed: $response ===" >&2
        return 1
    fi
}

compose_up_nodes() {
    local nodes="${@:-node1 node2}"
    $COMPOSE up -d $nodes > /dev/null 2>&1
    for node in $nodes; do
        wait_ready "$node"
    done
}

compose_teardown() {
    $COMPOSE kill > /dev/null 2>&1 || true
    $COMPOSE down -v --remove-orphans > /dev/null 2>&1 || true
    # Clean up docker network (may linger on crash)
    docker network rm "${COMPOSE_PROJECT_NAME}_mesh" 2>/dev/null || true
}

# Full bootstrap: server + network + nodes
bootstrap() {
    local nodes="${@:-node1 node2}"
    compose_up_server
    create_network
    compose_up_nodes $nodes
}

# ── Wait helpers ──

wait_ready() {
    local node="$1" timeout="${2:-30}"
    for i in $(seq 1 "$timeout"); do
        if $COMPOSE exec -T "$node" curl -sf localhost:9100/api/status > /dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    echo "Timeout (${timeout}s) waiting for $node readiness" >&2
    $COMPOSE logs --tail 30 "$node" >&2
    return 1
}

# Poll until condition is true.
wait_for() {
    local desc="$1" timeout="$2"
    shift 2
    for i in $(seq 1 "$timeout"); do
        if eval "$@" 2>/dev/null; then
            return 0
        fi
        sleep 1
    done
    echo "Timeout (${timeout}s) waiting for: $desc" >&2
    return 1
}

# ── Observer API helpers ──

# Get full observer status JSON for a node
observer_status() {
    local node="$1"
    $COMPOSE exec -T "$node" curl -sf localhost:9100/api/status
}

# Get a field from the first peer in observer status
# Note: uses `tostring` to correctly handle boolean false (jq's // treats false as falsy)
peer_field() {
    local node="$1" field="$2"
    observer_status "$node" | jq -r ".peers[0].$field | tostring" 2>/dev/null
}

# Get a field from a specific peer (by peerId) in observer status
peer_field_by_id() {
    local node="$1" peer_id="$2" field="$3"
    observer_status "$node" | jq -r ".peers[] | select(.peerId == \"$peer_id\") | .$field | tostring" 2>/dev/null
}

# Get the number of peers reported by a node
peer_count() {
    local node="$1"
    observer_status "$node" | jq '.peers | length'
}

# Get self peerId from observer status
self_peer_id() {
    local node="$1"
    observer_status "$node" | jq -r '.self.peerId'
}

# ── Server API helpers ──

# Get links for the test network
get_links() {
    curl -sf "$SERVER_URL/api/links?network_id=$NETWORK_ID" \
        -H "Authorization: Bearer $ADMIN_TOKEN"
}

# Get link mode between two peers (from server perspective)
link_mode() {
    local from_id="$1" to_id="$2"
    get_links | jq -r ".[] | select(.fromPeerId == \"$from_id\" and .toPeerId == \"$to_id\") | .mode // empty"
}

# Send force-mode command
force_mode() {
    local peer_a="$1" peer_b="$2" mode="$3"
    curl -sf -X POST "$SERVER_URL/api/links/force-mode" \
        -H "Authorization: Bearer $ADMIN_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"peerA\":\"$peer_a\",\"peerB\":\"$peer_b\",\"mode\":\"$mode\"}" > /dev/null
}

# Get peers for the test network
get_peers() {
    curl -sf "$SERVER_URL/api/peers?network_id=$NETWORK_ID" \
        -H "Authorization: Bearer $ADMIN_TOKEN"
}

# ── iptables helpers ──

# Block UDP between two nodes (both directions on the blocking node)
block_udp() {
    local node="$1" target_ip="$2"
    $COMPOSE exec -T "$node" iptables -A OUTPUT -p udp -d "$target_ip" -j DROP
    $COMPOSE exec -T "$node" iptables -A INPUT  -p udp -s "$target_ip" -j DROP
}

# Unblock UDP between two nodes
unblock_udp() {
    local node="$1" target_ip="$2"
    $COMPOSE exec -T "$node" iptables -D OUTPUT -p udp -d "$target_ip" -j DROP 2>/dev/null || true
    $COMPOSE exec -T "$node" iptables -D INPUT  -p udp -s "$target_ip" -j DROP 2>/dev/null || true
}

# Block ALL traffic between two nodes (UDP + TCP)
block_all() {
    local node="$1" target_ip="$2"
    $COMPOSE exec -T "$node" iptables -A OUTPUT -d "$target_ip" -j DROP
    $COMPOSE exec -T "$node" iptables -A INPUT  -s "$target_ip" -j DROP
}

# Unblock ALL traffic between two nodes
unblock_all() {
    local node="$1" target_ip="$2"
    $COMPOSE exec -T "$node" iptables -D OUTPUT -d "$target_ip" -j DROP 2>/dev/null || true
    $COMPOSE exec -T "$node" iptables -D INPUT  -s "$target_ip" -j DROP 2>/dev/null || true
}

# ── Log helpers ──

# Count occurrences of a pattern in recent logs
log_count() {
    local node="$1" pattern="$2" since="${3:-30s}"
    $COMPOSE logs --since "$since" "$node" 2>&1 | grep -c "$pattern" || echo 0
}

# Check if a pattern appears in recent logs
log_contains() {
    local node="$1" pattern="$2" since="${3:-30s}"
    $COMPOSE logs --since "$since" "$node" 2>&1 | grep -q "$pattern"
}
