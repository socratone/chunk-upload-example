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

// DB에는 업로드 완료로 기록되어 있어도 임시 청크 파일이 없을 수 있으므로,
// 실제 파일이 남아 있는 청크만 resume 가능한 청크로 간주한다.
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

  // 같은 파일 정보의 기존 세션이 있으면 새 세션을 만들지 않고 이어서 업로드한다.
  // 현재 예제에서는 filename, filesize, totalChunks 조합으로 같은 파일인지 판단한다.
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

    // 이미 complete가 끝난 세션은 임시 청크 디렉터리가 삭제되므로 resume 대상에서 제외한다.
    const isComplete = sessionChunks.length === totalChunks && sessionChunks.every((chunk) => chunk.uploaded);
    if (isComplete && !fs.existsSync(path.join(TMP_DIR, session.id))) {
      continue;
    }

    // 미완료 세션이면 기존 uploadId와 업로드된 청크 번호를 내려줘서
    // 클라이언트가 남은 청크만 다시 전송할 수 있게 한다.
    fs.mkdirSync(path.join(TMP_DIR, session.id), { recursive: true });
    const uploadedChunks = getUploadedChunkIndexes(session.id);

    res.json({ uploadId: session.id, uploadedChunks, resumed: uploadedChunks.length > 0 });
    return;
  }

  const uploadId = uuidv4();

  // 이어서 업로드할 세션이 없으면 새 uploadId를 발급하고,
  // 전체 청크 수만큼 청크 상태 row를 미리 만들어 둔다.
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

  // chunkIndex는 파일에서 몇 번째 조각인지 나타낸다.
  // 이 번호를 파일명으로 사용해 complete 단계에서 순서대로 다시 합친다.
  const index = parseInt(chunkIndex, 10);
  if (isNaN(index)) {
    res.status(400).json({ error: 'Invalid chunkIndex' });
    return;
  }

  const chunkPath = path.join(TMP_DIR, uploadId, String(index));

  // 청크 요청 body는 express.raw 미들웨어를 거친 Buffer다.
  // 임시 디렉터리에 저장한 뒤 DB 상태를 uploaded=true로 갱신한다.
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

  // complete 요청은 세션 기준으로 모든 청크가 도착했는지 먼저 확인한다.
  // 하나라도 누락되어 있으면 파일을 합치지 않고 클라이언트에 실패를 알린다.
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

  // 청크 파일명은 0부터 시작하는 인덱스이므로, 순서대로 읽어 하나의 파일에 이어 쓴다.
  // 각 pipeline은 writeStream을 닫지 않도록 end:false로 실행한다.
  for (let i = 0; i < session.totalChunks; i++) {
    const chunkPath = path.join(TMP_DIR, uploadId, String(i));
    await pipeline(createReadStream(chunkPath), writeStream, { end: false });
  }
  writeStream.end();

  await new Promise<void>((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });

  // 최종 파일 생성이 끝나면 더 이상 필요 없는 임시 청크 디렉터리를 삭제한다.
  fs.rmSync(path.join(TMP_DIR, uploadId), { recursive: true, force: true });

  res.json({ ok: true, filename: session.filename });
});

export default router;
