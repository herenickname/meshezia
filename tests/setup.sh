#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

SERVER="http://localhost:3000"
ADMIN_TOKEN="test-admin-token"

echo "=== Building images ==="
docker compose build

echo "=== Starting server ==="
docker compose up -d server
sleep 2

echo "=== Creating network ==="
RESPONSE=$(curl -sf -X POST "$SERVER/api/networks" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
        "name": "test-mesh",
        "subnet": "10.100.0.0/24",
        "listenPort": 51820,
        "jc": 4, "jmin": 40, "jmax": 70,
        "s1": 71, "s2": 92,
        "h1": 123456, "h2": 654321, "h3": 111111, "h4": 222222
    }')

NETWORK_ID=$(echo "$RESPONSE" | jq -r '.id')
NETWORK_TOKEN=$(echo "$RESPONSE" | jq -r '.token')

echo "NETWORK_ID=$NETWORK_ID" > .env
echo "NETWORK_TOKEN=$NETWORK_TOKEN" >> .env

echo "Network ID:    $NETWORK_ID"
echo "Network Token: $NETWORK_TOKEN"

echo "=== Starting agent nodes ==="
NETWORK_ID="$NETWORK_ID" NETWORK_TOKEN="$NETWORK_TOKEN" docker compose up -d node1 node2

echo ""
echo "=== Done ==="
echo "Dashboard:    $SERVER"
echo "Node 1 observer: http://localhost:9101/health  (if port-mapped)"
echo ""
echo "Useful commands:"
echo "  docker compose -f tests/docker-compose.yml logs -f"
echo "  docker compose -f tests/docker-compose.yml logs -f node1"
echo "  docker compose -f tests/docker-compose.yml down -v"
echo ""
echo "To check mesh status from inside node1:"
echo "  docker compose -f tests/docker-compose.yml exec node1 curl -s localhost:9100/api/status | jq"
