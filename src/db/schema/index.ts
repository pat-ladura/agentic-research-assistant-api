import { pgTable, serial, text, timestamp, vector } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

/**
 * Research Sessions table
 * Stores information about research conversations/sessions
 */
export const researchSessions = pgTable('research_sessions', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/**
 * Documents table
 * Stores documents and their embeddings for semantic search
 * Uses pgvector extension for vector similarity search
 */
export const documents = pgTable('documents', {
  id: serial('id').primaryKey(),
  sessionId: serial('session_id').notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  embedding: vector('embedding', { dimensions: 1536 }), // OpenAI embedding dimension
  source: text('source'), // URL, file name, etc.
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * Relations
 * One session has many documents
 */
export const researchSessionsRelations = relations(researchSessions, ({ many }) => ({
  documents: many(documents),
}));

export const documentsRelations = relations(documents, ({ one }) => ({
  session: one(researchSessions, {
    fields: [documents.sessionId],
    references: [researchSessions.id],
  }),
}));
