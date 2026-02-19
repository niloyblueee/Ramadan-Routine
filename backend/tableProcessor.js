// Utility for extracting and adjusting Ramadan routine tables

const fs = require('fs');
const path = require('path');
const { fromPath } = require('pdf2pic');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { OpenAI } = require('openai');
const PDFDocument = require('pdfkit');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── TIME MAPS ───────────────────────────────────────────────────────────────

const CLASS_TIME_MAP = {
  '08:00 AM - 09:20 AM': '08:00 AM - 09:05 AM',
  '09:30 AM - 10:50 AM': '09:15 AM - 10:20 AM',
  '11:00 AM - 12:20 PM': '10:30 AM - 11:35 AM',
  '12:30 PM - 01:50 PM': '11:45 AM - 12:50 PM',
  '02:00 PM - 03:20 PM': '01:00 PM - 02:05 PM',
  '03:30 PM - 04:50 PM': '02:15 PM - 03:20 PM',
  '05:00 PM - 06:20 PM': '03:30 PM - 04:35 PM',
};

const LAB_TIME_MAP = {
  '08:00 AM - 10:50 AM': '08:00 AM - 10:20 AM',
  '11:00 AM - 01:50 PM': '10:30 AM - 12:50 PM',
  '02:00 PM - 04:50 PM': '01:00 PM - 03:20 PM',
  '05:00 PM - 07:50 PM': '03:30 PM - 05:50 PM',
};

function normalizeTime(str) {
  return str.replace(/\s+/g, ' ').trim().toUpperCase().replace(/(\d)(AM|PM)/g, '$1 $2');
}

function adjustTime(timeStr) {
  const norm = normalizeTime(timeStr);
  for (const [k, v] of Object.entries(CLASS_TIME_MAP)) {
    if (normalizeTime(k) === norm) return v;
  }
  for (const [k, v] of Object.entries(LAB_TIME_MAP)) {
    if (normalizeTime(k) === norm) return v;
  }
  return timeStr;
}

// ─── PDF PATH: Render each page to PNG → GPT Vision ─────────────────────────
// The PDF is image-based (scanned), so we render each page to a PNG using
// GhostScript (via pdf2pic) and send the images to GPT vision.

async function extractAndAdjustFromPDF(filePath) {
  const pagesDir = filePath + '_pages';
  fs.mkdirSync(pagesDir, { recursive: true });

  const convert = fromPath(filePath, {
    density: 150,
    saveFilename: 'page',
    savePath: pagesDir,
    format: 'png',
    width: 1600,
    height: 1200,
  });
  convert.setGMClass(true); // use ImageMagick (GhostScript backend)

  // Convert all pages; responseType 'base64' returns inline data
  const results = await convert.bulk(-1, { responseType: 'base64' });

  // Clean up temporary page files
  try { fs.rmSync(pagesDir, { recursive: true, force: true }); } catch (cleanupErr) { console.warn('PDF page cleanup failed:', cleanupErr.message); }

  if (!results || results.length === 0) {
    throw new Error('Could not render PDF to image.');
  }

  const imageContents = results
    .filter(r => r.base64)
    .map(r => ({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${r.base64}`, detail: 'auto' },
    }));

  return await extractAndAdjustWithVision(imageContents);
}

// ─── SHARED: GPT-4o Vision extraction + time adjustment ──────────────────────

const GPT_SYSTEM_PROMPT = `You are a schedule-processing assistant for university Ramadan timetable adjustments.

You will receive an image of a university class schedule table.
The FIRST COLUMN contains time ranges like "HH:MM AM - HH:MM PM".
All other columns contain days, subjects, or class names.
Do NOT modify any column except the first column (time column).

Extract the full table and replace ONLY the first column using these EXACT rules:

REGULAR CLASSES:
08:00 AM - 09:20 AM  →  08:00 AM - 09:05 AM
09:30 AM - 10:50 AM  →  09:15 AM - 10:20 AM
11:00 AM - 12:20 PM  →  10:30 AM - 11:35 AM
12:30 PM - 01:50 PM  →  11:45 AM - 12:50 PM
02:00 PM - 03:20 PM  →  01:00 PM - 02:05 PM
03:30 PM - 04:50 PM  →  02:15 PM - 03:20 PM
05:00 PM - 06:20 PM  →  03:30 PM - 04:35 PM

LAB CLASSES:
08:00 AM - 10:50 AM  →  08:00 AM - 10:20 AM
11:00 AM - 01:50 PM  →  10:30 AM - 12:50 PM
02:00 PM - 04:50 PM  →  01:00 PM - 03:20 PM
05:00 PM - 07:50 PM  →  03:30 PM - 05:50 PM

If a time does not match exactly, leave it unchanged.
Return ONLY a valid JSON array with exact column headers from the table, like:
[{ "Time": "...", "Sunday": "...", "Monday": "..." }, ...]`;

async function extractAndAdjustWithVision(imageContents) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: GPT_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          ...imageContents,
          { type: 'text', text: 'Extract the schedule table and apply the Ramadan time adjustments. Return ONLY the JSON array.' }
        ]
      }
    ],
    max_completion_tokens: 8192
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw || raw.trim() === '') {
    throw new Error(`GPT returned empty content. Finish reason: ${completion.choices[0]?.finish_reason}`);
  }

  let content = raw.trim();
  content = content.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  // Find the JSON array bounds in case extra text is present
  const start = content.indexOf('[');
  const end = content.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Could not locate JSON array in response. Raw content: ${content.slice(0, 300)}`);
  }
  content = content.slice(start, end + 1);

  try {
    return JSON.parse(content);
  } catch (e) {
    throw new Error(`JSON parse failed: ${e.message}. Raw snippet: ${content.slice(0, 300)}`);
  }
}

// ─── IMAGE PATH: Tesseract OCR not needed — send directly to GPT-4o Vision ───

async function extractAndAdjustFromImage(filePath) {
  const imageBuffer = fs.readFileSync(filePath);
  const base64 = imageBuffer.toString('base64');
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;

  return await extractAndAdjustWithVision([{
    type: 'image_url',
    image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'auto' }
  }]);
}

// ─── PDF GENERATION ──────────────────────────────────────────────────────────

function generateSchedulePDF(scheduleData, outputPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    doc.fontSize(14).font('Helvetica-Bold').text('Ramadan Class Schedule', { align: 'center' });
    doc.moveDown(0.5);

    if (!scheduleData || scheduleData.length === 0) {
      doc.fontSize(11).font('Helvetica').text('No schedule data found.');
      doc.end();
      stream.on('finish', resolve);
      stream.on('error', reject);
      return;
    }

    const headers = Object.keys(scheduleData[0]);
    const pageWidth = doc.page.width - 60;
    const timeColWidth = Math.min(155, pageWidth * 0.24);
    const otherColWidth = (pageWidth - timeColWidth) / Math.max(headers.length - 1, 1);
    const colWidths = headers.map((_, i) => (i === 0 ? timeColWidth : otherColWidth));
    const ROW_H = 22;
    const FONT_SIZE = 7.5;

    function drawRow(rowData, y, isHeader) {
      doc.font(isHeader ? 'Helvetica-Bold' : 'Helvetica').fontSize(FONT_SIZE);
      let x = 30;
      headers.forEach((header, i) => {
        const w = colWidths[i];
        if (isHeader) {
          doc.rect(x, y, w, ROW_H).fill('#2c3e50').stroke('#2c3e50');
          doc.fillColor('#ffffff');
        } else {
          const rowIdx = scheduleData.indexOf(rowData);
          doc.rect(x, y, w, ROW_H).fill(rowIdx % 2 === 0 ? '#f0f4f8' : '#ffffff').stroke('#cccccc');
          doc.fillColor('#000000');
        }
        const cellText = isHeader ? header : (rowData[header] || '');
        doc.text(cellText, x + 3, y + 7, { width: w - 6, height: ROW_H - 8, ellipsis: true, lineBreak: false });
        x += w;
      });
    }

    let y = doc.y;
    drawRow(null, y, true);
    y += ROW_H;

    for (const row of scheduleData) {
      if (y + ROW_H > doc.page.height - 40) {
        doc.addPage();
        y = 30;
        drawRow(null, y, true);
        y += ROW_H;
      }
      drawRow(row, y, false);
      y += ROW_H;
    }

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

module.exports = {
  extractAndAdjustFromPDF,
  extractAndAdjustFromImage,
  generateSchedulePDF
};
