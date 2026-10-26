CREATE TABLE oauth_states (
    state_hash TEXT PRIMARY KEY,
    redirect_uri TEXT NOT NULL,
    expires_at INTEGER NOT NULL
) STRICT;

CREATE TABLE auth_claims (
    claim_hash TEXT PRIMARY KEY,
    github_id INTEGER NOT NULL,
    github_login TEXT NOT NULL,
    expires_at INTEGER NOT NULL
) STRICT;

CREATE TABLE refresh_tokens (
    token_hash TEXT PRIMARY KEY,
    github_id INTEGER NOT NULL,
    github_login TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE library_keys (
    version INTEGER PRIMARY KEY AUTOINCREMENT,
    ciphertext TEXT NOT NULL,
    nonce TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    retired INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE peer_leases (
    swarm_hash TEXT NOT NULL,
    github_id INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    public_key TEXT,
    capabilities TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (swarm_hash, github_id, device_id)
) STRICT;

CREATE INDEX refresh_tokens_expiry ON refresh_tokens(expires_at);
CREATE INDEX oauth_states_expiry ON oauth_states(expires_at);
CREATE INDEX auth_claims_expiry ON auth_claims(expires_at);
CREATE INDEX peer_leases_expiry ON peer_leases(expires_at);
CREATE INDEX peer_leases_swarm ON peer_leases(swarm_hash, expires_at);
