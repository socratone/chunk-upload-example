import { useState, useRef } from 'react';

const CHUNK_SIZE = 1000 * 1024; // 1000 KB
const CONCURRENCY = 5;

type Status = 'idle' | 'uploading' | 'merging' | 'done' | 'error';

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [uploadedChunks, setUploadedChunks] = useState(0);
  const [totalChunks, setTotalChunks] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0] ?? null;
    setFile(selected);
    setStatus('idle');
    setUploadedChunks(0);
    setTotalChunks(0);
    setErrorMsg('');
  }

  async function handleUpload() {
    if (!file) return;

    setStatus('uploading');
    setErrorMsg('');

    const chunks = Math.ceil(file.size / CHUNK_SIZE);
    setTotalChunks(chunks);
    setUploadedChunks(0);

    try {
      const initRes = await fetch('/api/upload/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, filesize: file.size, totalChunks: chunks }),
      });
      if (!initRes.ok) throw new Error('Failed to init upload');
      // init은 새 업로드 세션을 만들거나 기존 미완료 세션을 찾아준다.
      // 기존 세션이면 서버가 이미 업로드된 청크 번호 목록을 함께 내려준다.
      const {
        uploadId,
        uploadedChunks: alreadyUploadedChunks = [],
      }: { uploadId: string; uploadedChunks?: number[] } = await initRes.json();

      // 이미 업로드된 청크는 다시 보내지 않고, 아직 필요한 청크만 워커가 처리한다.
      const uploadedChunkSet = new Set(alreadyUploadedChunks);
      const pendingChunks = Array.from({ length: chunks }, (_, index) => index).filter(
        (index) => !uploadedChunkSet.has(index)
      );
      setUploadedChunks(alreadyUploadedChunks.length);

      // 고정된 개수의 워커 풀을 실행한다. 각 워커는 nextChunk를 공유하면서
      // 다음 청크 번호를 하나씩 가져가므로, 모든 청크가 처리될 때까지
      // 최대 CONCURRENCY개 청크만 동시에 업로드된다.
      let nextChunk = 0;

      async function uploadWorker() {
        while (nextChunk < pendingChunks.length) {
          const index = pendingChunks[nextChunk++];
          const start = index * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, file!.size);
          const blob = file!.slice(start, end);

          const res = await fetch(
            `/api/upload/chunk?uploadId=${encodeURIComponent(uploadId)}&chunkIndex=${index}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/octet-stream' },
              body: blob,
            }
          );
          if (!res.ok) throw new Error(`Chunk ${index} failed`);

          setUploadedChunks((prev) => prev + 1);
        }
      }

      await Promise.all(Array.from({ length: CONCURRENCY }, uploadWorker));

      setStatus('merging');
      const completeRes = await fetch('/api/upload/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId }),
      });
      if (!completeRes.ok) throw new Error('Failed to complete upload');

      setStatus('done');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unknown error');
      setStatus('error');
    }
  }

  const progress = totalChunks > 0 ? Math.round((uploadedChunks / totalChunks) * 100) : 0;

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-8">
      <div className="bg-white rounded-2xl shadow-lg p-8 w-full max-w-md space-y-6">
        <h1 className="text-2xl font-bold text-gray-800">Chunk Upload</h1>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Select a file</label>
          <input
            ref={inputRef}
            type="file"
            onChange={handleFileChange}
            disabled={status === 'uploading' || status === 'merging'}
            className="block w-full text-sm text-gray-500
              file:mr-4 file:py-2 file:px-4
              file:rounded-lg file:border-0
              file:text-sm file:font-semibold
              file:bg-blue-50 file:text-blue-700
              hover:file:bg-blue-100
              disabled:opacity-50 disabled:cursor-not-allowed"
          />
          {file && (
            <p className="mt-1 text-xs text-gray-500">
              {file.name} — {(file.size / 1024 / 1024).toFixed(2)} MB
            </p>
          )}
        </div>

        {file && status === 'idle' && (
          <button
            onClick={handleUpload}
            className="w-full bg-blue-600 text-white font-semibold py-2 px-4 rounded-lg
              hover:bg-blue-700 active:bg-blue-800 transition-colors"
          >
            Upload
          </button>
        )}

        {(status === 'uploading' || status === 'merging' || status === 'done') && (
          <div className="space-y-2">
            <div className="flex justify-between text-sm text-gray-600">
              <span>
                {status === 'uploading'
                  ? `Uploading chunks… ${uploadedChunks} / ${totalChunks}`
                  : status === 'merging'
                  ? 'Merging file on server…'
                  : 'Upload complete!'}
              </span>
              <span>{status === 'done' ? 100 : progress}%</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-3">
              <div
                className="bg-blue-500 h-3 rounded-full transition-all duration-200"
                style={{ width: `${status === 'done' ? 100 : progress}%` }}
              />
            </div>
          </div>
        )}

        {status === 'done' && (
          <p className="text-green-600 font-medium text-sm">
            "{file?.name}" uploaded successfully.
          </p>
        )}
        {status === 'error' && (
          <p className="text-red-600 font-medium text-sm">Error: {errorMsg}</p>
        )}
      </div>
    </div>
  );
}
