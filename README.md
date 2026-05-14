# Chunk Upload Example

대용량 파일을 여러 청크로 나누어 업로드하고, 서버에서 다시 하나의 파일로 병합하는 예제 프로젝트입니다. React/Vite 기반 웹 클라이언트와 Express 기반 API 서버가 npm workspaces로 구성되어 있습니다.

## 주요 기능

- 파일을 1,000KB 단위 청크로 분할 (테스트 목적으로 작게 설정된 값)
- 최대 5개 청크 동시 업로드
- 업로드 세션과 청크 상태를 SQLite에 저장
- 중단된 업로드를 같은 파일 정보 기준으로 이어서 업로드
- 모든 청크 업로드 완료 후 서버에서 원본 파일로 병합
- Vite 개발 서버에서 `/api` 요청을 API 서버로 프록시

## 기술 스택

- Web: React 19, Vite, TypeScript, Tailwind CSS
- API: Express 5, TypeScript, tsx
- Database: SQLite, better-sqlite3, Drizzle ORM
- Workspace: npm workspaces, concurrently

## 프로젝트 구조

```text
.
├── package.json
├── packages
│   ├── api
│   │   ├── src
│   │   │   ├── db
│   │   │   │   ├── index.ts
│   │   │   │   └── schema.ts
│   │   │   ├── routes
│   │   │   │   └── upload.ts
│   │   │   └── index.ts
│   │   ├── data
│   │   ├── tmp
│   │   └── uploads
│   └── web
│       ├── src
│       │   ├── App.tsx
│       │   ├── index.css
│       │   └── main.tsx
│       └── vite.config.ts
└── package-lock.json
```

## 실행 방법

의존성을 설치합니다.

```bash
npm install
```

SQLite 테이블을 생성하거나 스키마를 반영합니다.

```bash
npm run db:push -w packages/api
```

웹과 API 개발 서버를 함께 실행합니다.

```bash
npm run dev
```

실행 후 브라우저에서 `http://localhost:5173`에 접속합니다. API 서버는 `http://localhost:3001`에서 실행되며, 웹 개발 서버가 `/api` 요청을 API 서버로 프록시합니다.

## 개별 실행

API 서버만 실행:

```bash
npm run dev -w packages/api
```

웹 개발 서버만 실행:

```bash
npm run dev -w packages/web
```

웹 빌드:

```bash
npm run build -w packages/web
```

API 타입스크립트 빌드:

```bash
npm run build -w packages/api
```

## 업로드 흐름

1. 사용자가 웹 화면에서 파일을 선택합니다.
2. 클라이언트가 파일 크기를 기준으로 전체 청크 수를 계산합니다.
3. `POST /api/upload/init` 요청으로 업로드 세션을 생성하거나 기존 세션을 재사용합니다.
4. 기존 세션이 있으면 이미 업로드된 청크를 제외하고, 남은 청크만 `POST /api/upload/chunk`로 전송합니다.
5. 서버가 각 청크 파일을 `packages/api/tmp/{uploadId}`에 저장하고 DB에 업로드 상태를 기록합니다.
6. 모든 청크 전송이 끝나면 `POST /api/upload/complete` 요청을 보냅니다.
7. 서버가 청크를 순서대로 읽어 `packages/api/uploads`에 최종 파일을 생성합니다.
8. 병합이 끝난 임시 청크 디렉터리를 삭제합니다.

## API

### `POST /api/upload/init`

업로드 세션을 생성합니다. 같은 `filename`, `filesize`, `totalChunks`를 가진 미완료 세션이 있으면 기존 세션을 재사용하고 이미 업로드된 청크 번호를 함께 반환합니다.

요청 본문:

```json
{
  "filename": "video.mp4",
  "filesize": 10485760,
  "totalChunks": 11
}
```

응답:

```json
{
  "uploadId": "uuid",
  "uploadedChunks": [0, 1, 2],
  "resumed": true
}
```

### `POST /api/upload/chunk`

청크 바이너리를 업로드합니다.

쿼리 파라미터:

- `uploadId`: `/init`에서 받은 업로드 ID
- `chunkIndex`: 0부터 시작하는 청크 번호

헤더:

```http
Content-Type: application/octet-stream
```

응답:

```json
{
  "ok": true
}
```

### `POST /api/upload/complete`

업로드된 청크를 하나의 파일로 병합합니다.

요청 본문:

```json
{
  "uploadId": "uuid"
}
```

응답:

```json
{
  "ok": true,
  "filename": "video.mp4"
}
```

## 데이터 저장 위치

- SQLite DB: `packages/api/data/uploads.db`
- 임시 청크: `packages/api/tmp/{uploadId}`
- 병합된 파일: `packages/api/uploads/{filename}`

## 참고 사항

- API 서버의 raw body 제한은 청크 업로드 라우트 기준 `2mb`입니다.
- 클라이언트 청크 크기는 `packages/web/src/App.tsx`의 `CHUNK_SIZE`에서 설정합니다.
- 클라이언트 동시 업로드 수는 `packages/web/src/App.tsx`의 `CONCURRENCY`에서 설정합니다.
- 동일한 파일명이 이미 `packages/api/uploads`에 있으면 현재 구현은 같은 경로에 다시 저장합니다.
