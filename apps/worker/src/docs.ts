/** Getting Started HTML served at GET /docs. Keep in sync with docs/getting-started.md. */

export function docsHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>ScionBase — Getting Started</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0f1115;
      --fg: #e8eaed;
      --muted: #9aa3b2;
      --card: #171a21;
      --border: #2a3140;
      --accent: #7aa2f7;
      --code: #1d2230;
    }
    html, body { background: var(--bg); color: var(--fg); }
    body {
      margin: 0 auto;
      max-width: 52rem;
      padding: 2.5rem 1.25rem 4rem;
      font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    h1 { font-size: 1.8rem; margin: 0 0 0.4rem; }
    h2 { font-size: 1.2rem; margin: 2rem 0 0.6rem; }
    p, li { color: var(--fg); }
    .muted { color: var(--muted); }
    a { color: var(--accent); }
    code, pre {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.88em;
    }
    code { background: var(--code); padding: 0.12em 0.35em; border-radius: 4px; }
    pre {
      background: var(--code);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0.9rem 1rem;
      overflow-x: auto;
    }
    pre code { background: none; padding: 0; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1rem 1.1rem;
      margin: 1rem 0;
    }
    ul.limits { padding-left: 1.2rem; }
  </style>
</head>
<body>
  <h1>Getting Started</h1>
  <p class="muted">Commands &amp; usage for the ScionBase proof of concept. The CLI binary is <code>scn</code>.</p>

  <h2>Install the CLI</h2>
  <p>Linux x86_64 binary from the <a href="https://github.com/scionhub/openscion/releases/tag/scn-v0.1.0"><code>scn-v0.1.0</code></a> GitHub release (asset <code>scn-x86_64-unknown-linux-gnu.tar.gz</code>):</p>
  <pre><code>curl -fsSL -o scn.tar.gz \\
  https://github.com/scionhub/openscion/releases/download/scn-v0.1.0/scn-x86_64-unknown-linux-gnu.tar.gz
tar -xzf scn.tar.gz
install -m 0755 scn ~/.local/bin/scn</code></pre>
  <p>Or build from source:</p>
  <pre><code>cargo install --git https://github.com/scionhub/openscion --branch cursor/storage-and-multirepo-e719 openscion</code></pre>
  <p>Point the client at this Worker (every command also accepts <code>--server &lt;URL&gt;</code>):</p>
  <pre><code>export SCN_SERVER=https://&lt;this-worker-host&gt;</code></pre>

  <h2>Clone</h2>
  <p>Public-repo reads need no token. <code>scn clone</code> works with no credentials file. <code>&lt;REPO&gt;</code> is <code>&lt;org&gt;/&lt;repo&gt;</code>; <code>[DIR]</code> defaults to the repository name.</p>
  <pre><code>scn clone filecoin-project/lotus
scn clone filecoin-project/lotus ./lotus --branch main
scn clone filecoin-project/lotus --path src</code></pre>

  <h2>Create an account and log in</h2>
  <p>Password is read from <code>SCN_PASSWORD</code> (or <code>OPNSCN_PASSWORD</code> / <code>OPENSCION_PASSWORD</code>) or prompted on stdin. Username must match <code>^[a-z0-9][a-z0-9-]{2,31}$</code>; password at least 10 characters.</p>
  <pre><code>scn signup --username alice
scn signup --username alice --email alice@example.com
scn login --user alice</code></pre>
  <p>Both commands store a bearer token for later writes. Signup is capped at 5 attempts per IP per hour and 200 users total. Public profile: <code>GET /v1/users/{name}</code> returns <code>{ name, tagline, admin }</code> (404 if unknown). Signed-in <code>GET /v1/me</code> includes <code>tagline</code> and <code>paid</code>. <code>PATCH /v1/me</code> with <code>{ "tagline": "..." }</code> (max 200 characters; empty string clears). Change password: <code>POST /v1/auth/change-password</code> with Bearer and <code>{ "current_password", "new_password" }</code> (new ≥ 10). A site admin sets paid with <code>PATCH /v1/users/{name}</code> <code>{ "paid": true }</code>.</p>

  <h2>Organizations</h2>
  <p>Logged-in users can create up to 3 organizations (admins unlimited). Names use the same rule as usernames (<code>^[a-z0-9][a-z0-9-]{2,31}$</code>); reserved names and existing users or orgs are rejected. The creator is inserted as org admin.</p>
  <pre><code>scn org create my-org
scn org list</code></pre>
  <p>The API is <code>POST /v1/orgs</code> with <code>{ "name": "my-org" }</code> (Bearer). Authenticated <code>GET /v1/orgs</code> lists the caller's memberships plus their username namespace (same ids as <code>/v1/me.orgs</code>). Anonymous <code>GET /v1/orgs</code> is the public directory of formal orgs (<code>filecoin-project</code> and other non-username orgs), not every row in the orgs table. <code>GET /v1/me</code> returns <code>{ user: { id, name, admin, tagline, paid }, orgs: [{ id, role }], ownedRepos: [{ org, name }] }</code>, including the caller's own username namespace.</p>

  <h2>Create a repository</h2>
  <p>Logged-in users can create a public repo under their username org (created on first use) or an org they belong to. <code>filecoin-project</code> stays admin-only. Unpaid users can create 3 repos; paid users 100; admins unlimited. The name must match <code>^[a-z0-9][a-z0-9._-]{0,63}$</code>.</p>
  <pre><code>scn repo create my-repo
scn repo create my-repo --org alice</code></pre>
  <p>The API is <code>POST /v1/repos</code> with <code>{ "name": "my-repo", "org": "alice" }</code> (<code>org</code> optional; defaults to your username), or <code>PUT /v1/repos/{org}/{repo}</code>. The creator is the first repo owner. Authenticated <code>GET</code> of a repo includes <code>viewer: { owner, canMerge }</code>. <code>GET /v1/me</code> lists <code>ownedRepos</code>. Owners: <code>GET/POST /v1/repos/{org}/{repo}/owners</code> (<code>{ "username" }</code>; owners or site admin) and <code>DELETE .../owners/{username}</code> (cannot remove the last owner). Delete a repo with <code>DELETE /v1/repos/{org}/{repo}</code> and <code>{ "confirm": "org/repo" }</code> (exact match; owners or admin). Deletion removes the repo and its stored Filecoin data permanently (unique dataset pieces are scheduled for removal; shared bundles are skipped). <code>filecoin-project/curio</code> and <code>filecoin-project/lotus</code> cannot be deleted, even by a site admin.</p>
  <pre><code>scn import ./src --repo alice/my-repo
scn commit -m "first"</code></pre>

  <h2>Branch</h2>
  <p>A working copy in <code>.scn/state.json</code> tracks the current branch and the remote ref it pushes to. Short names map to <code>refs/heads/...</code>. Org members and admins get <code>refs/heads/&lt;name&gt;</code> for new branches; everyone else gets <code>refs/heads/users/&lt;you&gt;/&lt;name&gt;</code>.</p>
  <pre><code>scn branch
scn branch new feature
scn branch new feature --from main
scn branch switch main
scn branch delete feature</code></pre>
  <p><code>scn branch</code> lists remote branches and marks the current one with <code>*</code>. <code>branch new</code> creates a local branch and switches to it (the remote ref is created on first <code>push</code>). <code>branch switch</code> re-fetches that ref when the working copy is clean. <code>branch delete</code> removes the remote ref.</p>

  <h2>Pull</h2>
  <p>Fetch the tracked upstream and three-way-merge it into the working copy.</p>
  <pre><code>scn pull</code></pre>

  <h2>Merge</h2>
  <p>Three-way merge another ref into the working copy. The next <code>scn push</code> records a changeset whose first parent is that ref so <code>scn pr merge</code> can fast-forward. Push refuses while <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt; local</code> markers remain.</p>
  <pre><code>scn merge main
scn merge users/alice/feat</code></pre>
  <p>A conflicted file looks like:</p>
  <pre><code>&lt;&lt;&lt;&lt;&lt;&lt;&lt; local
the line as it is on your branch
=======
the line as it is on main
&gt;&gt;&gt;&gt;&gt;&gt;&gt; main</code></pre>
  <p>Edit the file to the resolved contents (remove the markers), then push.</p>

  <h2>Push</h2>
  <p>Commit local changes if needed and publish the current branch to its upstream ref. A missing remote ref is created. <code>-m</code> is required when there are local changes.</p>
  <pre><code>scn push
scn push -m "fix the parser"</code></pre>

  <h2>Open, list, and merge a pull request</h2>
  <p><code>--head</code> defaults to the current branch's upstream; <code>--base</code> defaults to <code>main</code>. Repo is inferred from the working copy, or pass <code>--repo org/repo</code>.</p>
  <pre><code>scn pr create --title "Fix the thing"
scn pr create --title "Fix the thing" --body "details" --head refs/heads/users/alice/my-branch --base main
scn pr list
scn pr show 1
scn pr create --title "WIP" --draft
scn pr merge 1
scn pr merge 2 --squash
scn pr close 1</code></pre>
  <p>Merge is org admin/member or a repo owner and fast-forwards the base ref to the head target when the head changeset’s first parent is still the current base. Alternatively pass <code>--squash</code> to create a single commit on the base with the PR title/body and the head’s snapshot. Draft PRs cannot merge; toggle with <code>PATCH .../pulls/{n}</code> and <code>{ "draft": true|false }</code> or <code>scn pr create --draft</code>. Merge also requires at least one <strong>owner</strong> approval and zero unresolved comments; owner “changes requested” reviews also block until addressed. <code>GET .../pulls/{n}/mergeability</code> reports the gates. Close is the author or an admin. The author may <code>PATCH /v1/repos/{org}/{repo}/pulls/{n}</code> with <code>{ title?, body? }</code> (others 403, anonymous 401). <code>GET</code> of a pull includes <code>comment_count</code> and <code>approval_count</code>. File diffs use <code>status: added | modified | removed</code>.</p>

  <h2>Issues</h2>
  <p>ScionBase numbers Issues and Pull Requests in one shared per-repo sequence, like GitHub. An issue has a title, a description (<code>body</code>, optional, default empty), and comments from anyone signed in. Title and description are editable only by the issue author (site admin override). Comments live on a subresource — <code>GET .../issues/{n}</code> returns <code>comment_count</code>, not the comment list.</p>
  <pre><code>scn issue create --title "Bug: cannot frob the flux"
scn issue list
scn issue show 3
scn issue comment 3 --body "I can reproduce this"
scn issue comments 3
scn issue close 3
scn issue reopen 3</code></pre>
  <p>API: <code>POST /v1/repos/{org}/{repo}/issues</code> (<code>{ title, body?, labels?, assignees?, tag? }</code>; any authed user), <code>GET .../issues?tag=</code>, <code>GET .../issues/{n}</code>, <code>PATCH .../issues/{n}</code> (author or admin), <code>POST .../issues/{n}/close</code>, <code>POST .../issues/{n}/reopen</code> (author or admin). Comments: <code>GET/POST .../issues/{n}/comments</code> (POST is any authed user), <code>PATCH/DELETE .../issues/{n}/comments/{id}</code> (comment author or admin).</p>
  <p>Boards are owned by one org but can list issues from any org. Create/update/delete require an org admin. Empty <code>sources</code> means every org the caller can see.</p>
  <pre><code>scn board create triage --org acme --tag bug
scn board create platform --org acme --source filecoin-project --source other/lotus
scn board list --org acme
scn board show triage --org acme</code></pre>
  <p>API: <code>GET/POST /v1/orgs/{org}/boards</code>, <code>GET/PATCH/DELETE /v1/orgs/{org}/boards/{nameOrId}</code> (GET returns <code>{ board, issues }</code>).</p>

  <h2>Fork-less contributions</h2>
  <p>Public repos accept contributions without creating a fork: non-members can push branches under <code>refs/heads/users/&lt;you&gt;/&lt;name&gt;</code> and open a PR from that ref. The CLI adds a helper:</p>
  <pre><code>scn branch new feat-x
scn push -m "work in progress"               # publishes refs/heads/users/&lt;you&gt;/feat-x
scn pr create --title "Feat X" --head users/&lt;you&gt;/feat-x</code></pre>

  <h2>Outbound webhooks</h2>
  <p>Per-repo webhooks deliver signed JSON on events: <code>pull_request</code> (opened/closed/merged/synchronize), <code>pull_request_review</code>, <code>issue</code> (opened/closed/edited), and <code>check_run</code> completion. Headers include <code>X-Scionbase-Event</code> and <code>X-Scionbase-Signature-256</code> (<code>sha256=</code> + HMAC hex).</p>
  <pre><code># API (Bearer):
GET  /v1/repos/{org}/{repo}/hooks
POST /v1/repos/{org}/{repo}/hooks        { "url": "...", "secret": "...", "events": ["pull_request","issue"] }
GET  /v1/repos/{org}/{repo}/hooks/{id}
PATCH /v1/repos/{org}/{repo}/hooks/{id}  { "url"?, "secret"?, "events"? }
DELETE /v1/repos/{org}/{repo}/hooks/{id}</code></pre>
  <p>Comments (anonymous GET): <code>GET/POST .../pulls/{n}/comments</code> with <code>{ body, path?, line?, side? }</code> (<code>side</code> is <code>old</code> or <code>new</code>; omit <code>path</code> for a general conversation comment; body ≤ 10 000 characters). <code>PATCH .../comments/{id}</code> with <code>{ resolved: bool }</code> is the comment author or the PR author. <code>DELETE .../comments/{id}</code> is the comment author or a site admin. Approvals (anonymous GET): <code>GET/POST/DELETE .../pulls/{n}/approvals</code> — each approval is <code>{ user, owner }</code>; the PR author cannot approve (403); <code>POST</code> is idempotent; <code>DELETE</code> removes your own approval.</p>

  <h2>Shell completion</h2>
  <pre><code>scn completion bash &gt; ~/.local/share/bash-completion/completions/scn
scn completion zsh  &gt; "\${fpath[1]}/_scn"
scn completion fish &gt; ~/.config/fish/completions/scn.fish</code></pre>
  <p>Bash can complete branch names by also sourcing a wrapper that calls <code>scn __complete-branches</code>.</p>

  <h2>How reads reach Filecoin</h2>
  <p>Clone walks trees via <code>POST /v1/repos/{org}/{repo}/objects</code>, then resolves blob PieceCIDs with <code>POST .../objects/resolve</code> (Worker→RepoDO bundle map; no engine hairpin). The client Range-GETs the bundle piece on the storage provider. <code>GET .../objects/{id-or-pieceCid}</code> returns a JSON hint <code>{ url, offset, length }</code> from the same map. Authorization is never sent on the cross-origin hop.</p>
  <p>Anonymous CORS GETs for a web repo page: <code>GET /v1/repos/{org}/{repo}</code> (empty repos still return JSON), <code>GET .../refs/{name}</code> + <code>GET .../changesets/{id}</code> (message, author, time, parents, root tree, <code>pcid:</code> metadata), <code>GET .../tree/{ref}?path=</code>, <code>GET .../blob/{ref}?path=</code> (<code>{pieceCid,url,offset,length,size}</code> when the piece map has a row; otherwise <code>contentBase64</code>/<code>raw</code> from the engine or a small RepoDO object fallback; engine-fail blob/tree/ref reads fall back to RepoDO). <code>GET .../commits/{ref}?limit=20</code>, <code>GET /v1/orgs/{org}/repos</code>, <code>GET .../branches</code>. Authenticated <code>DELETE .../refs/{name}</code> drops a ref (owner of <code>users/&lt;you&gt;/*</code>, or org member; default branch is admin-only).</p>

  <h2>PoC limits</h2>
  <ul class="limits">
    <li>Filecoin Calibration network (calibnet), not mainnet.</li>
    <li>New orgs share the platform PDP dataset (<code>filecoin-project</code>, on-chain 46121) instead of creating their own. An admin can switch an org to <code>own</code> (<code>POST /v1/admin/orgs/{org}/dataset-mode</code>); creation is lazy on the next add. If the shared dataset exceeds 40&nbsp;GiB, <code>/v1/admin/durability</code> flags <code>sharedDataset.over</code> and an admin decides. Pending adds batch up to 1&nbsp;h or 50 pieces (see <code>docs/datasets.md</code>). If the payer lacks lockup funds or allowance, pieces stay queued and are retried with backoff (reads keep working from the SP meanwhile).</li>
    <li>Commits (<code>commit</code> / <code>push</code>) upload only new or changed file content to the storage provider. Unchanged paths reuse the parent changeset’s <code>pcid:&lt;path&gt;</code> metadata, so a merged PR is cloneable.</li>
    <li>A single engine container (<code>max_instances 1</code>, lite, sleeps after 30s).</li>
    <li>Non-member blob uploads: 10&nbsp;MB. Pull request title ≤ 120 characters, body ≤ 10&nbsp;000.</li>
    <li>Signup: 5 attempts per IP per hour, 200 users total.</li>
    <li>Non-admin repo create: 3 repos unpaid, 100 paid. Admins unlimited.</li>
  </ul>
  <p class="muted">Same page: <code>docs/getting-started.md</code> in the repository.</p>
</body>
</html>`;
}
