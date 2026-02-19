// Express backend for Ramadan Routine

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { extractAndAdjustFromPDF, extractAndAdjustFromImage, generateSchedulePDF } = require('./tableProcessor');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Set up multer for file uploads
const upload = multer({ dest: 'uploads/' });

// Health check
app.get('/', (req, res) => {
  res.send('Ramadan Routine backend running');
});

// File upload endpoint
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const ext = path.extname(req.file.originalname).toLowerCase();
  try {
    let scheduleData;
    if (ext === '.pdf') {
      scheduleData = await extractAndAdjustFromPDF(req.file.path);
    } else if (['.jpg', '.jpeg', '.png', '.bmp', '.webp'].includes(ext)) {
      scheduleData = await extractAndAdjustFromImage(req.file.path);
    } else {
      return res.status(400).json({ error: 'Unsupported file type' });
    }

    // Generate PDF from the adjusted schedule
    const pdfFilename = req.file.filename + '_ramadan.pdf';
    const pdfPath = path.join(__dirname, 'uploads', pdfFilename);
    await generateSchedulePDF(scheduleData, pdfPath);

    res.json({ download: `/api/download/${pdfFilename}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to process file', details: err.message });
  }
});

// Download endpoint
app.get('/api/download/:filename', (req, res) => {
  const file = path.join(__dirname, 'uploads', req.params.filename);
  if (!fs.existsSync(file)) return res.status(404).send('File not found');
  res.download(file, 'RamadanSchedule.pdf');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
