# 📊 BDA Assessment Portal v2.1 — Setup Guide

## What Changed in v2.1

| Feature | v2.0 | v2.1 |
|---------|------|------|
| Login | Name + USN + Password | **Name + USN only** (no password) |
| Answer key after submit | Shown to student | **Hidden from student** — stored in Excel only |
| CSV download | Available to student | **Removed** — Print Report only |
| Google Drive folder | Optional | **Required via DRIVE_FOLDER_ID** — every result goes to one folder |
| Proctoring | Snapshots + tab detection | **+ face-api.js face/multi-person detection** |
| Submission reason | Not logged | **Logged** (timeout / tab-switch / face violation) |

---

## Project Structure

```
bda-exam/
├── frontend/
│   └── index.html          ← Exam portal UI
├── backend/
│   ├── server.js           ← Express API + Excel builder + Google Drive uploader
│   ├── package.json
│   ├── .env                ← Copy from .env.example and fill in
│   ├── credentials.json    ← Service account key (place here — gitignored)
│   └── results/            ← Local backup of all Excel results (auto-created)
└── README.md
```

---

## ✅ Quick Start (Local — no Google Drive)

```bash
cd backend
npm install
node server.js
```

Open `http://localhost:3000` in Chrome. Results save to `backend/results/` as `.xlsx` files.

---

## ☁️ Google Drive Setup

### Step 1 — Create a Google Cloud Project

1. Go to [https://console.cloud.google.com](https://console.cloud.google.com)
2. Create a project (e.g. `bda-exam-portal`)
3. Enable **Google Drive API**:
   - Navigation → APIs & Services → Library → search "Google Drive API" → **Enable**

### Step 2 — Create a Service Account

1. APIs & Services → Credentials → **Create Credentials → Service Account**
2. Name it e.g. `bda-exam-bot`, click **Create & Continue**
3. Skip optional roles → click **Done**
4. Click the service account → **Keys** tab → **Add Key → JSON**
5. Download the JSON key → save as **`backend/credentials.json`**

> Your service account email looks like:  
> `bda-exam-bot@your-project-id.iam.gserviceaccount.com`

### Step 3 — Create the Google Drive Folder

1. Open [Google Drive](https://drive.google.com)
2. Create a folder named e.g. **"BDA Exam Results 2024"**
3. Right-click the folder → **Share**
4. Paste the service account email → set role to **Editor** → **Send**
5. Copy the **Folder ID** from the Drive URL:
   ```
   https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz
                                           ↑ this is the Folder ID
   ```

### Step 4 — Configure .env

```bash
cd backend
cp .env.example .env
```

Edit `.env`:
```env
DRIVE_FOLDER_ID=paste-your-folder-id-here
PORT=3000
```

For cloud deployment (Render, Railway), set these as environment variables instead:
```
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"..."}   ← entire JSON, one line
DRIVE_FOLDER_ID=1AbCdEfGhIjKlMnOpQrStUvWxYz
```

### Step 5 — Run

```bash
cd backend
node server.js
```

Expected startup output:
```
✅  BDA Exam Server running on http://localhost:3000
    Drive folder : 1AbCdEfGhIjKlMnOpQrStUvWxYz
    Credentials  : credentials.json found
```

---

## 📋 Excel Output Format (Admin Only)

Each submission creates a `.xlsx` with **4 sheets**:

| Sheet | Contents |
|-------|----------|
| **Summary** | Name, USN, score, result, time, warnings, proctoring counts |
| **Answers** | Full Q-by-Q: student's answer, correct answer, status, explanation |
| **Module Breakdown** | Per-module correct/wrong/skipped/score |
| **Proctoring Log** | Timestamped webcam and tab-switch event log |

> ⚠️ **The Answers sheet is NOT shown to the student after submission.**  
> Students only see their summary (name, score, %, pass/fail, time, warnings).

---

## 🔐 Login

| Field | Value |
|-------|-------|
| Full Name | Student's name |
| USN | University Seat Number |
| ~~Password~~ | ~~Removed in v2.1~~ |
| Duration | 75 minutes |
| Questions | 25 MCQs |
| Passing Score | 40% (20/50 marks) |

---

## 📷 Webcam Proctoring Rules

Students are shown these rules before starting:

- **Only one person** must be visible in front of the camera
- Face must remain **clearly visible and centred**
- **Multiple people** in frame → warning → 2nd violation = **auto-submit**
- **Face turned away** (not visible) → warning → 2nd occurrence = **auto-submit**
- Camera must stay active throughout; disabling it is flagged

### How Face Detection Works

The portal uses **[face-api.js](https://github.com/justadudewhohacks/face-api.js)** (v0.22.2), a lightweight browser-side face detection library (~190KB model).

- **Library loaded from**: `https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js`
- **Model loaded from**: `https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/weights` (TinyFaceDetector, ~190KB)
- **Detection interval**: every 5 seconds during exam
- **Detection logic** is isolated in `startExamFaceDetection()` in `index.html` — easy to upgrade later

**Violations tracked:**
| Event | Trigger | Action |
|-------|---------|--------|
| No face detected | `detections.length === 0` | Warn → 2nd time: auto-submit |
| Multiple faces | `detections.length > 1` | Warn → 2nd time: auto-submit |
| Face area drop | Heuristic — face bounding box shrinks >65% | Logged only (not auto-submit) |

> The system does NOT use eye tracking or AI rejection. All decisions are logged for instructor review.

**If face-api.js fails to load** (e.g. offline/CDN blocked), the exam continues with snapshot-only proctoring. The detection module degrades silently.

---

## 🔄 Question & Option Randomization

- Questions are shuffled using **Fisher-Yates + `crypto.getRandomValues()`** (cryptographic random)
- Options within each question are also independently shuffled per session
- Each student gets a statistically unique ordering

---

## 🖨 Student Result Screen

After submission, students see **only**:
- Name, USN
- Score and percentage
- Pass / Fail
- Correct / Wrong / Skipped counts
- Time taken
- Warning count
- Google Drive save status
- **Print Report** button

**No answer key, no correct answers, no explanations are shown in the browser.**

---

## 🌐 Deploy to Production

### Render / Railway
1. Push to GitHub
2. Deploy `backend/` as Node.js service
3. Set env vars: `GOOGLE_SERVICE_ACCOUNT_JSON` (full JSON as one line), `DRIVE_FOLDER_ID`
4. Update `API_BASE` in `frontend/index.html` to your deployed URL
5. Host `frontend/index.html` on Netlify, GitHub Pages, or any static host

### Environment Variables Summary

| Variable | Required | Description |
|----------|----------|-------------|
| `DRIVE_FOLDER_ID` | ✅ Yes | Google Drive folder ID — all results go here |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | One of two | Full service account JSON (for cloud deploy) |
| `credentials.json` | One of two | Service account key file (for local deploy) |
| `PORT` | No | Server port (default: 3000) |

---

## 🛠 Required npm Packages

```json
{
  "express": "^5.x",
  "cors": "^2.x",
  "body-parser": "^2.x",
  "dotenv": "^17.x",
  "googleapis": "^171.x",
  "xlsx": "^0.18.x"
}
```

Install: `cd backend && npm install`

No extra server-side package needed for face detection — it runs entirely in the browser via face-api.js CDN.

---

## ⚙️ Full Feature Summary

| Feature | Status |
|---------|--------|
| Name + USN login (no password) | ✅ |
| Session guard (one-time use) | ✅ |
| 75-min countdown with auto-submit | ✅ |
| 25 randomized MCQs (5 modules) | ✅ |
| Crypto-grade shuffle per session | ✅ |
| Randomized option order | ✅ |
| Tab-switch detection (2 warnings) | ✅ |
| Right-click / copy disabled | ✅ |
| Webcam live feed in header | ✅ |
| Periodic snapshots (every 30s) | ✅ |
| face-api.js face detection | ✅ |
| Multi-person detection → auto-submit | ✅ |
| Face-turned-away detection → auto-submit | ✅ |
| Proctoring log in Excel | ✅ |
| Answer key hidden from student | ✅ |
| CSV download removed | ✅ |
| Print Report available | ✅ |
| Excel upload to fixed Drive folder | ✅ |
| Local backup in results/ | ✅ |
| Drive link shown after submit | ✅ |
