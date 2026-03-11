import { Database } from 'bun:sqlite'

let db: Database

export function getDb(): Database {
    if (!db) throw new Error('DB not initialized')
    return db
}

/** Check if a column exists in a table (for safe migrations) */
function hasColumn(db: Database, table: string, column: string): boolean {
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as any[]
    return info.some((col: any) => col.name === column)
}

export function initDb(path: string): Database {
    db = new Database(path)
    db.run('PRAGMA journal_mode=WAL')
    db.run('PRAGMA foreign_keys=ON')

    db.run(`CREATE TABLE IF NOT EXISTS networks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        token TEXT NOT NULL UNIQUE,
        subnet TEXT NOT NULL,
        listen_port INTEGER NOT NULL DEFAULT 51820,
        jc INTEGER NOT NULL DEFAULT 4,
        jmin INTEGER NOT NULL DEFAULT 40,
        jmax INTEGER NOT NULL DEFAULT 70,
        s1 INTEGER NOT NULL DEFAULT 0,
        s2 INTEGER NOT NULL DEFAULT 0,
        h1 INTEGER NOT NULL DEFAULT 1,
        h2 INTEGER NOT NULL DEFAULT 2,
        h3 INTEGER NOT NULL DEFAULT 3,
        h4 INTEGER NOT NULL DEFAULT 4
    )`)

    db.run(`CREATE TABLE IF NOT EXISTS peers (
        id TEXT PRIMARY KEY,
        network_id TEXT NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        public_ip TEXT NOT NULL,
        pubkey TEXT NOT NULL DEFAULT '',
        ipv4 TEXT NOT NULL,
        last_seen INTEGER NOT NULL DEFAULT 0,
        is_relay_eligible INTEGER NOT NULL DEFAULT 0,
        ttl_seconds INTEGER NOT NULL DEFAULT 0,
        UNIQUE(network_id, name)
    )`)

    // Additive migrations — check before ALTER to avoid swallowing real errors
    if (!hasColumn(db, 'peers', 'ttl_seconds')) {
        db.run('ALTER TABLE peers ADD COLUMN ttl_seconds INTEGER NOT NULL DEFAULT 0')
    }
    if (!hasColumn(db, 'peers', 'memo')) {
        db.run("ALTER TABLE peers ADD COLUMN memo TEXT NOT NULL DEFAULT ''")
    }
    if (!hasColumn(db, 'peers', 'agent_version')) {
        db.run("ALTER TABLE peers ADD COLUMN agent_version TEXT NOT NULL DEFAULT ''")
    }
    if (!hasColumn(db, 'networks', 'relay_enabled')) {
        db.run('ALTER TABLE networks ADD COLUMN relay_enabled INTEGER NOT NULL DEFAULT 1')
    }

    db.run(`CREATE TABLE IF NOT EXISTS peer_ports (
        from_peer_id TEXT NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
        to_peer_id TEXT NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
        port INTEGER NOT NULL,
        PRIMARY KEY (from_peer_id, to_peer_id)
    )`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_peer_ports_to ON peer_ports(to_peer_id)`)

    db.run(`CREATE TABLE IF NOT EXISTS peer_links (
        from_peer_id TEXT NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
        to_peer_id TEXT NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
        mode TEXT NOT NULL DEFAULT 'unknown',
        direct_alive INTEGER NOT NULL DEFAULT 0,
        relay_alive INTEGER NOT NULL DEFAULT 0,
        probing_direct INTEGER NOT NULL DEFAULT 0,
        rx_bytes INTEGER NOT NULL DEFAULT 0,
        tx_bytes INTEGER NOT NULL DEFAULT 0,
        last_handshake INTEGER NOT NULL DEFAULT 0,
        endpoint TEXT NOT NULL DEFAULT '',
        if_name TEXT NOT NULL DEFAULT '',
        routing_table INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (from_peer_id, to_peer_id)
    )`)

    // Migrations for peer_links
    if (!hasColumn(db, 'peer_links', 'if_name')) {
        db.run("ALTER TABLE peer_links ADD COLUMN if_name TEXT NOT NULL DEFAULT ''")
    }
    if (!hasColumn(db, 'peer_links', 'routing_table')) {
        db.run('ALTER TABLE peer_links ADD COLUMN routing_table INTEGER NOT NULL DEFAULT 0')
    }
    if (!hasColumn(db, 'peer_links', 'forced_mode')) {
        db.run('ALTER TABLE peer_links ADD COLUMN forced_mode TEXT DEFAULT NULL')
    }

    return db
}
