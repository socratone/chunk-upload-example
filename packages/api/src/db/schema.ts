import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const uploadSessions = sqliteTable('upload_sessions', {
  id: text('id').primaryKey(),
  filename: text('filename').notNull(),
  filesize: integer('filesize').notNull(),
  totalChunks: integer('total_chunks').notNull(),
  createdAt: text('created_at').default(sql`(CURRENT_TIMESTAMP)`).notNull(),
});

export const uploadChunks = sqliteTable('upload_chunks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  uploadId: text('upload_id')
    .notNull()
    .references(() => uploadSessions.id, { onDelete: 'cascade' }),
  chunkIndex: integer('chunk_index').notNull(),
  uploaded: integer('uploaded', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').default(sql`(CURRENT_TIMESTAMP)`).notNull(),
});
