//! The working-copy commands: `import`, `commit`, and `clone`.
//!
//! Each command talks to the server through a [`ServerClient`] and to the
//! disk through the working-copy module, and returns a summary the CLI
//! prints.
//!
//! - **import** records a whole directory as the repository's first
//!   changeset and creates the ref.
//! - **commit** records what changed since the base changeset and moves the
//!   ref from the base to the new changeset by compare-and-swap. If someone
//!   else moved it first the swap fails; there is no rebase yet, so the
//!   changeset stays in the log unreferenced and the error is reported.
//! - **clone** reads the ref, fetches the trees breadth first — one request
//!   per level — and then the blobs in batches, verifying every id. With a
//!   path it fetches only the trees on the way to that directory and the
//!   files under it.
//!
//! [`ServerClient`]: crate::ServerClient

mod clone;
mod commit;
mod import;

pub(crate) use clone::clone;
pub(crate) use commit::commit;
pub(crate) use import::import;

use openscion_core::{FrameWriter, ObjectId};

use crate::{RepoClient, Result};

/// Upload batches are cut at this many bytes of blob data.
const UPLOAD_BATCH_BYTES: usize = 64 << 20;
/// The bytes a frame adds before its body: the id and a `u64` length.
const FRAME_HEADER: usize = ObjectId::LEN + 8;
/// Fetch requests name at most this many objects.
const FETCH_BATCH: usize = 4096;

/// Uploads blobs in batches of at most [`UPLOAD_BATCH_BYTES`].
fn upload(client: &RepoClient, blobs: &[(ObjectId, Vec<u8>)]) -> Result<usize> {
    upload_in_batches(client, blobs, UPLOAD_BATCH_BYTES)
}

/// Uploads blobs, starting a new request whenever the next blob would push
/// the current one past `batch_bytes`. Returns the number of requests sent.
fn upload_in_batches(
    client: &RepoClient,
    blobs: &[(ObjectId, Vec<u8>)],
    batch_bytes: usize,
) -> Result<usize> {
    let mut requests = 0;
    let mut frames = FrameWriter::new();
    for (id, bytes) in blobs {
        let frame = FRAME_HEADER + bytes.len();
        if !frames.is_empty() && frames.len() + frame > batch_bytes {
            requests += 1;
            client.upload_blobs(&std::mem::take(&mut frames).finish())?;
        }
        frames.push(*id, bytes);
    }
    if !frames.is_empty() {
        requests += 1;
        client.upload_blobs(&frames.finish())?;
    }
    Ok(requests)
}

#[cfg(test)]
mod test;
