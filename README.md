# Meshezia

Full-mesh VPN coordinator built on [AmneziaWG](https://github.com/amnezia-vpn/amneziawg-linux-kernel-module) — a WireGuard fork with DPI-resistant obfuscation.

## What it does

Meshezia creates **point-to-point kernel AmneziaWG tunnels** between every node in a network. Each node gets a dedicated interface (`mza0`, `mza1`, ...) per peer, with `AllowedIPs = 0.0.0.0/0` — so any node can act as a full gateway.

A central control plane (server) manages the mesh topology, allocates IPs, distributes AWG obfuscation parameters, and orchestrates automatic failover between direct UDP and WebSocket relay paths. An agent on each node polls the server, reconciles local interfaces, monitors tunnel health, and participates in dual-path negotiation.

### Why not Tailscale / Netmaker / etc.?

|                  | Tailscale           | Netmaker                                         | Meshezia                                  |
| ---------------- | ------------------- | ------------------------------------------------ | ----------------------------------------- |
| WireGuard mode   | Userspace (TUN)     | Kernel, shared interface                         | Kernel, **one interface per peer**        |
| Throughput       | ~850 Mbps           | Good, but AllowedIPs conflict with multi-gateway | **8-13 Gbps** (kernel AWG)                |
| DPI resistance   | None                | None                                             | **AmneziaWG obfuscation**                 |
| Gateway per node | Requires exit nodes | One gateway per network                          | **Every node is a gateway**               |
| DPI fallback     | DERP relay (TCP)    | None                                             | **WebSocket relay through control plane** |

Tailscale uses a userspace TUN device — the daemon only sees raw IP packets and loses next-hop info, capping throughput at ~850 Mbps. IPIP tunnels over it are even worse (~216 Mbps). Netmaker creates one WireGuard interface per network with multiple peers, making it impossible to have multiple peers with `AllowedIPs = 0.0.0.0/0`.

Meshezia creates a separate kernel AWG interface for each peer. Each tunnel is independent, gets its own obfuscation parameters, and can serve as a full default route.

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  Control Plane                   │
│  ┌────────────┐  ┌───────────┐  ┌─────────────┐  │
│  │  REST API  │  │  SQLite   │  │  WS Relay   │  │
│  │  (Hono)    │  │  (WAL)    │  │ (zero-copy) │  │
│  └────────────┘  └───────────┘  └─────────────┘  │
│  ┌──────────────┐  ┌────────────────────────┐    │
│  │  Negotiator  │  │  Web Dashboard (Vue 3) │    │
│  │ (dual-path)  │  │  + Tailwind CSS        │    │
│  └──────────────┘  └────────────────────────┘    │
└──────────────────────────────────────────────────┘
        ▲ poll config          ▲ binary relay
        │                      │
┌───────┴──────────────────────┴───────────────────┐
│                      Agent                       │
│  ┌──────────────┐ ┌─────────┐ ┌───────────────┐  │
│  │ Reconciler   │ │ Monitor │ │  Relay Proxy  │  │
│  │ (AWG ifaces) │ │ (dual)  │ │  (UDP↔WS)     │  │
│  └──────────────┘ └─────────┘ └───────────────┘  │
│  ┌──────────────┐ ┌───────────────────────────┐  │
│  │  Negotiator  │ │ Observer API (:9100)      │  │
│  │ (probe exec) │ │ /health /api/status /memo │  │
│  └──────────────┘ └───────────────────────────┘  │
│   mza0 ←→ peer-A    mza1 ←→ peer-B    ...        │
└──────────────────────────────────────────────────┘
```

**Control plane** (server):

- REST API for network/peer management, auth via bearer token
- SQLite with WAL for persistence
- Web dashboard with auto-refresh, expandable peer rows, per-link connection details
- WebSocket relay for DPI fallback — reads only the 36-byte peer UUID header, swaps dest with src in-place (zero payload copy)
- **Negotiation orchestrator** — server-coordinated dual-path probing (relay probe via TCP, direct probe via UDP) with exponential backoff
- Auto-generation of AWG obfuscation parameters per network
- TTL-based peer auto-deletion with background reaper
- Per-network relay toggle
- Agent version tracking and remote push-update
- Security: rate limiting (120 req/60s), security headers, input validation, path traversal protection, 1 MB body limit

**Agent** (runs on each node):

- Polls server for mesh config, creates/removes AWG interfaces with persistent mapping
- Dual-path monitoring: tracks RX bytes for direct health, WebSocket ping for relay health
- **Negotiated failover**: participates in server-orchestrated probes — relay probe (TCP handshake via mesh IPs) and direct probe (UDP nonce exchange via public IPs)
- Automatic endpoint switching between direct IP and `127.0.0.1:<relay_port>`
- Local UDP↔WebSocket bridge for relay traffic
- Observer HTTP API for monitoring and external integration
- Self-update: download binary from URL, atomic replace, exit for systemd restart

## Install

### Control Plane (Docker)

```bash
docker run -d \
  --name meshezia \
  -e MESHEZIA_TOKEN=your-secret-admin-token \
  -v meshezia-data:/data \
  -p 3000:3000 \
  --restart unless-stopped \
  ghcr.io/herenickname/meshezia:latest
```

The dashboard is at `http://<server>:3000`. Log in with your admin token.

Create a network (AWG obfuscation params are auto-generated):

```bash
curl -X POST http://localhost:3000/api/networks \
  -H "Authorization: Bearer your-secret-admin-token" \
  -H "Content-Type: application/json" \
  -d '{"name": "production", "subnet": "10.100.0.0/23"}'
# → { "id": "...", "token": "a1b2c3...", "jc": 5, "jmin": 120, ... }
```

Save the `id` and `token` from the response — agents will need them.

### Agent (binary)

Download the latest release for your platform and install:

```bash
# Linux x86_64
curl -Lo /usr/local/bin/meshezia-agent \
  https://github.com/herenickname/meshezia/releases/latest/download/meshezia-agent-linux-x86_64
chmod +x /usr/local/bin/meshezia-agent

# Linux arm64
curl -Lo /usr/local/bin/meshezia-agent \
  https://github.com/herenickname/meshezia/releases/latest/download/meshezia-agent-linux-arm64
chmod +x /usr/local/bin/meshezia-agent

# macOS Apple Silicon
curl -Lo /usr/local/bin/meshezia-agent \
  https://github.com/herenickname/meshezia/releases/latest/download/meshezia-agent-darwin-arm64
chmod +x /usr/local/bin/meshezia-agent

# macOS Intel
curl -Lo /usr/local/bin/meshezia-agent \
  https://github.com/herenickname/meshezia/releases/latest/download/meshezia-agent-darwin-x86_64
chmod +x /usr/local/bin/meshezia-agent
```

Run the agent:

```bash
meshezia-agent \
  --server=http://<control-plane>:3000 \
  --token=<network-token> \
  --network=<network-uuid> \
  --name=node-1
```

The agent auto-detects public IP, generates an AWG keypair (stored in `/var/lib/meshezia/`), registers with the control plane, creates tunnel interfaces, and begins health monitoring with automatic failover.

### Agent as systemd service

```bash
cat > /etc/systemd/system/meshezia-agent.service << 'EOF'
[Unit]
Description=Meshezia Agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/meshezia-agent \
  --server=http://<control-plane>:3000 \
  --token=<network-token> \
  --network=<network-uuid> \
  --name=%H
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now meshezia-agent
```

`%H` uses the hostname as the node name.

### Prerequisites

Agents require:

- Linux with [AmneziaWG kernel module](https://github.com/amnezia-vpn/amneziawg-linux-kernel-module) and [amneziawg-tools](https://github.com/amnezia-vpn/amneziawg-tools) (`awg` CLI)
- Or `--userspace` flag with [amneziawg-go](https://github.com/amnezia-vpn/amneziawg-go) in `$PATH`

## Failover & negotiation

Meshezia uses a **server-coordinated dual-path failover** protocol. The server tracks health reports from both sides of every peer pair and orchestrates path switches.

### Direct → Relay (relay probe)

When both peers report 3+ consecutive RX misses on the direct path, the server triggers a **relay probe**:

1. Server picks one side as TCP server (the side with higher miss streak)
2. TCP server binds on its mesh IP and reports port + nonce
3. Server tells the other side to connect as TCP client
4. Client POSTs `/probe` with nonces and pubkeys for mutual authentication
5. Both sides report success/failure → server issues `switch-relay` or `stay` verdict

### Relay → Direct (direct probe)

Once on relay, agents periodically attempt to restore the direct path via a **direct probe**:

1. Both peers bind ephemeral UDP sockets on `0.0.0.0`
2. Each sends the other's nonce 3x with 100ms spacing
3. If both receive the expected nonce within 3s → `switch-direct`
4. On failure, backoff doubles: 30s → 60s → 120s → 240s (max)

### Force mode

Admins can override negotiation for any peer pair:

```bash
curl -X POST http://server:3000/api/links/force-mode \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"peerA": "<uuid>", "peerB": "<uuid>", "mode": "force-relay"}'
# Modes: force-direct, force-relay, auto
```

Force mode persists across server restarts and blocks negotiation until cleared with `auto`.

### Grace period

The server skips streak accumulation for 15s after a peer joins, preventing false failovers during startup.

## Routing model

Each AWG interface has `AllowedIPs = 0.0.0.0/0`. The agent sets up **fwmark-based policy routing**: each interface gets a routing table and a matching fwmark rule (default base: 4200).

```
mza0 → fwmark 4200, table 4200 (default dev mza0)
mza1 → fwmark 4201, table 4201 (default dev mza1)
mza2 → fwmark 4202, table 4202 (default dev mza2)
```

### Direct interface binding

Applications that support `SO_BINDTODEVICE` (like [Xray-core](https://github.com/XTLS/Xray-core)) can bind directly to a specific interface, bypassing the routing table entirely:

```json
{
  "outbounds": [
    {
      "tag": "exit-eu",
      "protocol": "freedom",
      "streamSettings": {
        "sockopt": { "interface": "mza0" }
      }
    }
  ]
}
```

Other options: `curl --interface mza0`, `ip netns exec <ns> <command>`, `LD_PRELOAD` wrappers.

### Load balancing via nftables

Use a dummy interface + nftables `type route` chain to distribute traffic across tunnels by fwmark:

```nft
table ip meshezia_balance {
    chain output {
        type route hook output priority mangle; policy accept;
        meta oifname "xray-dummy" meta mark set jhash ip daddr . tcp dport mod 3 seed 0xdead offset 4200
    }
}
```

This sets fwmark 4200/4201/4202 based on a hash of destination, and the kernel re-routes through the corresponding table. `SO_BINDTODEVICE` and fwmark routing do not conflict — they are independent paths.

All nodes share a single mesh IP from a small subnet (e.g., /23 for 500 nodes).

## Authentication

Two-level auth:

- **Admin token** (`MESHEZIA_TOKEN` env) — full access: create/delete networks, list all peers, force-mode, push updates
- **Network token** — auto-generated per network, returned in `POST /api/networks` response. Grants access only to peers and config within that network. Retrievable later via `GET /api/networks/:id/token` (admin only).

Agents use the network token. Admin token is accepted everywhere.

## Server options

| Flag / Env                   | Default       | Description               |
| ---------------------------- | ------------- | ------------------------- |
| `--port` / `PORT`            | `3000`        | Listen port               |
| `--token` / `MESHEZIA_TOKEN` | required      | Admin token               |
| `--db` / `DB_PATH`           | `meshezia.db` | SQLite database file      |
| `--static` / `STATIC_DIR`    | —             | Frontend static files dir |

## Agent options

| Flag             | Default       | Description                                         |
| ---------------- | ------------- | --------------------------------------------------- |
| `--server`       | required      | Control plane URL                                   |
| `--token`        | required      | Network token                                       |
| `--network`      | required      | Network UUID                                        |
| `--name`         | required      | Node name (unique per network)                      |
| `--ipv4`         | auto-detect   | Public IPv4 address                                 |
| `--poll`         | `10`          | Poll interval in seconds                            |
| `--observe-port` | `9100`        | Observer API port                                   |
| `--rt-table`     | `4200`        | Base routing table number                           |
| `--port-range`   | `51820-52819` | Listen port range for AWG interfaces                |
| `--ttl`          | `0`           | Peer TTL in seconds (0 = permanent)                 |
| `--memo`         | `""`          | Free-form metadata for external identification      |
| `--userspace`    | off           | Use amneziawg-go userspace instead of kernel module |

## Observer API

Each agent exposes an HTTP API on `127.0.0.1` (default port 9100):

```bash
# Health check (includes version, uptime, peerId)
curl http://localhost:9100/health

# Full mesh status
curl http://localhost:9100/api/status
# → { "self": { peerId, name, meshIpv4, networkId, memo, uptime },
#     "peers": [{ peerId, interface, publicIpv4, meshIpv4, routingTable,
#                 mode, rxAlive, lastHandshake, lastHandshakeAge }] }

# Get/set memo (syncs to control plane)
curl http://localhost:9100/api/memo
curl -X POST http://localhost:9100/api/memo -d '{"memo":"gateway-eu-1"}'
```

The `memo` field is free-form metadata that external scripts can use for identification and binding. It can also be set directly via the server API:

```bash
curl -X PATCH http://server:3000/api/peers/<peer-id> \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"memo": "gateway-eu-1"}'
```

## Web dashboard

The Vue 3 + Tailwind CSS dashboard provides:

- **Networks overview** — total networks, peers, online/offline counts; create/delete networks
- **Per-network detail** — sortable peer list with status badges (Online/Stale/Offline), TTL countdown, agent version
- **Expandable peer rows** — per-link connection details: mode (direct/relay), alive flags, RX/TX bytes, last handshake age, interface name, routing table
- **Force mode controls** — buttons to force direct, force relay, or auto for each peer pair
- **Relay toggle** — enable/disable relay fallback per network
- **Agent update** — trigger remote binary update on online peers (admin only)
- **Auto-refresh** every 10s

## Agent self-update

Admins can push binary updates to running agents:

```bash
curl -X POST http://server:3000/api/peers/<peer-id>/update \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://github.com/herenickname/meshezia/releases/latest/download/meshezia-agent-linux-x86_64"}'
```

The agent downloads the binary, atomically replaces `process.execPath`, and exits. Systemd restarts it with the new version.

## API reference

### Networks (admin only)

| Method   | Endpoint                  | Description                                           |
| -------- | ------------------------- | ----------------------------------------------------- |
| `POST`   | `/api/networks`           | Create network (AWG params auto-generated if omitted) |
| `GET`    | `/api/networks`           | List all networks                                     |
| `GET`    | `/api/networks/:id`       | Get network details (token excluded)                  |
| `GET`    | `/api/networks/:id/token` | Get network token                                     |
| `PATCH`  | `/api/networks/:id`       | Update network (e.g. `{ relayEnabled }`)              |
| `DELETE` | `/api/networks/:id`       | Delete network (cascades to peers and links)          |

### Peers (admin or network token)

| Method   | Endpoint                 | Description                                                      |
| -------- | ------------------------ | ---------------------------------------------------------------- |
| `POST`   | `/api/peers`             | Register peer                                                    |
| `GET`    | `/api/peers?network_id=` | List peers                                                       |
| `PATCH`  | `/api/peers/:id`         | Update peer (pubkey, publicIpv4, ttlSeconds, memo, agentVersion) |
| `DELETE` | `/api/peers/:id`         | Remove peer                                                      |
| `GET`    | `/api/peers/:id/config`  | Get mesh config (agent poll endpoint, updates lastSeen)          |
| `PUT`    | `/api/peers/:id/ports`   | Report listen ports                                              |
| `POST`   | `/api/peers/:id/update`  | Push agent update (admin only, sends WS message)                 |

### Links (connection status)

| Method | Endpoint                 | Description                           |
| ------ | ------------------------ | ------------------------------------- |
| `GET`  | `/api/links?network_id=` | Get per-pair connection states        |
| `POST` | `/api/links/force-mode`  | Force mode for peer pair (admin only) |

### Peer fields

| Field             | Type    | Description                                    |
| ----------------- | ------- | ---------------------------------------------- |
| `id`              | string  | UUID                                           |
| `networkId`       | string  | Network UUID                                   |
| `name`            | string  | Unique per network                             |
| `publicIpv4`      | string  | Agent's public IP                              |
| `pubkey`          | string  | AWG public key                                 |
| `meshIpv4`        | string  | Auto-allocated mesh IP                         |
| `lastSeen`        | number  | Milliseconds since epoch                       |
| `isRelayEligible` | boolean | Can relay for others                           |
| `ttlSeconds`      | number  | Auto-delete after inactivity (0 = permanent)   |
| `memo`            | string  | Free-form metadata for external identification |
| `agentVersion`    | string  | Agent binary version                           |

### Link fields

| Field           | Type    | Description                                              |
| --------------- | ------- | -------------------------------------------------------- |
| `fromPeerId`    | string  | Source peer UUID                                         |
| `toPeerId`      | string  | Destination peer UUID                                    |
| `mode`          | string  | `direct`, `relay`, or `unknown`                          |
| `directAlive`   | boolean | Direct path receiving data                               |
| `relayAlive`    | boolean | Relay WS connection alive                                |
| `probingDirect` | boolean | Currently probing direct path                            |
| `rxBytes`       | number  | Received bytes on AWG interface                          |
| `txBytes`       | number  | Transmitted bytes on AWG interface                       |
| `lastHandshake` | number  | Last handshake timestamp                                 |
| `endpoint`      | string  | Current AWG endpoint                                     |
| `ifName`        | string  | AWG interface name (e.g. `mza0`)                         |
| `routingTable`  | number  | Policy routing table number                              |
| `forcedMode`    | string  | Admin override: `force-direct`, `force-relay`, or `null` |

## Development

### Building from source

```bash
# Requires Bun (https://bun.sh)
bun install

# Run server locally
MESHEZIA_TOKEN=dev-token bun run dev:server

# Run frontend dev server (proxies API to :3000)
bun run dev:frontend

# Compile agent binary
bun run build:agent

# Compile server binary
bun run build:server

# Build frontend static files
bun run build:frontend
```

### Docker test environment

A 3-node Docker test environment with BATS integration tests:

```bash
# Run all test suites (negotiate, force-mode, health-report, three-node)
bun test

# Run with image rebuild
bun run test:build

# Run a specific suite
bun run test:negotiate
bun run test:force-mode
bun run test:health
bun run test:3node

# Manual setup (interactive)
cd tests && bash setup.sh
# → server + node-1 + node-2 with userspace AWG
# Dashboard at http://localhost:3000, admin token: test-admin-token

# View logs
docker compose logs -f

# Check mesh status from inside a node
docker compose exec node1 curl -s localhost:9100/api/status | jq

# Tear down
bun run test:docker:down
```

Tests use BATS with parallel execution (6 jobs), random project names and subnets for isolation.

### Project structure

```
packages/
├── server/     Control plane (Hono + SQLite + WS relay + negotiator)
├── agent/      Node agent (AWG management, monitor, relay-proxy, negotiator, observer)
├── shared/     Shared types and relay frame protocol
└── frontend/   Web dashboard (Vue 3 + Tailwind CSS + Vite)
tests/          Docker integration tests (BATS, 4 suites)
```

## Limitations

- **No default route injection.** Meshezia creates per-interface routing tables with fwmark rules but never touches the main routing table. Applications must select the tunnel via `SO_BINDTODEVICE`, fwmark (nftables), or network namespaces.
- **No per-node auth.** Auth is per-network (shared token for all agents in a network), not per-node. A compromised agent token exposes the entire network.
- **No NAT traversal.** Nodes must have public IPs or pre-configured port forwarding. There is no STUN/TURN/hole-punching.
- **Full mesh only.** Every node connects to every other node. For N nodes, each node creates N-1 AWG interfaces. This scales to hundreds of nodes but not thousands.
- **Linux only.** Requires the AmneziaWG kernel module and `ip`/`awg` CLI tools.
- **No encryption at rest.** Private keys are stored as plaintext files in `/var/lib/meshezia/`. Protect this directory.
- **Relay is not a VPN tunnel.** The WebSocket relay is a fallback for DPI-blocked paths. It forwards encrypted AWG packets through the control plane — performance depends on server bandwidth and latency.
- **AWG parameters are per-network.** All nodes in a network share the same obfuscation parameters (S1/S2, H1-H4). Per-peer tuning is not supported.

## License

MIT
