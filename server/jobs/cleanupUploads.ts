// server/jobs/cleanupUploads.js — Delete uploaded files that are no longer
// referenced by any message in the database.
//
// Runs once on startup (after a short delay) and then every 24 hours.
// Only files older than MAX_FILE_AGE_MS are considered for deletion,
// so a newly uploaded file that hasn't been attached to a message yet
// won't be deleted in a race condition.

const fs = require('fs');
const path = require('path');
const { Messages, Dms } = require('../db/repositories');

const UPLOAD_DIR = path.join(__dirname, '../uploads');
const MAX_FILE_AGE_MS  = 60 * 60 * 1000;  // 1 hour — grace period for new uploads
const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

async function runCleanup() {
  if (!fs.existsSync(UPLOAD_DIR)) return;

  let files;
  try {
    files = fs.readdirSync(UPLOAD_DIR);
  } catch (e) {
    console.error('[cleanup] Cannot read uploads dir:', e.message);
    return;
  }

  if (!files.length) return;

  // Collect all fileUrls referenced by channel messages AND DM messages
  const allMessages   = await Messages.findWhere({ type: 'file' });
  const allDmMessages = await Dms.findMessagesWhere({ fileUrl: { $exists: true } });
  const referenced = new Set(
    [...allMessages, ...allDmMessages]
      .map(m => m.fileUrl)
      .filter(Boolean)
      .map(url => path.basename(url))
  );

  const now = Date.now();
  let deleted = 0;

  for (const filename of files) {
    if (referenced.has(filename)) continue;

    const filePath = path.join(UPLOAD_DIR, filename);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs < MAX_FILE_AGE_MS) continue; // too new — skip
      fs.unlinkSync(filePath);
      deleted++;
    } catch {
      // File may have been deleted concurrently — not an error
    }
  }

  if (deleted > 0) {
    console.log(`[cleanup] Deleted ${deleted} orphaned upload(s)`);
  }
}

function startCleanupJob() {
  // Initial run after 5 minutes (let server stabilize first)
  setTimeout(() => {
    runCleanup().catch(e => console.error('[cleanup] Error:', e));
  }, 5 * 60 * 1000);

  // Subsequent runs every 24 hours
  setInterval(() => {
    runCleanup().catch(e => console.error('[cleanup] Error:', e));
  }, CLEANUP_INTERVAL);
}

module.exports = { startCleanupJob, runCleanup };
export {};
