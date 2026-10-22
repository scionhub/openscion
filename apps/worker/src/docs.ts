/** Getting Started HTML served at GET /docs. Keep in sync with docs/getting-started.md. */

export function docsHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>OpenScion — Getting Started</title>
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
  <p class="muted">Commands &amp; usage for the ScionHub OpenScion proof of concept. The CLI binary is <code>opnscn</code>.</p>

  <h2>Install the CLI</h2>
  <pre><code>cargo install --git https://github.com/scionhub/openscion --branch cursor/storage-and-multirepo-e719 openscion</code></pre>
  <p>Point the client at this Worker (every command also accepts <code>--server &lt;URL&gt;</code>):</p>
  <pre><code>export OPENSCION_SERVER=https://&lt;this-worker-host&gt;</code></pre>

  <h2>Clone without an account</h2>
  <p>Public-repo reads (catalog, refs, changesets, objects, trees, and <code>objects/resolve|missing|present</code>) need no token. <code>opnscn clone</code> works with no credentials file.</p>
  <pre><code>opnscn clone ./lotus --repo filecoin-project/lotus
opnscn clone ./lotus --repo filecoin-project/lotus --ref main
opnscn clone ./lotus --repo filecoin-project/lotus --path src</code></pre>

  <h2>Create an account and log in</h2>
  <p>Password is read from <code>OPNSCN_PASSWORD</code> (or <code>OPENSCION_PASSWORD</code>) or prompted on stdin. Username must match <code>^[a-z0-9][a-z0-9-]{2,31}$</code>; password at least 10 characters.</p>
  <pre><code>opnscn signup --username alice
opnscn signup --username alice --email alice@example.com
opnscn login --user alice</code></pre>
  <p>Both commands store a bearer token for later writes. Signup is capped at 5 attempts per IP per hour and 200 users total.</p>

  <h2>Create a repository</h2>
  <p>Logged-in users can create a public repo under their username org (created on first use) or an org they belong to. <code>filecoin-project</code> stays admin-only. Non-admins are limited to 3 repos. The name must match <code>^[a-z0-9][a-z0-9._-]{0,63}$</code>.</p>
  <pre><code>opnscn repo create my-repo
opnscn repo create my-repo --org alice</code></pre>
  <p>The API is <code>POST /v1/repos</code> with <code>{ "name": "my-repo", "org": "alice" }</code> (<code>org</code> optional; defaults to your username). The response includes an informational <code>retention</code> object (<code>freeDays</code>, <code>payUrl</code>); nothing is deleted automatically.</p>
  <pre><code>opnscn import ./src --repo alice/my-repo
opnscn commit -m "first" --ref main</code></pre>

  <h2>Edit and push a branch</h2>
  <p>Org members can move any ref. Anyone logged in can push under <code>refs/heads/users/&lt;username&gt;/*</code> on a public repo. Non-member uploads are capped at 10&nbsp;MB.</p>
  <pre><code>cd lotus
# edit files, then either:
opnscn commit -m "my change" --ref refs/heads/users/alice/my-branch
# or, equivalent helper (prefixes refs/heads/users/&lt;you&gt;/ unless NAME already starts with refs/):
opnscn branch push my-branch
opnscn branch push my-branch -m "my change"</code></pre>

  <h2>Open, list, and merge a pull request</h2>
  <p>Repo is inferred from the working copy, or pass <code>--repo org/repo</code>.</p>
  <pre><code>opnscn pr create --title "Fix the thing" --head refs/heads/users/alice/my-branch
opnscn pr create --title "Fix the thing" --body "details" --head refs/heads/users/alice/my-branch --base main
opnscn pr list
opnscn pr show 1
opnscn pr merge 1
opnscn pr close 1</code></pre>
  <p>Merge is org admin/member only and fast-forwards the base ref to the head target when the head changeset’s first parent is still the current base. Close is the author or an admin.</p>

  <h2>Sync a branch and resolve conflicts</h2>
  <p><code>opnscn sync</code> three-way-merges the working copy with a target ref (default <code>main</code>), including uncommitted local edits. Upstream-only changes are taken; local-only changes are kept; both-changed paths get git-style markers. The next <code>opnscn commit</code> / <code>opnscn branch push</code> records a changeset whose first parent is that target so <code>opnscn pr merge</code> can fast-forward. Commit refuses while <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt; local</code> markers remain.</p>
  <pre><code>opnscn clone ./work --repo alice/my-repo
cd work
opnscn branch push feature
opnscn sync
opnscn sync --from main --dir .</code></pre>
  <p>A conflicted file looks like:</p>
  <pre><code>&lt;&lt;&lt;&lt;&lt;&lt;&lt; local
the line as it is on your branch
=======
the line as it is on main
&gt;&gt;&gt;&gt;&gt;&gt;&gt; main</code></pre>
  <pre><code>opnscn commit -m "merge main"
opnscn branch push feature
opnscn pr create --title "Feature" --head refs/heads/users/alice/feature
opnscn pr merge 1</code></pre>

  <h2>How reads reach Filecoin</h2>
  <p>Clone walks trees via <code>POST /v1/repos/{org}/{repo}/objects</code>, then resolves blob PieceCIDs with <code>POST .../objects/resolve</code>. The client Range-GETs the bundle piece on the storage provider. <code>GET .../objects/{id-or-pieceCid}</code> either 302s to the SP or returns a JSON hint <code>{ url, offset, length }</code> for the same Range GET. Authorization is never sent on the cross-origin hop.</p>
  <p>Anonymous CORS GETs for a web repo page: <code>GET /v1/repos/{org}/{repo}</code> (empty repos still return JSON), <code>GET .../refs/{name}</code> + <code>GET .../changesets/{id}</code> (message, author, time, parents, root tree, <code>pcid:</code> metadata), <code>GET .../tree/{ref}?path=</code>, <code>GET .../blob/{ref}?path=</code> (<code>{pieceCid,url,offset,length,size}</code> or JSON with <code>contentBase64</code>/<code>raw</code>), <code>GET .../commits/{ref}?limit=20</code>, <code>GET /v1/orgs/{org}/repos</code>, <code>GET .../branches</code>.</p>

  <h2>PoC limits</h2>
  <ul class="limits">
    <li>Filecoin Calibration network (calibnet), not mainnet.</li>
    <li>Each org (user namespaces count as orgs) gets its own PDP dataset on calibnet (clientDataSetId = sha256(org)), created lazily on the first on-chain add; filecoin-project uses dataset 46121. If the payer lacks lockup funds or allowance, pieces stay queued and are retried with backoff (reads keep working from the SP meanwhile).</li>
    <li>Commits (<code>commit</code> / <code>branch push</code>) upload only new or changed file content to the storage provider. Unchanged paths reuse the parent changeset’s <code>pcid:&lt;path&gt;</code> metadata, so a merged PR is cloneable.</li>
    <li>A single engine container (<code>max_instances 1</code>, lite, sleeps after 30s).</li>
    <li>Non-member blob uploads: 10&nbsp;MB. Pull request title ≤ 120 characters, body ≤ 10&nbsp;000.</li>
    <li>Signup: 5 attempts per IP per hour, 200 users total.</li>
    <li>Non-admin repo create: 3 repos per user.</li>
  </ul>
  <p class="muted">Same page: <code>docs/getting-started.md</code> in the repository.</p>
</body>
</html>`;
}
