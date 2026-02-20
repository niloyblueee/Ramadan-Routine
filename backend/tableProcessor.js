const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { OpenAI } = require('openai');
const PDFDocument = require('pdfkit');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const GPT_SYSTEM_PROMPT = `You are a schedule-processing assistant for university Ramadan timetable adjustments.

You will receive one or more images of a university class schedule table.
The FIRST COLUMN contains time ranges like "HH:MM AM - HH:MM PM".
All other columns contain days, subjects, sections, teachers, room numbers, and notes.
Do NOT modify semantic meaning of any non-time column.

Preserve complete cell content exactly as visible for non-time columns, including room numbers (e.g., UB40504), section labels, and bracketed notes.
Extract the full table exactly as seen. Do not summarize and do not omit words.

Return ONLY a valid JSON array with original headers as object keys, like:
[{"Time":"08:00 AM - 09:20 AM","Sunday":"CSE110 [Room UB40504]","Monday":"..."}]

No markdown. No explanation. No code fences.`;

const CLASS_TIME_MAP = {
  '08:00 AM - 09:20 AM': '08:00 AM - 09:05 AM',
  '09:30 AM - 10:50 AM': '09:15 AM - 10:20 AM',
  '11:00 AM - 12:20 PM': '10:30 AM - 11:35 AM',
  '12:30 PM - 01:50 PM': '11:45 AM - 12:50 PM',
  '02:00 PM - 03:20 PM': '01:00 PM - 02:05 PM',
  '03:30 PM - 04:50 PM': '02:15 PM - 03:20 PM',
  '05:00 PM - 06:20 PM': '03:30 PM - 04:35 PM'
};

const LAB_TIME_MAP = {
  '08:00 AM - 10:50 AM': '08:00 AM - 10:20 AM',
  '11:00 AM - 01:50 PM': '10:30 AM - 12:50 PM',
  '02:00 PM - 04:50 PM': '01:00 PM - 03:20 PM',
  '05:00 PM - 07:50 PM': '03:30 PM - 05:50 PM'
};

function normalizeTime(str) {
  return String(str || '')
    .replace(/[.]/g, ':')
    .replace(/\s+/g, ' ')
    .replace(/\s*:\s*/g, ':')
    .replace(/\s*[-–—−]\s*/g, ' - ')
    .trim()
    .toUpperCase()
    .replace(/[–—−]/g, '-')
    .replace(/\b0(\d):/g, '$1:')
    .replace(/(\d)(AM|PM)/g, '$1 $2');
}

const NORMALIZED_TIME_MAP = (() => {
  const mapping = {};
  Object.entries(CLASS_TIME_MAP).forEach(([source, target]) => {
    mapping[normalizeTime(source)] = target;
  });
  Object.entries(LAB_TIME_MAP).forEach(([source, target]) => {
    mapping[normalizeTime(source)] = target;
  });
  return mapping;
})();

function adjustTimeValue(value) {
  const text = String(value || '');
  const fullMatch = NORMALIZED_TIME_MAP[normalizeTime(text)];
  if (fullMatch) return fullMatch;

  const rangeRegex = /(\d{1,2}[:.]\d{2}\s*(?:AM|PM)\s*[-–—−]\s*\d{1,2}[:.]\d{2}\s*(?:AM|PM))/gi;
  let changed = false;

  const updated = text.replace(rangeRegex, (matchedRange) => {
    const replacement = NORMALIZED_TIME_MAP[normalizeTime(matchedRange)];
    if (replacement) {
      changed = true;
      return replacement;
    }
    return matchedRange;
  });

  return changed ? updated : text;
}

function looksLikeTimeRange(value) {
  return /\b\d{1,2}[:.]\d{2}\s*(AM|PM)\s*[-–—−]\s*\d{1,2}[:.]\d{2}\s*(AM|PM)\b/i.test(String(value || ''));
}

function cleanModelText(raw) {
  if (!raw || raw.trim() === '') {
    throw new Error('GPT returned empty content.');
  }

  let content = raw.trim();
  content = content.replace(/^```[a-zA-Z]*\s*/i, '').replace(/```\s*$/i, '').trim();
  return content;
}

function parseScheduleJson(rawText) {
  const content = cleanModelText(rawText);
  const start = content.indexOf('[');
  const end = content.lastIndexOf(']');

  if (start === -1 || end === -1 || end < start) {
    throw new Error('Could not locate JSON array in model output.');
  }

  const jsonText = content.slice(start, end + 1);
  const parsed = JSON.parse(jsonText);
  const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.rows) ? parsed.rows : null);
  if (!Array.isArray(rows)) {
    throw new Error('Model output is not a JSON array.');
  }

  return rows;
}

function normalizeScheduleData(scheduleData) {
  if (!Array.isArray(scheduleData) || scheduleData.length === 0) {
    return { headers: ['Schedule'], rows: [['No schedule data found']] };
  }

  const allHeaders = [];
  scheduleData.forEach((row) => {
    Object.keys(row || {}).forEach((key) => {
      if (!allHeaders.includes(key)) allHeaders.push(key);
    });
  });

  const headers = allHeaders.length ? allHeaders : ['Schedule'];
  const rows = scheduleData.map((row) =>
    headers.map((header) => {
      const value = row?.[header];
      return value == null ? '' : String(value);
    })
  );

  return { headers, rows };
}

function applyRamadanAdjustments(scheduleData) {
  if (!Array.isArray(scheduleData) || scheduleData.length === 0) {
    return scheduleData;
  }

  const headers = [];
  scheduleData.forEach((row) => {
    Object.keys(row || {}).forEach((key) => {
      if (!headers.includes(key)) headers.push(key);
    });
  });

  const headerScores = headers.map((header, index) => {
    const matches = scheduleData.filter((row) => looksLikeTimeRange(row?.[header])).length;
    return { header, index, matches };
  });

  let targetHeader = headers.find((header) => /time|slot|period/i.test(header));
  if (!targetHeader) {
    headerScores.sort((a, b) => b.matches - a.matches || a.index - b.index);
    targetHeader = headerScores[0]?.header || headers[0];
  }

  return scheduleData.map((row) => {
    const updated = { ...row };
    const originalTargetValue = updated[targetHeader];
    const adjustedTargetValue = adjustTimeValue(originalTargetValue);
    updated[targetHeader] = adjustedTargetValue;

    if (adjustedTargetValue === String(originalTargetValue || '')) {
      headers.forEach((header) => {
        updated[header] = adjustTimeValue(updated[header]);
      });
    }

    return updated;
  });
}

async function extractScheduleDataWithVision(imageContents) {
  const primaryModel = process.env.OPENAI_VISION_MODEL || 'gpt-4o';
  const fallbackModel = process.env.OPENAI_VISION_FALLBACK_MODEL || 'gpt-4o-mini';
  const imageDetail = process.env.OPENAI_IMAGE_DETAIL || 'auto';

  const runExtraction = async (modelName) => {
    const completion = await openai.chat.completions.create({
      model: modelName,
      messages: [
        { role: 'system', content: GPT_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            ...imageContents.map((item) => ({
              ...item,
              image_url: { ...item.image_url, detail: imageDetail }
            })),
            {
              type: 'text',
              text: 'Extract schedule and return only JSON array with full original cell text.'
            }
          ]
        }
      ],
      max_completion_tokens: 5000
    });

    const raw = completion.choices[0]?.message?.content;
    return parseScheduleJson(raw);
  };

  try {
    return await runExtraction(primaryModel);
  } catch (error) {
    if (!fallbackModel || fallbackModel === primaryModel) throw error;
    return await runExtraction(fallbackModel);
  }
}

async function extractScheduleDataFromPDF(filePath) {
  const renderScale = Number(process.env.PDF_RENDER_SCALE || 1.4);
  const maxPages = Math.max(1, Number(process.env.PDF_MAX_PAGES || 1));
  const dataBuffer = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: dataBuffer });
  const screenshot = await parser.getScreenshot({ scale: renderScale, imageDataUrl: true });

  if (!screenshot.pages || screenshot.pages.length === 0) {
    throw new Error('Could not render PDF to image.');
  }

  const imageContents = screenshot.pages
    .slice(0, maxPages)
    .filter((page) => page.dataUrl)
    .map((page) => ({
      type: 'image_url',
      image_url: { url: page.dataUrl, detail: 'auto' }
    }));

  const extracted = await extractScheduleDataWithVision(imageContents);
  return applyRamadanAdjustments(extracted);
}

async function extractScheduleDataFromImage(filePath) {
  const imageBuffer = fs.readFileSync(filePath);
  const base64 = imageBuffer.toString('base64');
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;

  const extracted = await extractScheduleDataWithVision([
    {
      type: 'image_url',
      image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'auto' }
    }
  ]);

  return applyRamadanAdjustments(extracted);
}

async function generateSchedulePDFFromData(scheduleData, title, outputPath) {
  const { headers, rows } = normalizeScheduleData(scheduleData);

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
    const writer = fs.createWriteStream(outputPath);
    doc.pipe(writer);

    doc.fontSize(14).font('Helvetica-Bold').text(title || 'Ramadan Class Schedule', { align: 'center' });
    doc.moveDown(0.5);

    const safeHeaders = headers.length ? headers : ['Schedule'];
    const safeRows = rows.length ? rows : [['No schedule data found']];

    const pageWidth = doc.page.width - 60;
    const timeColWidth = Math.min(155, pageWidth * 0.24);
    const otherColWidth = (pageWidth - timeColWidth) / Math.max(safeHeaders.length - 1, 1);
    const colWidths = safeHeaders.map((_, idx) => (idx === 0 ? timeColWidth : otherColWidth));
    const HEADER_H = 24;
    const MIN_ROW_H = 28;
    const FONT_SIZE = 8;
    const CELL_TOP_PAD = 5;
    const CELL_SIDE_PAD = 4;

    const getRowHeight = (rowData, isHeader) => {
      if (isHeader) return HEADER_H;

      doc.font('Helvetica').fontSize(FONT_SIZE);
      let maxHeight = MIN_ROW_H;
      safeHeaders.forEach((_, idx) => {
        const width = colWidths[idx] - CELL_SIDE_PAD * 2;
        const cellText = rowData[idx] || '';
        const textHeight = doc.heightOfString(cellText, {
          width,
          align: 'left'
        });
        maxHeight = Math.max(maxHeight, textHeight + CELL_TOP_PAD * 2);
      });
      return maxHeight;
    };

    const drawRow = (rowData, y, isHeader, rowIndex = 0) => {
      const rowHeight = getRowHeight(rowData, isHeader);
      doc.font(isHeader ? 'Helvetica-Bold' : 'Helvetica').fontSize(FONT_SIZE);
      let x = 30;

      safeHeaders.forEach((header, idx) => {
        const width = colWidths[idx];
        if (isHeader) {
          doc.rect(x, y, width, rowHeight).fill('#2c3e50').stroke('#2c3e50');
          doc.fillColor('#ffffff');
        } else {
          doc.rect(x, y, width, rowHeight).fill(rowIndex % 2 === 0 ? '#f0f4f8' : '#ffffff').stroke('#cccccc');
          doc.fillColor('#000000');
        }

        const cellText = isHeader ? header : (rowData[idx] || '');
        doc.text(cellText, x + CELL_SIDE_PAD, y + CELL_TOP_PAD, {
          width: width - CELL_SIDE_PAD * 2,
          height: rowHeight - CELL_TOP_PAD * 2,
          ellipsis: false,
          lineBreak: true,
          align: 'left'
        });

        x += width;
      });

      return rowHeight;
    };

    let y = doc.y;
    const headerHeight = drawRow([], y, true);
    y += headerHeight;

    safeRows.forEach((row, rowIndex) => {
      const rowHeight = getRowHeight(row, false);
      if (y + rowHeight > doc.page.height - 40) {
        doc.addPage();
        y = 30;
        const repeatedHeaderHeight = drawRow([], y, true);
        y += repeatedHeaderHeight;
      }
      const usedHeight = drawRow(row, y, false, rowIndex);
      y += usedHeight;
    });

    doc.end();
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  return outputPath;
}

module.exports = {
  extractScheduleDataFromPDF,
  extractScheduleDataFromImage,
  generateSchedulePDFFromData
};
