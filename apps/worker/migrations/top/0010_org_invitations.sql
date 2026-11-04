-- Organization invitations: owner invites a user by username to join an org with a role.
PRAGMA foreign_keys = ON;

-- Ensure orgs and memberships exist (migrations 0002 created them)
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  can_write INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(org_id, user_id)
);

-- Invitations table
CREATE TABLE IF NOT EXISTS org_invitations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  invitee_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member', -- owner|member
  state TEXT NOT NULL DEFAULT 'pending', -- pending|accepted|declined|cancelled
  created_at INTEGER NOT NULL,
  responded_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_org_invites_org ON org_invitations(org_id);
CREATE INDEX IF NOT EXISTS idx_org_invites_state ON org_invitations(state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_invites_unique_pending ON org_invitations(org_id, invitee_user_id) WHERE state = 'pending';

