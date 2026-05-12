import express from 'express';
import cors from 'cors';
import uploadRouter from './routes/upload';

const app = express();
const PORT = 3001;

app.use(cors());
app.use('/api/upload/chunk', express.raw({ type: 'application/octet-stream', limit: '2mb' }));
app.use(express.json());
app.use('/api/upload', uploadRouter);

app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
});
