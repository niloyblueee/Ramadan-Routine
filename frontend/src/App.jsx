
import { useRef, useState } from 'react';
import './App.css';

function App() {
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState(null);
  //const [downloadName, setDownloadName] = useState('RamadanSchedule.pdf');
  const [error, setError] = useState(null);
  const fileInput = useRef();

  const handleFileChange = (e) => {
    setFile(e.target.files[0]);
    setDownloadUrl(null);
    setError(null);
  };

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    setError(null);
    setDownloadUrl(null);
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
        //setDownloadName(data.filename || 'RamadanSchedule.pdf');
      } else {
        setError(data.error || 'Upload failed');
      }
    } catch (err) {
      setError('Network error');
    }
    setUploading(false);
  };

  return (
    <div className="routine-container">
      <h1 className="routine-title">RAMADAN ROUTINE</h1>
      <div className="routine-subtitle">Convert Your BRACU Routine Free</div>
      <div className="routine-dropzone" onClick={() => fileInput.current.click()}>
        <input
          type="file"
          accept=".pdf,.jpg,.jpeg,.png,.bmp,.webp"
          style={{ display: 'none' }}
          ref={fileInput}
          onChange={handleFileChange}
        />
        {file ? (
          <span>{file.name}</span>
        ) : (
          <span>Drop your PDF/SS of Bracu Routine Connect Routine</span>
        )}
      </div>
      <div className="routine-actions">
        <button className="routine-btn" onClick={handleUpload} disabled={!file || uploading}>
          {uploading ? 'Uploading...' : 'UpLoad File'}
        </button>
        <div className="routine-divider">/</div>
        <a
          className={`routine-btn${downloadUrl ? '' : ' disabled'}`}
          href={downloadUrl || '#'}
          download
          target="_blank"
          rel="noopener noreferrer"
        >
          Download Routine
        </a>
      </div>
      {error && <div className="routine-error">{error}</div>}
      <footer className="routine-footer">Made with {'<3'} by NiloyBlueee</footer>
    </div>
  );
}

export default App;
