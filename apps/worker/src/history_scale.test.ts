//! Bounded history reads, and archive chunks whose log/blame/show/bisect/tree match.

import { DatabaseSync } from "node:sqlite";

import { closeCachedArchives } from "./archive_db";
import { memoryPieceStore } from "./archive";
import { ensureCommpSchema, type RepoSql } from "./pieces";
import { writeBlameCache } from "./history_schema";
import {
  maybeAutoArchive,
  prepareHistory,
  readBlame,
  readFirstParent,
  readLog,
  readShow,
  readTree,
  runArchive,
  type HistorySource,
} from "./history_read";

const ok = (cond: unknown, message: string): void => {
  if (!cond) throw new Error(message);
};

function idOf(n: number): string {
  return n.toString(16).padStart(64, "0");
}

type Stats = { rows: number; bodyRows: number; on: boolean };

function openSql(): { sql: RepoSql; stats: Stats; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  const stats: Stats = { rows: 0, bodyRows: 0, on: false };
  const note = (statement: string, count: number) => {
    if (!stats.on) return;
    stats.rows += count;
    if (/\bbody\b/i.test(statement)) stats.bodyRows += count;
  };
  const inner: RepoSql = {
    async sqlAll(statement, params = []) {
      const rows = db.prepare(statement).all(...(params as [])) as Record<string, unknown>[];
      note(statement, rows.length);
      return rows;
    },
    async sqlOne(statement, params = []) {
      const row = db.prepare(statement).get(...(params as [])) as Record<string, unknown> | undefined;
      note(statement, row ? 1 : 0);
      return row ?? null;
    },
    async sqlRun(statement, params = []) {
      db.prepare(statement).run(...(params as []));
    },
    databaseSize() {
      const row = db.prepare("SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()").get() as { n: number };
      return Number(row.n);
    },
  };
  return { sql: inner, stats, db };
}

async function schema(sql: RepoSql): Promise<void> {
  await sql.sqlRun(
    `CREATE TABLE changesets (
      id TEXT PRIMARY KEY, lsn INTEGER NOT NULL, root_tree TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL
    )`
  );
  await sql.sqlRun(`CREATE INDEX idx_changesets_lsn ON changesets(lsn)`);
  await sql.sqlRun(`CREATE TABLE refs (name TEXT PRIMARY KEY, target TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL, root_tree TEXT)`);
  await sql.sqlRun(`CREATE TABLE tags (name TEXT PRIMARY KEY, target TEXT NOT NULL, message TEXT, author TEXT, created_at INTEGER NOT NULL, annotated INTEGER NOT NULL DEFAULT 0)`);
  await sql.sqlRun(`CREATE TABLE objects (id TEXT PRIMARY KEY, bytes BLOB NOT NULL, created_at INTEGER NOT NULL)`);
  await sql.sqlRun(`CREATE TABLE blame_cache (path TEXT NOT NULL, tip TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (path, tip))`);
  await ensureCommpSchema(sql);
}

function changesetBody(n: number, parent: string | null, rareEvery: number): string {
  const changes: { op: string; path: string; kind: string; blob: string }[] = [
    { op: "upsert", path: "hot.txt", kind: "file", blob: idOf(1_000_000 + n) },
  ];
  if (n % rareEvery === 0) changes.push({ op: "upsert", path: "rare.txt", kind: "file", blob: idOf(2_000_000 + n) });
  return JSON.stringify({
    parents: parent ? [parent] : [],
    author: n % 2 ? "ada" : "grace",
    message: `c${n}`,
    created_at: n,
    changes,
    metadata: {},
  });
}

async function seed(sql: RepoSql, count: number, rareEvery: number): Promise<void> {
  await sql.sqlRun("BEGIN");
  for (let n = 1; n <= count; n++) {
    const parent = n === 1 ? null : idOf(n - 1);
    await sql.sqlRun(`INSERT INTO changesets (id, lsn, root_tree, body, created_at) VALUES (?, ?, ?, ?, ?)`, [
      idOf(n),
      n,
      idOf(9_000_000 + n),
      changesetBody(n, parent, rareEvery),
      n,
    ]);
    await sql.sqlRun(`INSERT INTO objects (id, bytes, created_at) VALUES (?, ?, ?)`, [
      idOf(1_000_000 + n),
      new TextEncoder().encode(`hot ${n}\n`),
      n,
    ]);
    if (n % rareEvery === 0) {
      await sql.sqlRun(`INSERT INTO objects (id, bytes, created_at) VALUES (?, ?, ?)`, [
        idOf(2_000_000 + n),
        new TextEncoder().encode(`rare ${n}\n`),
        n,
      ]);
    }
  }
  await sql.sqlRun(`INSERT INTO refs (name, target, version, updated_at, root_tree) VALUES ('refs/heads/main', ?, 1, 1, ?)`, [
    idOf(count),
    idOf(9_000_000 + count),
  ]);
  await sql.sqlRun("COMMIT");
}

function source(sql: RepoSql, store = memoryPieceStore()): HistorySource {
  return { sql, store };
}

async function fullLog(src: HistorySource, tip: string): Promise<string> {
  const pages = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 100; guard++) {
    const page = await readLog(src, { tip, limit: 100, cursor });
    pages.push(page.commits);
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  return JSON.stringify(pages);
}

async function bounded(): Promise<void> {
  const { sql, stats } = openSql();
  await schema(sql);
  const count = 20_000;
  await seed(sql, count, 1000);
  await prepareHistory(sql, 1000);
  const src = source(sql);
  const tip = idOf(count);
  stats.rows = 0;
  stats.bodyRows = 0;
  stats.on = true;
  const heapBefore = process.memoryUsage().heapUsed;
  const log = await readLog(src, { tip, limit: 20 });
  const logRows = stats.rows;
  const logBodies = stats.bodyRows;
  const heapDelta = process.memoryUsage().heapUsed - heapBefore;
  ok(log.commits.length === 20, "log returns 20");
  ok(logBodies === 0, `log reads no bodies (${logBodies})`);
  ok(logRows < 200, `log row bound ${logRows}`);
  ok(heapDelta < 48 * 1024 * 1024, `log heap delta ${heapDelta}`);

  stats.rows = 0;
  stats.bodyRows = 0;
  const shown = await readShow(src, idOf(15_000));
  ok(shown?.id === idOf(15_000), "show finds the commit");
  ok(stats.bodyRows <= 2, `show body rows ${stats.bodyRows}`);
  const showBodies = stats.bodyRows;

  stats.rows = 0;
  stats.bodyRows = 0;
  const rare = await readLog(src, { tip, limit: 20, path: "rare.txt" });
  ok(rare.commits.length === 20, "rare path page is 20");
  ok(rare.commits.every((row) => row.paths.includes("rare.txt")), "path filter");
  ok(stats.bodyRows === 0, "path log reads no bodies");
  ok(stats.rows < 400, `path log rows ${stats.rows}`);

  stats.rows = 0;
  stats.bodyRows = 0;
  const blame = await readBlame(src, tip, "rare.txt");
  ok((blame?.lines.length ?? 0) > 0, "blame has lines");
  ok(stats.bodyRows === 0, "blame reads no changeset bodies");
  ok(stats.rows < 500, `blame rows ${stats.rows}`);

  stats.rows = 0;
  stats.bodyRows = 0;
  const tree = await readTree(src, idOf(15_500), "");
  ok(tree?.deltas != null && tree.deltas <= 1000, `tree deltas ${tree?.deltas}`);
  ok(tree?.archives === 0, "live tree opens no archive");
  ok((tree?.entries.length ?? 0) >= 1, "tree has files");
  ok(stats.bodyRows <= 1000, `tree bodies ${stats.bodyRows}`);

  const exact = await readTree(src, idOf(15_000), "");
  ok(exact?.deltas === 0, `checkpoint boundary replays ${exact?.deltas}`);

  stats.rows = 0;
  stats.bodyRows = 0;
  const steps = await readFirstParent(src, tip, idOf(count - 30));
  ok(steps?.length === 30, `bisect steps ${steps?.length}`);
  ok(stats.bodyRows === 0, "bisect reads no bodies");
  ok(stats.rows < 200, `bisect rows ${stats.rows}`);

  console.log(
    JSON.stringify({
      scale: {
        commits: count,
        log_rows: logRows,
        log_bodies: logBodies,
        log_heap_bytes: heapDelta,
        show_bodies: showBodies,
        rare_commits: rare.commits.length,
        blame_lines: blame?.lines.length ?? 0,
        tree_deltas: tree?.deltas,
        tree_archives: tree?.archives,
        boundary_deltas: exact?.deltas,
        bisect_steps: steps?.length,
      },
    })
  );
}

async function capture(src: HistorySource, tip: string, archivedId: string, liveId: string, treeId: string) {
  return {
    log: await fullLog(src, tip),
    path: JSON.stringify(await readLog(src, { tip, limit: 50, path: "rare.txt" })),
    blame: JSON.stringify(await readBlame(src, tip, "hot.txt")),
    showArchived: JSON.stringify(await readShow(src, archivedId)),
    showLive: JSON.stringify(await readShow(src, liveId)),
    bisect: JSON.stringify(await readFirstParent(src, tip, idOf(10))),
    tree: JSON.stringify((await readTree(src, treeId, ""))?.entries ?? null),
    tipTree: JSON.stringify((await readTree(src, tip, ""))?.entries ?? null),
  };
}

async function archived(): Promise<void> {
  const { sql } = openSql();
  await schema(sql);
  const count = 240;
  await seed(sql, count, 20);
  await prepareHistory(sql, 1000);
  const store = memoryPieceStore();
  const src = source(sql, store);
  const tip = idOf(count);
  const before = await capture(src, tip, idOf(50), tip, idOf(100));
  const wrote = await runArchive(src, tip, { chunkCommits: 80, chunkBytes: 8_000_000, allowPartial: true });
  ok(wrote.archives.length >= 2, `archive chunks ${wrote.archives.length}`);
  const after = await capture(src, tip, idOf(50), tip, idOf(100));
  ok(before.log === after.log, "log identical");
  ok(before.path === after.path, "path log identical");
  ok(before.blame === after.blame, "blame identical");
  ok(before.showArchived === after.showArchived, "archived show identical");
  ok(before.showLive === after.showLive, "live show identical");
  ok(before.bisect === after.bisect, "bisect identical");
  ok(before.tree === after.tree, "historical tree identical");
  ok(before.tipTree === after.tipTree, "tip tree identical");
  const live = await sql.sqlOne<{ n: number }>(`SELECT COUNT(*) AS n FROM changesets`);
  ok(Number(live?.n) < count, `live rows shrunk to ${live?.n}`);
  ok(Number(live?.n) >= 1, "tip stayed live");
  const historical = await readTree(src, idOf(100), "");
  const tipTree = await readTree(src, tip, "");
  ok(historical?.archives === 1, `historical archives ${historical?.archives}`);
  ok(tipTree?.archives === 0, `tip archives ${tipTree?.archives}`);
  ok((historical?.deltas ?? 9999) <= 80, `historical deltas ${historical?.deltas}`);
  for (const archive of wrote.archives) {
    const bytes = await store.get(archive.piece_cid);
    ok(bytes != null && bytes.length === archive.size, "piece stored");
    let failed = false;
    try {
      await store.put(archive.piece_cid, new Uint8Array([1, 2, 3]));
    } catch {
      failed = true;
    }
    ok(failed, "piece is write-once");
  }
  const again = await runArchive(src, tip, { chunkCommits: 80, chunkBytes: 8_000_000, allowPartial: true });
  ok(again.archives.length === 0, "second archive writes nothing new");
  console.log(
    JSON.stringify({
      archive: {
        commits: count,
        chunks: wrote.archives.length,
        live_left: Number(live?.n),
        log_bytes: before.log.length,
        identical: true,
        historical_archives: historical?.archives,
        historical_deltas: historical?.deltas,
        tip_archives: tipTree?.archives,
      },
    })
  );
}

async function autoAndCache(): Promise<void> {
  const opened = openSql();
  const size = opened.sql.databaseSize?.bind(opened.sql);
  opened.sql.databaseSize = () => 50_000_000;
  await schema(opened.sql);
  await seed(opened.sql, 100, 10);
  await prepareHistory(opened.sql, 1000);
  const store = memoryPieceStore();
  const none = await maybeAutoArchive(source(opened.sql, store), 0, 40, 8_000_000);
  ok(none.length === 0, "threshold off does not archive");
  opened.sql.databaseSize = () => 50_000_000;
  const wrote = await maybeAutoArchive(source(opened.sql, store), 1000, 40, 8_000_000);
  ok(wrote.length === 2, `auto chunks ${wrote.length}`);
  const live = await opened.sql.sqlOne<{ n: number }>(`SELECT COUNT(*) AS n FROM changesets`);
  ok(Number(live?.n) === 20, `auto tail ${live?.n}`);
  void size;

  await writeBlameCache(opened.sql, "hot.txt", idOf(1), "a", 1);
  await writeBlameCache(opened.sql, "hot.txt", idOf(2), "b", 2);
  await writeBlameCache(opened.sql, "hot.txt", idOf(3), "c", 3);
  const one = await opened.sql.sqlOne<{ n: number }>(`SELECT COUNT(*) AS n FROM blame_cache WHERE path = 'hot.txt'`);
  ok(Number(one?.n) === 1, "one tip per path");
  for (let n = 0; n < 300; n++) {
    await writeBlameCache(opened.sql, `p${n}.txt`, idOf(n + 1), "x", n);
  }
  const capped = await opened.sql.sqlOne<{ n: number }>(`SELECT COUNT(*) AS n FROM blame_cache`);
  ok(Number(capped?.n) <= 256, `blame cache cap ${capped?.n}`);
}

await bounded();
await archived();
await autoAndCache();
await closeCachedArchives();
console.log("history scale ok");
