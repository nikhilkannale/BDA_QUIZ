require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const XLSX       = require('xlsx');
const path       = require('path');
const fs         = require('fs');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../frontend')));

// ─────────────────────────────────────────────
//  Google Drive Auth — Service Account
//  Priority order:
//    1. GOOGLE_SERVICE_ACCOUNT_JSON env var (full JSON as one line)
//    2. credentials.json file in /backend folder
// ─────────────────────────────────────────────
function getAuthClient() {
  let credentials;

  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } catch (e) {
      console.error('[Auth] Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON:', e.message);
      return null;
    }
  } else {
    const credPath = path.join(__dirname, 'credentials.json');
    if (fs.existsSync(credPath)) {
      try {
        credentials = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      } catch (e) {
        console.error('[Auth] Failed to read credentials.json:', e.message);
        return null;
      }
    }
  }

  if (!credentials) return null;

  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
}

// ─────────────────────────────────────────────
//  Build Excel workbook
//  Sheets:
//    1. Summary    — visible-level summary (safe to share)
//    2. Answers    — full Q-by-Q answer key (admin only)
//    3. Module Breakdown — per-module stats
//    4. Proctoring Log   — webcam/tab events
// ─────────────────────────────────────────────
function buildExcel(payload) {
  const wb = XLSX.utils.book_new();

  // ── Sheet 1: Summary ──
  const summaryData = [
    ['BDA Assessment Report'],
    [],
    ['Student Name',   payload.name],
    ['USN',            payload.usn],
    ['Email',          payload.email || ''],
    ['Score',          `${payload.score} / ${payload.maxScore}`],
    ['Percentage',     `${payload.percentage}%`],
    ['Result',         payload.passed ? 'PASS' : 'FAIL'],
    ['Correct',        payload.correct],
    ['Wrong',          payload.wrong],
    ['Skipped',        payload.skipped],
    ['Time Taken',     payload.timeTaken],
    ['Tab Warnings',   payload.warnings],
    ['Auto-Submitted', payload.autoSubmit ? `Yes — ${payload.autoReason || ''}` : 'No'],
    ['Camera Used',    payload.cameraUsed ? 'Yes' : 'No (denied)'],
    ['Face Away Count',       payload.faceAwayCount        || 0],
    ['Multi-Face Warnings',   payload.multipleFaceWarnings || 0],
    ['Snapshot Count',        payload.snapshotCount        || 0],
    ['Submitted At',   payload.submittedAt],
  ];
  const ws1 = XLSX.utils.aoa_to_sheet(summaryData);
  ws1['!cols'] = [{ wch: 24 }, { wch: 44 }];
  XLSX.utils.book_append_sheet(wb, ws1, 'Summary');

  // ── Sheet 2: Detailed Answers (admin only — not shown to student) ──
  const headers = ['#', 'Module', 'Question', 'Student Answer', 'Correct Answer', 'Status', 'Explanation'];
  const rows = (payload.answers || []).map((a, i) => [
    i + 1,
    a.module,
    a.question,
    a.yourAnswer,
    a.correctAnswer,
    a.status,
    a.explanation,
  ]);
  const ws2 = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws2['!cols'] = [
    { wch: 4 }, { wch: 24 }, { wch: 72 },
    { wch: 16 }, { wch: 16 }, { wch: 10 }, { wch: 62 }
  ];
  XLSX.utils.book_append_sheet(wb, ws2, 'Answers');

  // ── Sheet 3: Module Breakdown ──
  const modMap = {};
  (payload.answers || []).forEach(a => {
    if (!modMap[a.module]) modMap[a.module] = { total:0, correct:0, wrong:0, skipped:0 };
    modMap[a.module].total++;
    if      (a.status === 'Correct') modMap[a.module].correct++;
    else if (a.status === 'Wrong')   modMap[a.module].wrong++;
    else                             modMap[a.module].skipped++;
  });
  const modHeaders = ['Module', 'Total Qs', 'Correct', 'Wrong', 'Skipped', 'Score'];
  const modRows = Object.entries(modMap).map(([mod, d]) => [
    mod, d.total, d.correct, d.wrong, d.skipped, `${d.correct * 2}/${d.total * 2}`
  ]);
  const ws3 = XLSX.utils.aoa_to_sheet([modHeaders, ...modRows]);
  ws3['!cols'] = [{ wch: 28 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, ws3, 'Module Breakdown');

  // ── Sheet 4: Proctoring Log ──
  const logHeaders = ['Timestamp', 'Event', 'Details'];
  const logRows = (payload.proctoringLog || []).map(entry => [
    entry.time || '',
    entry.event || '',
    JSON.stringify(Object.fromEntries(Object.entries(entry).filter(([k])=>k!=='time'&&k!=='event')))
  ]);
  const ws4 = XLSX.utils.aoa_to_sheet([logHeaders, ...logRows]);
  ws4['!cols'] = [{ wch: 28 }, { wch: 24 }, { wch: 50 }];
  XLSX.utils.book_append_sheet(wb, ws4, 'Proctoring Log');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ─────────────────────────────────────────────
//  Upload buffer to a specific Google Drive folder
//  DRIVE_FOLDER_ID env var controls the destination.
//  If not set, will upload to root (Drive root — not ideal).
// ─────────────────────────────────────────────
async function uploadToDrive(buffer, filename, auth) {
  const drive = google.drive({ version: 'v3', auth });

  const FOLDER_ID = process.env.DRIVE_FOLDER_ID ? process.env.DRIVE_FOLDER_ID.trim() : null;

  const mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const meta = { name: filename, mimeType };

  if (FOLDER_ID) {
    meta.parents = [FOLDER_ID];
    console.log(`[Drive] Uploading "${filename}" to folder: ${FOLDER_ID}`);
  } else {
    // Still upload — but to Drive root. Log a warning.
    console.warn('[Drive] DRIVE_FOLDER_ID not set — uploading to Drive root. Set DRIVE_FOLDER_ID for organized storage.');
  }

  const { Readable } = require('stream');
  const stream = Readable.from(buffer);

  const res = await drive.files.create({
    requestBody: meta,
    media: { mimeType, body: stream },
    fields: 'id, webViewLink, name',
  });

  console.log(`[Drive] Uploaded: ${res.data.name} → ${res.data.webViewLink}`);
  return res.data;
}

// ─────────────────────────────────────────────
//  submissions.json helpers
// ─────────────────────────────────────────────
const SUBMISSIONS_FILE = path.join(__dirname, 'submissions.json');

function loadSubmissions() {
  try {
    if (fs.existsSync(SUBMISSIONS_FILE)) {
      const raw = fs.readFileSync(SUBMISSIONS_FILE, 'utf8').trim();
      return raw ? JSON.parse(raw) : [];
    }
  } catch (e) {
    console.error('[Submissions] Load error:', e.message);
  }
  return [];
}

function saveSubmission(usn, email, name) {
  const list = loadSubmissions();
  const now = new Date().toISOString();
  list.push({
    usn:         usn.toUpperCase(),
    email:       email.toLowerCase(),
    name,
    timestamp:   now,   // ISO timestamp (primary field per spec)
    submittedAt: now,   // kept for backward compat with existing records
  });
  try {
    fs.writeFileSync(SUBMISSIONS_FILE, JSON.stringify(list, null, 2));
  } catch (e) {
    console.error('[Submissions] Save error:', e.message);
  }
}

function alreadySubmitted(usn, email) {
  const list = loadSubmissions();
  const usnUp = (usn || '').toUpperCase();
  const emailLo = (email || '').toLowerCase();
  return list.some(s =>
    s.usn === usnUp || s.email === emailLo
  );
}

// ─────────────────────────────────────────────
//  API: POST /api/submit
// ─────────────────────────────────────────────
app.post('/api/submit', async (req, res) => {
  const payload = req.body;

  if (!payload || !payload.name || !payload.usn) {
    return res.status(400).json({ ok: false, error: 'Invalid payload — name and USN required.' });
  }

  // ── Duplicate submission check ──
  if (alreadySubmitted(payload.usn, payload.email)) {
    console.warn(`[Submit] Duplicate submission blocked: USN=${payload.usn} Email=${payload.email}`);
    return res.status(409).json({
      ok: false,
      error: 'Already submitted',
      message: 'Duplicate submission detected. You can attempt this exam only once. Your previous submission is already on record.'
    });
  }

  const filename = [
    'BDA_Result',
    payload.name.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, ''),
    payload.usn.replace(/[^a-zA-Z0-9]/g, '_'),
    Date.now(),
  ].join('_') + '.xlsx';

  let buffer;
  try {
    buffer = buildExcel(payload);
  } catch (buildErr) {
    console.error('[Excel] Build failed:', buildErr.message);
    return res.status(500).json({ ok: false, error: 'Excel build failed: ' + buildErr.message });
  }

  // ── Always save locally as backup ──
  let localSaved = false;
  try {
    const localDir = path.join(__dirname, 'results');
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(localDir, filename), buffer);
    localSaved = true;
    console.log(`[Local] Saved: results/${filename}`);
    // Record this submission to prevent duplicates
    saveSubmission(payload.usn, payload.email || '', payload.name);
  } catch (localErr) {
    console.error('[Local] Save failed:', localErr.message);
  }

  // ── Try Google Drive upload ──
  let driveSaved   = false;
  let driveLink    = null;
  let driveMessage = '';

  const auth = getAuthClient();

  if (!auth) {
    driveMessage = 'Google Drive credentials not configured. Place credentials.json in /backend or set GOOGLE_SERVICE_ACCOUNT_JSON env var.';
    console.warn('[Drive] ' + driveMessage);
  } else if (!process.env.DRIVE_FOLDER_ID) {
    driveMessage = 'DRIVE_FOLDER_ID is not set in .env. Result saved locally only. Set DRIVE_FOLDER_ID to enable folder-specific upload.';
    console.warn('[Drive] ' + driveMessage);
    // Attempt upload to root anyway so data isn't lost
    try {
      const driveResult = await uploadToDrive(buffer, filename, auth);
      driveSaved  = true;
      driveLink   = driveResult.webViewLink || null;
      driveMessage = 'Uploaded to Drive root (DRIVE_FOLDER_ID not configured — set it for organized storage).';
    } catch (driveErr) {
      console.error('[Drive] Upload to root failed:', driveErr.message);
      driveMessage += ` Upload error: ${driveErr.message}`;
    }
  } else {
    // FOLDER_ID present — upload to the configured folder
    try {
      const driveResult = await uploadToDrive(buffer, filename, auth);
      driveSaved  = true;
      driveLink   = driveResult.webViewLink || null;
      driveMessage = `Result saved to Google Drive folder (ID: ${process.env.DRIVE_FOLDER_ID}).`;
    } catch (driveErr) {
      console.error('[Drive] Upload failed:', driveErr.message);
      driveMessage = `Drive upload failed: ${driveErr.message}. Check folder sharing with service account.`;
    }
  }

  return res.json({
    ok: true,
    filename,
    localSaved,
    driveSaved,
    driveLink,
    message: driveMessage,
  });
});

// ─────────────────────────────────────────────
//  API: GET /api/check  — called at LOGIN TIME
//  Verifies USN + Email against submissions.json
//  BEFORE the exam starts. This is the backend
//  gate that cannot be bypassed by clearing
//  browser localStorage.
// ─────────────────────────────────────────────
app.get('/api/check', (req, res) => {
  const usn   = (req.query.usn   || '').trim().toUpperCase();
  const email = (req.query.email || '').trim().toLowerCase();

  if (!usn && !email) {
    return res.status(400).json({ ok: false, error: 'USN or Email required.' });
  }

  if (alreadySubmitted(usn, email)) {
    console.log(`[Check] Blocked login — already submitted: USN=${usn} Email=${email}`);
    return res.json({
      ok:           false,
      alreadyTaken: true,
      message:      'You have already submitted this exam. Duplicate attempts are not allowed.',
    });
  }

  return res.json({ ok: true, alreadyTaken: false });
});

// ─────────────────────────────────────────────
//  API: GET /api/health
// ─────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    ok:   true,
    time: new Date().toISOString(),
    drive: {
      credentialsPresent: !!getAuthClient(),
      folderConfigured:   !!process.env.DRIVE_FOLDER_ID,
      folderId:           process.env.DRIVE_FOLDER_ID || null,
    },
  });
});

// ─────────────────────────────────────────────
//  Start server
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅  BDA Exam Server running on http://localhost:${PORT}`);
  console.log(`    Drive folder : ${process.env.DRIVE_FOLDER_ID || '⚠ Not configured (set DRIVE_FOLDER_ID)'}`);
  console.log(`    Credentials  : ${fs.existsSync(path.join(__dirname,'credentials.json')) ? 'credentials.json found' : process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? 'env var set' : '⚠ Not found'}`);
  console.log('');
});
