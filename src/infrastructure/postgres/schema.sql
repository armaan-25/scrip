-- Schema for the durable, concurrency-safe task/lease/action store.
-- Mirrors the in-memory shapes in src/lease.ts (TaskAuthorization,
-- InferenceLease, ActionReservation) closely enough to stay easy to
-- reason about side by side, not because the two are meant to be kept
-- byte-identical forever.

CREATE TABLE IF NOT EXISTS task_authorizations (
  authorization_id   uuid PRIMARY KEY,
  budget_name         text NOT NULL,
  ramp_budget_id      text NOT NULL,
  task_id             text NOT NULL,
  task                text NOT NULL,
  allowance           numeric(14, 6) NOT NULL,
  spent               numeric(14, 6) NOT NULL DEFAULT 0,
  pending             numeric(14, 6) NOT NULL DEFAULT 0,
  status              text NOT NULL DEFAULT 'active',
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS leases (
  lease_id            uuid PRIMARY KEY,
  authorization_id    uuid NOT NULL REFERENCES task_authorizations(authorization_id),
  parent_lease_id      uuid REFERENCES leases(lease_id),
  agent_id            text NOT NULL,
  allowance           numeric(14, 6) NOT NULL,
  spent               numeric(14, 6) NOT NULL DEFAULT 0,
  pending             numeric(14, 6) NOT NULL DEFAULT 0,
  status              text NOT NULL DEFAULT 'active',
  expires_at          timestamptz NOT NULL,
  depth               integer NOT NULL,
  credential_hash     bytea NOT NULL
);

CREATE INDEX IF NOT EXISTS leases_authorization_id_idx ON leases(authorization_id);
CREATE INDEX IF NOT EXISTS leases_credential_hash_idx ON leases(credential_hash);

CREATE TABLE IF NOT EXISTS action_reservations (
  reservation_id      uuid PRIMARY KEY,
  authorization_id    uuid NOT NULL REFERENCES task_authorizations(authorization_id),
  lease_id            uuid NOT NULL REFERENCES leases(lease_id),
  action_type         text NOT NULL,
  label               text NOT NULL,
  maximum_cost        numeric(14, 6) NOT NULL,
  status              text NOT NULL DEFAULT 'reserved',
  metadata            jsonb NOT NULL DEFAULT '{}',
  -- Set only on commit/cancel - null while status = 'reserved'.
  actual_cost         numeric(14, 6),
  input_tokens        integer,
  output_tokens       integer,
  created_at          timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz
);

CREATE INDEX IF NOT EXISTS action_reservations_authorization_id_idx ON action_reservations(authorization_id);

-- Idempotency: a caller-supplied key that, if reused, returns the original
-- reservation instead of creating a duplicate one. Required for the "retry
-- a network call safely" property a real durable store needs and an
-- in-memory Map never had to worry about.
CREATE UNIQUE INDEX IF NOT EXISTS action_reservations_idempotency_key_idx
  ON action_reservations((metadata->>'idempotencyKey'))
  WHERE metadata->>'idempotencyKey' IS NOT NULL;
