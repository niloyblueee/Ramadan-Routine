import { useRef, useState } from 'react';
import './App.css';

function App() {
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState(null);
  const [processingMs, setProcessingMs] = useState(null);
  const [error, setError] = useState(null);
  const fileInput = useRef();

  const handleFileChange = (e) => {
    const picked = e.target.files[0] || null;
    if (picked && picked.type !== 'application/pdf' && !picked.name.toLowerCase().endsWith('.pdf')) {
      setError('Only PDF files are supported.');
      setFile(null);
      setDownloadUrl(null);
      setProcessingMs(null);
      return;
    }

    setFile(picked);
    setDownloadUrl(null);
    setProcessingMs(null);
    setError(null);
  };

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    setError(null);
    setDownloadUrl(null);
    setProcessingMs(null);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch('http://localhost:5000/api/upload', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (res.ok && data.download) {
        setDownloadUrl('http://localhost:5000' + data.download);
        if (typeof data.processingMs === 'number') {
          setProcessingMs(data.processingMs);
        }
      } else {
        setError(data.error || 'Upload failed');
      }
    } catch {
      setError('Network error');
    }
    setUploading(false);
  };

  const resetForm = () => {
    setFile(null);
    setDownloadUrl(null);
    setProcessingMs(null);
    setError(null);
    if (fileInput.current) fileInput.current.value = '';
  };

  return (
    <main className="page">
      <section className="card">
        <p className="badge">PDF ONLY</p>
        <h1 className="title">Ramadan Routine Converter</h1>
        <p className="subtitle">Upload your routine PDF and get a corrected Ramadan schedule PDF in one click.</p>

        <input
          type="file"
          accept=".pdf,application/pdf"
          ref={fileInput}
          onChange={handleFileChange}
          className="hidden-input"
        />

        <button
          type="button"
          className="dropzone"
          onClick={() => fileInput.current?.click()}
        >
          <span className="dropzone-title">{file ? file.name : 'Choose a PDF file'}</span>
          <span className="dropzone-sub">{file ? 'Tap to replace file' : 'No images/screenshots supported'}</span>
        </button>

        <div className="actions">
          <button className="btn btn-primary" onClick={handleUpload} disabled={!file || uploading}>
            {uploading ? 'Processing…' : 'Generate Ramadan PDF'}
          </button>

          <a
            className={`btn btn-ghost${downloadUrl ? '' : ' disabled'}`}
            href={downloadUrl || '#'}
            download
            target="_blank"
            rel="noopener noreferrer"
          >
            Download PDF
          </a>
        </div>

        <div className="meta-row">
          {processingMs != null && <p className="meta">Processed in {(processingMs / 1000).toFixed(1)}s</p>}
          {(file || error || downloadUrl) && (
            <button type="button" className="link-btn" onClick={resetForm}>Reset</button>
          )}
        </div>

        {error && <div className="error">{error}</div>}

        <div className="note">
          Best results: upload the official routine PDF exported from portal.
        </div>
      </section>
      <footer className="footer">Built for BRACU students</footer>
    </main>
  );
}

export default App;
