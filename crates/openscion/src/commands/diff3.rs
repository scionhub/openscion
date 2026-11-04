//! Line-based three-way merge with git-style conflict markers.

const LOCAL_MARK: &str = "<<<<<<< local";
const MID_MARK: &str = "=======";

/// Marker written at the start of a conflict hunk.
#[must_use]
pub(crate) fn local_marker() -> &'static str {
    LOCAL_MARK
}

/// Marker written at the end of a conflict hunk, labelled with `--from`.
#[must_use]
pub(crate) fn other_marker(from: &str) -> String {
    format!(">>>>>>> {from}")
}

/// Whether `bytes` contain an unresolved `<<<<<<< local` conflict marker.
#[must_use]
pub(crate) fn contains_conflict_markers(bytes: &[u8]) -> bool {
    let needle = local_marker().as_bytes();
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.lines().any(|line| line == local_marker());
    }
    bytes.windows(needle.len()).any(|window| window == needle)
}

/// Result of merging two versions against a common ancestor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Merge3 {
    /// Merged bytes, possibly containing conflict markers.
    pub bytes: Vec<u8>,
    /// True when at least one conflict hunk was emitted.
    pub conflict: bool,
}

/// Merges `local` and `other` against `base`. Conflicts are marked with
/// `<<<<<<< local` / `=======` / `>>>>>>> {other_label}`.
#[must_use]
pub(crate) fn merge3(base: &[u8], local: &[u8], other: &[u8], other_label: &str) -> Merge3 {
    if local == other {
        return Merge3 {
            bytes: local.to_vec(),
            conflict: false,
        };
    }
    if local == base {
        return Merge3 {
            bytes: other.to_vec(),
            conflict: false,
        };
    }
    if other == base {
        return Merge3 {
            bytes: local.to_vec(),
            conflict: false,
        };
    }
    match (
        std::str::from_utf8(base),
        std::str::from_utf8(local),
        std::str::from_utf8(other),
    ) {
        (Ok(b), Ok(l), Ok(o)) => merge_text(b, l, o, other_label),
        _ => conflict_bytes(local, other, other_label),
    }
}

fn conflict_bytes(local: &[u8], other: &[u8], other_label: &str) -> Merge3 {
    let mut bytes = Vec::new();
    push_line(&mut bytes, LOCAL_MARK);
    bytes.extend_from_slice(local);
    if !local.is_empty() && !local.ends_with(b"\n") {
        bytes.push(b'\n');
    }
    push_line(&mut bytes, MID_MARK);
    bytes.extend_from_slice(other);
    if !other.is_empty() && !other.ends_with(b"\n") {
        bytes.push(b'\n');
    }
    push_line(&mut bytes, &other_marker(other_label));
    Merge3 {
        bytes,
        conflict: true,
    }
}

fn push_line(out: &mut Vec<u8>, line: &str) {
    out.extend_from_slice(line.as_bytes());
    out.push(b'\n');
}

fn split_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<&str> = text.split('\n').collect();
    if text.ends_with('\n') {
        lines.pop();
    }
    lines
}

fn join_lines(lines: &[String], trailing_nl: bool) -> Vec<u8> {
    if lines.is_empty() {
        return Vec::new();
    }
    let mut out = lines.join("\n");
    if trailing_nl {
        out.push('\n');
    }
    out.into_bytes()
}

fn merge_text(base: &str, local: &str, other: &str, other_label: &str) -> Merge3 {
    let base_lines = split_lines(base);
    let local_lines = split_lines(local);
    let other_lines = split_lines(other);
    let local_hunks = diff_hunks(&base_lines, &local_lines);
    let other_hunks = diff_hunks(&base_lines, &other_lines);
    let (merged, conflict) = stitch(
        &base_lines,
        &local_lines,
        &other_lines,
        &local_hunks,
        &other_hunks,
        other_label,
    );
    let trailing_nl = base.ends_with('\n') || local.ends_with('\n') || other.ends_with('\n');
    Merge3 {
        bytes: join_lines(&merged, trailing_nl || conflict),
        conflict,
    }
}

#[derive(Debug, Clone, Copy)]
struct Hunk {
    a_start: usize,
    a_len: usize,
    b_start: usize,
    b_len: usize,
}

fn stitch(
    base: &[&str],
    local: &[&str],
    other: &[&str],
    local_hunks: &[Hunk],
    other_hunks: &[Hunk],
    other_label: &str,
) -> (Vec<String>, bool) {
    let mut out = Vec::new();
    let mut conflict = false;
    let mut i = 0usize;
    let mut j = 0usize;
    let mut base_at = 0usize;
    let end_mark = other_marker(other_label);
    while i < local_hunks.len() || j < other_hunks.len() {
        match (local_hunks.get(i), other_hunks.get(j)) {
            (None, None) => break,
            (Some(h), None) => {
                push_equal(&mut out, base, base_at, h.a_start);
                push_side(&mut out, local, h.b_start, h.b_len);
                base_at = h.a_start + h.a_len;
                i += 1;
            }
            (None, Some(h)) => {
                push_equal(&mut out, base, base_at, h.a_start);
                push_side(&mut out, other, h.b_start, h.b_len);
                base_at = h.a_start + h.a_len;
                j += 1;
            }
            (Some(a), Some(b)) => {
                let a_end = a.a_start + a.a_len;
                let b_end = b.a_start + b.a_len;
                if a_end <= b.a_start {
                    push_equal(&mut out, base, base_at, a.a_start);
                    push_side(&mut out, local, a.b_start, a.b_len);
                    base_at = a_end;
                    i += 1;
                } else if b_end <= a.a_start {
                    push_equal(&mut out, base, base_at, b.a_start);
                    push_side(&mut out, other, b.b_start, b.b_len);
                    base_at = b_end;
                    j += 1;
                } else {
                    let start = a.a_start.min(b.a_start);
                    let (end, ii, jj) = union_span(local_hunks, other_hunks, i, j, start);
                    push_equal(&mut out, base, base_at, start);
                    let local_slice = slice_mapped(base, local, local_hunks, i, ii, start, end);
                    let other_slice = slice_mapped(base, other, other_hunks, j, jj, start, end);
                    if local_slice == other_slice {
                        out.extend(local_slice);
                    } else {
                        conflict = true;
                        out.push(LOCAL_MARK.to_owned());
                        out.extend(local_slice);
                        out.push(MID_MARK.to_owned());
                        out.extend(other_slice);
                        out.push(end_mark.clone());
                    }
                    base_at = end;
                    i = ii;
                    j = jj;
                }
            }
        }
    }
    push_equal(&mut out, base, base_at, base.len());
    (out, conflict)
}

fn union_span(
    local_hunks: &[Hunk],
    other_hunks: &[Hunk],
    mut i: usize,
    mut j: usize,
    start: usize,
) -> (usize, usize, usize) {
    let mut end = start;
    if let Some(h) = local_hunks.get(i) {
        end = end.max(h.a_start + h.a_len);
    }
    if let Some(h) = other_hunks.get(j) {
        end = end.max(h.a_start + h.a_len);
    }
    loop {
        let mut grew = false;
        while i < local_hunks.len() && local_hunks[i].a_start < end {
            end = end.max(local_hunks[i].a_start + local_hunks[i].a_len);
            i += 1;
            grew = true;
        }
        while j < other_hunks.len() && other_hunks[j].a_start < end {
            end = end.max(other_hunks[j].a_start + other_hunks[j].a_len);
            j += 1;
            grew = true;
        }
        if !grew {
            break;
        }
    }
    (end, i, j)
}

fn push_equal(out: &mut Vec<String>, base: &[&str], from: usize, to: usize) {
    for line in base.get(from..to).into_iter().flatten() {
        out.push((*line).to_owned());
    }
}

fn push_side(out: &mut Vec<String>, side: &[&str], start: usize, len: usize) {
    for line in side.get(start..start + len).into_iter().flatten() {
        out.push((*line).to_owned());
    }
}

fn slice_mapped(
    base: &[&str],
    side: &[&str],
    hunks: &[Hunk],
    hunk_from: usize,
    hunk_to: usize,
    start: usize,
    end: usize,
) -> Vec<String> {
    let mut out = Vec::new();
    let mut at = start;
    for h in hunks.get(hunk_from..hunk_to).into_iter().flatten() {
        if h.a_start > at {
            let take = h.a_start.min(end);
            for line in base.get(at..take).into_iter().flatten() {
                out.push((*line).to_owned());
            }
        }
        for line in side
            .get(h.b_start..h.b_start + h.b_len)
            .into_iter()
            .flatten()
        {
            out.push((*line).to_owned());
        }
        at = h.a_start + h.a_len;
        if at >= end {
            return out;
        }
    }
    if end > at {
        for line in base.get(at..end).into_iter().flatten() {
            out.push((*line).to_owned());
        }
    }
    out
}

fn diff_hunks(left: &[&str], right: &[&str]) -> Vec<Hunk> {
    if left.is_empty() && right.is_empty() {
        return Vec::new();
    }
    let left_len = left.len();
    let right_len = right.len();
    if left_len.saturating_mul(right_len) > 4_000_000 {
        return vec![Hunk {
            a_start: 0,
            a_len: left_len,
            b_start: 0,
            b_len: right_len,
        }];
    }
    let mut dp = vec![0u32; (left_len + 1) * (right_len + 1)];
    let idx = |row: usize, col: usize| row * (right_len + 1) + col;
    for row in 0..left_len {
        for col in 0..right_len {
            dp[idx(row + 1, col + 1)] = if left[row] == right[col] {
                dp[idx(row, col)] + 1
            } else {
                dp[idx(row + 1, col)].max(dp[idx(row, col + 1)])
            };
        }
    }
    let mut ops = Vec::new();
    let mut row = left_len;
    let mut col = right_len;
    while row > 0 || col > 0 {
        if row > 0 && col > 0 && left[row - 1] == right[col - 1] {
            ops.push(Op::Eq);
            row -= 1;
            col -= 1;
        } else if col > 0
            && (row == 0 || dp[idx(row, col - 1)] >= dp[idx(row.saturating_sub(1), col)])
        {
            ops.push(Op::Ins);
            col -= 1;
        } else {
            ops.push(Op::Del);
            row -= 1;
        }
    }
    ops.reverse();
    hunks_from_ops(&ops)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Op {
    Eq,
    Ins,
    Del,
}

fn hunks_from_ops(ops: &[Op]) -> Vec<Hunk> {
    let mut hunks = Vec::new();
    let mut a_at = 0usize;
    let mut b_at = 0usize;
    let mut k = 0usize;
    while k < ops.len() {
        if ops[k] == Op::Eq {
            a_at += 1;
            b_at += 1;
            k += 1;
            continue;
        }
        let a_start = a_at;
        let b_start = b_at;
        while k < ops.len() && ops[k] != Op::Eq {
            match ops[k] {
                Op::Del => a_at += 1,
                Op::Ins => b_at += 1,
                Op::Eq => {}
            }
            k += 1;
        }
        hunks.push(Hunk {
            a_start,
            a_len: a_at - a_start,
            b_start,
            b_len: b_at - b_start,
        });
    }
    hunks
}
