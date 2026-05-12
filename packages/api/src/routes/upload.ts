import { Router, Request, Response } from 'express';
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { pipeline } from 'stream/promises';
import { createReadStream, createWriteStream } from 'fs';
import { db } from '../db';
import { uploadSessions, uploadChunks } from '../db/schema';

const router = Router();

const TMP_DIR = path.resolve(__dirname, '../../tmp');
const UPLOADS_DIR = path.resolve(__dirname, '../../uploads');

fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function getUploadedChunkIndexes(uploadId: string) {
  return db
    .select()
    .from(uploadChunks)
    .where(eq(uploadChunks.uploadId, uploadId))
    .all()
    .filter((chunk) => chunk.uploaded && fs.existsSync(path.join(TMP_DIR, uploadId, String(chunk.chunkIndex))))
    .map((chunk) => chunk.chunkIndex);
}

router.post('/init', async (req: Request, res: Response) => {
  const { filename, filesize, totalChunks } = req.body as {
    filename: string;
    filesize: number;
    totalChunks: number;
  };

  if (!filename || !filesize || !totalChunks) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }

  const existingSessions = db
    .select()
    .from(uploadSessions)
    .where(
      and(
        eq(uploadSessions.filename, filename),
        eq(uploadSessions.filesize, filesize),
        eq(uploadSessions.totalChunks, totalChunks)
      )
    )
    .all();

  for (const session of existingSessions) {
    const sessionChunks = db
      .select()
      .from(uploadChunks)
      .where(eq(uploadChunks.uploadId, session.id))
      .all();

    const isComplete = sessionChunks.length === totalChunks && sessionChunks.every((chunk) => chunk.uploaded);
    if (isComplete && !fs.existsSync(path.join(TMP_DIR, session.id))) {
      continue;
    }

    fs.mkdirSync(path.join(TMP_DIR, session.id), { recursive: true });
    const uploadedChunks = getUploadedChunkIndexes(session.id);

    res.json({ uploadId: session.id, uploadedChunks, resumed: uploadedChunks.length > 0 });
    return;
  }

  const uploadId = uuidv4();

  db.insert(uploadSessions).values({ id: uploadId, filename, filesize, totalChunks }).run();

  const chunkRows = Array.from({ length: totalChunks }, (_, i) => ({
    uploadId,
    chunkIndex: i,
    uploaded: false,
  }));
  db.insert(uploadChunks).values(chunkRows).run();

  fs.mkdirSync(path.join(TMP_DIR, uploadId), { recursive: true });

  res.json({ uploadId, uploadedChunks: [], resumed: false });
});

router.post('/chunk', async (req: Request, res: Response) => {
  const { uploadId, chunkIndex } = req.query as { uploadId: string; chunkIndex: string };

  if (!uploadId || chunkIndex === undefined) {
    res.status(400).json({ error: 'Missing uploadId or chunkIndex' });
    return;
  }

  const index = parseInt(chunkIndex, 10);
  if (isNaN(index)) {
    res.status(400).json({ error: 'Invalid chunkIndex' });
    return;
  }

  const chunkPath = path.join(TMP_DIR, uploadId, String(index));
  fs.writeFileSync(chunkPath, req.body as Buffer);

  db.update(uploadChunks)
    .set({ uploaded: true })
    .where(and(eq(uploadChunks.uploadId, uploadId), eq(uploadChunks.chunkIndex, index)))
    .run();

  res.json({ ok: true });
});

router.post('/complete', async (req: Request, res: Response) => {
  const { uploadId } = req.body as { uploadId: string };

  if (!uploadId) {
    res.status(400).json({ error: 'Missing uploadId' });
    return;
  }

  const session = db
    .select()
    .from(uploadSessions)
    .where(eq(uploadSessions.id, uploadId))
    .get();

  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const chunks = db
    .select()
    .from(uploadChunks)
    .where(eq(uploadChunks.uploadId, uploadId))
    .all();

  if (!chunks.every((c) => c.uploaded)) {
    res.status(400).json({ error: 'Not all chunks uploaded yet' });
    return;
  }

  const finalPath = path.join(UPLOADS_DIR, session.filename);
  const writeStream = createWriteStream(finalPath);

  for (let i = 0; i < session.totalChunks; i++) {
    const chunkPath = path.join(TMP_DIR, uploadId, String(i));
    await pipeline(createReadStream(chunkPath), writeStream, { end: false });
  }
  writeStream.end();

  await new Promise<void>((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });

  fs.rmSync(path.join(TMP_DIR, uploadId), { recursive: true, force: true });

  res.json({ ok: true, filename: session.filename });
});

export default router;
