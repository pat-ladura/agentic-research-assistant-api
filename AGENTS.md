# Agentic Research Assistant — Implementation Plan

This document is structured for an AI agent to follow phase by phase.
Each phase is self-contained with clear objectives, exact file changes, and validation criteria.
Do NOT proceed to the next phase until the current phase is validated.

---

## Project Context

- **Stack**: TypeScript, Express 5, Drizzle ORM, PostgreSQL (pgvector), Ollama, OpenAI SDK
- **Package manager**: pnpm
- **AI abstraction**: `AIProvider` interface in `src/ai/provider.ts` — all providers must implement `chat()`, `embed()`, `complete()`
- **Factory**: `src/ai/index.ts` — `getAIProvider(providerType)` returns a provider instance
- **DB schema**: `src/db/schema/index.ts` — users, researchSessions, documents (with vector column)
- **Env config**: `src/config/env.ts` — validated via Zod

---

## Phase 1 — Queue Infrastructure (Non-blocking Research Jobs)

### Objective

Make research jobs non-blocking. Client submits a query and immediately gets a `jobId` back.
The actual work runs in a background worker.

### Install

```bash
pnpm add pg-boss
pnpm add -D @types/pg-boss
```

### Files to create

**`src/queue/queue.provider.ts`** — interface only, no pg-boss import

```ts
export interface ResearchJobData {
  sessionId: number;
  query: string;
  provider: 'openai' | 'ollama';
}

export interface QueueProvider {
  enqueue(jobName: string, data: ResearchJobData): Promise<string>;
  onJob(jobName: string, handler: (data: ResearchJobData, jobId: string) => Promise<void>): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

**`src/queue/pgboss.provider.ts`** — pg-boss implementation

```ts
import PgBoss from 'pg-boss';
import type { QueueProvider, ResearchJobData } from './queue.provider';

export class PgBossQueueProvider implements QueueProvider {
  private boss: PgBoss;

  constructor(connectionString: string) {
    this.boss = new PgBoss(connectionString);
  }

  async enqueue(jobName: string, data: ResearchJobData): Promise<string> {
    const id = await this.boss.send(jobName, data);
    return id!;
  }

  onJob(jobName: string, handler: (data: ResearchJobData, jobId: string) => Promise<void>): void {
    this.boss.work(jobName, async (job) => {
      await handler(job.data as ResearchJobData, job.id);
    });
  }

  async start(): Promise<void> {
    await this.boss.start();
  }

  async stop(): Promise<void> {
    await this.boss.stop();
  }
}
```

**`src/queue/index.ts`** — factory (swap provider here when migrating)

```ts
import { PgBossQueueProvider } from './pgboss.provider';
import type { QueueProvider } from './queue.provider';
import { getEnv } from '../config/env';

let cachedQueue: QueueProvider | null = null;

export function getQueueProvider(): QueueProvider {
  if (cachedQueue) return cachedQueue;
  const env = getEnv();
  cachedQueue = new PgBossQueueProvider(env.DATABASE_URL);
  return cachedQueue;
}

export { QueueProvider, ResearchJobData } from './queue.provider';
```

### Files to modify

**`src/index.ts`** — start the queue when the app boots and register a placeholder worker

```ts
// After app.listen():
const queue = getQueueProvider();
await queue.start();
queue.onJob('research-job', async (data, jobId) => {
  logger.info({ jobId, sessionId: data.sessionId }, 'Processing research job (placeholder)');
  // Phase 3 will replace this
});
```

**`src/routes/research.routes.ts`** — update `POST /query` to enqueue and return jobId

```ts
import { getQueueProvider } from '../queue';

router.post('/query', async (req, res, next) => {
  try {
    const { sessionId, query, provider = 'openai' } = req.body;
    if (!sessionId || !query) {
      return res.status(400).json({ error: 'Missing required fields: sessionId, query' });
    }
    const queue = getQueueProvider();
    const jobId = await queue.enqueue('research-job', { sessionId, query, provider });
    res.status(202).json({ jobId, sessionId, status: 'queued' });
  } catch (error) {
    next(error);
  }
});
```

### Validation

- `POST /api/research/query` with `{ sessionId: 1, query: "test", provider: "openai" }` returns HTTP 202 with a `jobId`
- Server logs show `Processing research job (placeholder)` shortly after
- App does not hang waiting for the job to finish

---

## Phase 2 — SSE Progress Streaming

### Objective

Allow clients to subscribe to real-time job progress updates without polling.

### Files to create

**`src/queue/job-events.ts`** — in-process event bus for job progress

```ts
import { EventEmitter } from 'events';

export const jobEmitter = new EventEmitter();
jobEmitter.setMaxListeners(100);

export interface JobProgressEvent {
  jobId: string;
  step: string;
  status: 'started' | 'progress' | 'completed' | 'failed';
  message: string;
  data?: unknown;
}

export function emitJobProgress(event: JobProgressEvent): void {
  jobEmitter.emit(event.jobId, event);
}
```

### Files to modify

**`src/routes/research.routes.ts`** — add two new endpoints

`GET /api/research/jobs/:id/stream` — SSE endpoint

```ts
import { jobEmitter } from '../queue/job-events';

router.get('/jobs/:id/stream', (req, res) => {
  const { id } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const onProgress = (data: unknown) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  jobEmitter.on(id, onProgress);

  req.on('close', () => {
    jobEmitter.off(id, onProgress);
  });
});
```

`GET /api/research/jobs/:id` — polling fallback (query DB for job status in later phases, placeholder for now)

```ts
router.get('/jobs/:id', (req, res) => {
  res.json({ jobId: req.params.id, status: 'processing' });
});
```

### Validation

- Open `GET /api/research/jobs/test-id/stream` in a browser or curl with `--no-buffer`
- Manually call `emitJobProgress({ jobId: 'test-id', step: 'test', status: 'progress', message: 'hello' })` from a test script
- Confirm the event appears in the SSE stream without closing the connection

---

## Phase 3 — Research Agent with Step Memory

### Objective

Implement the actual research logic. The agent runs as a series of steps, each step builds on the previous via accumulated `ChatMessage[]` memory.

### Research steps (in order)

1. **Decompose** — break the query into 3-5 sub-questions (high reasoning)
2. **Search** — generate search queries for each sub-question (high reasoning)
3. **Summarize** — summarize each retrieved source (low reasoning — Phase 4 offloads this to Ollama)
4. **Synthesize** — produce a final research report from all summaries (high reasoning)

### Files to create

**`src/ai/researcher.agent.ts`**

```ts
import { ChatMessage } from './provider';
import { getAIProvider, ProviderType } from './index';
import { emitJobProgress } from '../queue/job-events';

export class ResearcherAgent {
  private memory: ChatMessage[] = [];
  private providerType: ProviderType;
  private jobId: string;

  constructor(jobId: string, providerType: ProviderType) {
    this.jobId = jobId;
    this.providerType = providerType;
  }

  private emit(
    step: string,
    status: 'started' | 'progress' | 'completed' | 'failed',
    message: string,
    data?: unknown
  ) {
    emitJobProgress({ jobId: this.jobId, step, status, message, data });
  }

  private async think(userMessage: string, systemPrompt?: string): Promise<string> {
    this.memory.push({ role: 'user', content: userMessage });
    const provider = getAIProvider(this.providerType);
    const response = await provider.chat(this.memory, systemPrompt);
    this.memory.push({ role: 'assistant', content: response });
    return response;
  }

  async run(query: string): Promise<string> {
    const systemPrompt = `You are an expert research assistant. Be precise, cite reasoning, and structure your output clearly.`;

    // Step 1: Decompose
    this.emit('decompose', 'started', 'Breaking down the research query');
    const subQuestions = await this.think(
      `Break this research query into 3-5 focused sub-questions that together would fully answer it:\n\n"${query}"\n\nReturn only a numbered list.`,
      systemPrompt
    );
    this.emit('decompose', 'completed', 'Sub-questions identified', { subQuestions });

    // Step 2: Search queries
    this.emit('search', 'started', 'Generating search queries');
    const searchQueries = await this.think(
      `For each sub-question above, generate one precise web search query. Return only a numbered list of search queries.`,
      systemPrompt
    );
    this.emit('search', 'completed', 'Search queries generated', { searchQueries });

    // Step 3: Summarize (placeholder — Phase 4 adds source fetching + low-reason offload)
    this.emit('summarize', 'started', 'Summarizing available context');
    const summaries = await this.think(
      `Based on your knowledge of the sub-questions and search queries above, provide a brief factual summary for each sub-question. Mark clearly where external verification is needed.`,
      systemPrompt
    );
    this.emit('summarize', 'completed', 'Summaries complete', { summaries });

    // Step 4: Synthesize
    this.emit('synthesize', 'started', 'Synthesizing final report');
    const report = await this.think(
      `Using all the sub-questions and summaries above, write a comprehensive research report answering the original query:\n\n"${query}"\n\nStructure with: Executive Summary, Key Findings, Details per Sub-question, Conclusion.`,
      systemPrompt
    );
    this.emit('synthesize', 'completed', 'Research complete', { report });

    return report;
  }

  getMemory(): ChatMessage[] {
    return this.memory;
  }
}
```

### Files to modify

**`src/index.ts`** — replace placeholder worker with ResearcherAgent

```ts
queue.onJob('research-job', async (data, jobId) => {
  const agent = new ResearcherAgent(jobId, data.provider);
  try {
    const report = await agent.run(data.query);
    logger.info({ jobId, sessionId: data.sessionId }, 'Research job completed');
    // Phase 5 will persist report and memory to DB
  } catch (error) {
    emitJobProgress({ jobId, step: 'agent', status: 'failed', message: String(error) });
    logger.error({ jobId, error }, 'Research job failed');
  }
});
```

### Validation

- Submit a real query via `POST /api/research/query`
- Open the SSE stream for the returned `jobId`
- Confirm 4 step events arrive in sequence: decompose → search → summarize → synthesize
- Final event contains a `report` in `data`
- Review the accumulated memory steps in logs to confirm context is being passed

---

## Phase 4 — Hybrid Provider (OpenAI + Ollama Routing)

### Objective

When user selects OpenAI, offload low-reasoning tasks (summarization, keyword extraction, relevance checks) to Ollama (llama3) to reduce cost and latency. When user selects Ollama, all tasks go to Ollama.

### Files to modify

**`src/ai/ollama.provider.ts`** — fix model name from `llama2` to `llama3`

```ts
private model: string = 'llama3';
```

### Files to create

**`src/ai/hybrid.provider.ts`**

```ts
import { AIProvider, ChatMessage } from './provider';
import { OpenAIProvider } from './openai.provider';
import { OllamaProvider } from './ollama.provider';
import { logger } from '../lib/logger';

export interface ChatOptions {
  lowReason?: boolean; // true = route to Ollama
}

export class HybridProvider implements AIProvider {
  private primary: OpenAIProvider;
  private secondary: OllamaProvider;
  private ollamaAvailable: boolean = true;

  constructor() {
    this.primary = new OpenAIProvider();
    this.secondary = new OllamaProvider();
  }

  async chat(messages: ChatMessage[], systemPrompt?: string, opts?: ChatOptions): Promise<string> {
    if (opts?.lowReason && this.ollamaAvailable) {
      try {
        return await this.secondary.chat(messages, systemPrompt);
      } catch {
        logger.warn('Ollama unavailable, falling back to OpenAI for low-reason task');
        this.ollamaAvailable = false;
      }
    }
    return this.primary.chat(messages, systemPrompt);
  }

  async embed(text: string): Promise<number[]> {
    return this.primary.embed(text); // Always use OpenAI embeddings in hybrid mode
  }

  async complete(prompt: string, maxTokens?: number): Promise<string> {
    return this.primary.complete(prompt, maxTokens);
  }
}
```

### Files to modify

**`src/ai/index.ts`** — add `HybridProvider` to factory

```ts
import { HybridProvider } from './hybrid.provider';

export type ProviderType = 'ollama' | 'openai' | 'hybrid';

// In switch:
case 'openai':
  provider = new HybridProvider(); // OpenAI as primary, Ollama for low-reason tasks
  break;
case 'ollama':
  provider = new OllamaProvider(); // All tasks go to Ollama
  break;
```

**`src/ai/researcher.agent.ts`** — mark summarize step as low-reason

```ts
// In think(), add optional lowReason param:
private async think(userMessage: string, systemPrompt?: string, lowReason = false): Promise<string> {
  this.memory.push({ role: 'user', content: userMessage });
  const provider = getAIProvider(this.providerType) as HybridProvider;
  const response = await provider.chat(this.memory, systemPrompt, { lowReason });
  this.memory.push({ role: 'assistant', content: response });
  return response;
}

// In run(), the summarize step:
const summaries = await this.think('...summarize prompt...', systemPrompt, true); // lowReason = true
```

### Validation

- With Ollama running locally: submit a query with `provider: "openai"`
- Confirm logs show Ollama handling the summarize step and OpenAI handling decompose/synthesize
- Stop Ollama, resubmit — confirm fallback to OpenAI for all steps without crashing
- Submit with `provider: "ollama"` — confirm all steps use Ollama

---

## Phase 5 — Embedding with Dedicated Models

### Objective

Store embeddings per document for RAG retrieval. Fix embedding model to be separate from chat model. Track embedding model per session so similarity search never mixes dimensions.

### Schema changes needed

**`src/db/schema/index.ts`** — add `embeddingModel` and `embeddingDimensions` to `researchSessions`, and a `stepResults` table for persisting agent memory

```ts
import { integer } from 'drizzle-orm/pg-core'; // add integer import

export const researchSessions = pgTable('research_sessions', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(), // link to authenticated user
  title: text('title').notNull(),
  description: text('description'),
  provider: text('provider').notNull().default('openai'), // 'openai' | 'ollama'
  embeddingModel: text('embedding_model').notNull().default('text-embedding-3-small'),
  embeddingDimensions: integer('embedding_dimensions').notNull().default(1536),
  status: text('status').notNull().default('pending'), // 'pending' | 'running' | 'completed' | 'failed'
  result: text('result'), // final synthesized report
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
```

Note: `vector('embedding', { dimensions: 1536 })` on the documents table is hardcoded by Drizzle.
Use `dimensions: 1536` (max of OpenAI/Ollama) and store actual dimensions in the session.
Ollama nomic-embed-text produces 768d — zero-pad or leave remaining dimensions as 0 is NOT recommended.
**Better approach**: use two separate nullable vector columns or restrict similarity search by session's `embeddingModel`.

**Simplest pragmatic approach for hackathon**: keep `dimensions: 1536` for OpenAI sessions, and for Ollama sessions (`nomic-embed-text`, 768d) store a separate `embeddingSmall: vector('embedding_small', { dimensions: 768 })` column.

### Files to modify

**`src/ai/ollama.provider.ts`** — use dedicated embedding model

```ts
private model: string = 'llama3';
private embeddingModel: string = 'nomic-embed-text'; // separate model for embeddings

async embed(text: string): Promise<number[]> {
  const response = await this.client.embeddings({
    model: this.embeddingModel, // use nomic-embed-text, not llama3
    prompt: text,
  });
  return response.embedding;
}
```

### Run migration

```bash
pnpm db:generate
pnpm db:migrate
```

### Validation

- Schema migration runs without errors
- `researchSessions` table has `embedding_model`, `embedding_dimensions`, `status`, `result` columns
- `documents` table has both vector columns
- `embed()` call on OllamaProvider uses `nomic-embed-text` (confirm in Ollama logs)

---

## Phase 6 — RAG Retrieval in Agent Steps

### Objective

During the synthesize step, retrieve the most semantically relevant document chunks stored in Phase 5, rather than relying purely on chat memory. This prevents token limit issues and improves accuracy.

### Files to create

**`src/ai/retriever.ts`**

```ts
import { getDb } from '../config/database';
import { documents } from '../db/schema';
import { sql, eq } from 'drizzle-orm';
import { AIProvider } from './provider';

export async function retrieveRelevantChunks(
  query: string,
  sessionId: number,
  provider: AIProvider,
  topK: number = 5
): Promise<string[]> {
  const db = getDb();
  const queryEmbedding = await provider.embed(query);
  const embeddingLiteral = `[${queryEmbedding.join(',')}]`;

  // pgvector cosine distance — lower = more similar
  const results = await db
    .select({ content: documents.content })
    .from(documents)
    .where(eq(documents.sessionId, sessionId))
    .orderBy(sql`embedding <=> ${embeddingLiteral}::vector`)
    .limit(topK);

  return results.map((r) => r.content);
}
```

### Files to modify

**`src/ai/researcher.agent.ts`** — inject retrieved chunks before synthesize step

```ts
// In run(), before the synthesize step:
const relevantChunks = await retrieveRelevantChunks(
  query,
  this.sessionId,
  getAIProvider(this.providerType)
);
if (relevantChunks.length > 0) {
  this.memory.push({
    role: 'user',
    content: `Here are relevant excerpts retrieved from research sources:\n\n${relevantChunks.join('\n\n---\n\n')}\n\nUse these in your final synthesis.`,
  });
  this.memory.push({
    role: 'assistant',
    content: 'Understood. I will incorporate these excerpts into the synthesis.',
  });
}
```

### Validation

- Insert test documents with embeddings for a `sessionId`
- Run a research query for that session
- Confirm logs show retrieval step returning chunks before synthesis
- Final report references content from the stored documents

---

## Phase 7 — Gemini Provider (Optional / Future)

### Objective

Add Google Gemini as a third provider option without changing any routes, worker, or agent code.

### Install

```bash
pnpm add @google/genai
```

### Files to modify

**`src/config/env.ts`** — add optional Gemini key

```ts
GEMINI_API_KEY: z.string().optional(),
```

### Files to create

**`src/ai/gemini.provider.ts`**

```ts
import { GoogleGenAI } from '@google/genai';
import { AIProvider, ChatMessage } from './provider';
import { logger } from '../lib/logger';
import { getEnv } from '../config/env';

export class GeminiProvider implements AIProvider {
  private client: GoogleGenAI;
  private model: string = 'gemini-1.5-pro';
  private embeddingModel: string = 'text-embedding-004'; // 768d

  constructor() {
    const env = getEnv();
    if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');
    this.client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  }

  async chat(messages: ChatMessage[], systemPrompt?: string): Promise<string> {
    const geminiMessages = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user', // Gemini uses 'model' not 'assistant'
      parts: [{ text: m.content }],
    }));

    const response = await this.client.models.generateContent({
      model: this.model,
      systemInstruction: systemPrompt,
      contents: geminiMessages,
    });

    const text = response.text;
    if (!text) throw new Error('No content in Gemini response');
    logger.debug({ model: this.model }, 'Gemini chat completed');
    return text;
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.client.models.embedContent({
      model: this.embeddingModel,
      contents: [{ parts: [{ text }] }],
    });
    return response.embeddings?.[0]?.values ?? [];
  }

  async complete(prompt: string, maxTokens: number = 256): Promise<string> {
    return this.chat([{ role: 'user', content: prompt }]);
  }
}
```

### Files to modify

**`src/ai/index.ts`** — add `'gemini'` to ProviderType and factory

```ts
export type ProviderType = 'ollama' | 'openai' | 'gemini';

case 'gemini':
  provider = new GeminiProvider();
  logger.info('Initialized Gemini provider (cloud)');
  break;
```

Note: Gemini embed produces 768d — same constraint as Ollama. Apply the same session-level `embeddingModel` tracking from Phase 5.

### Validation

- Set `GEMINI_API_KEY` in `.env`
- Submit a query with `provider: "gemini"`
- Confirm all 4 research steps complete using Gemini
- Check embedding dimensions are recorded as 768 in the session

---

## Cross-cutting Rules (apply to all phases)

1. **Never import a concrete provider class outside `src/ai/`** — routes and workers always use `getAIProvider()`
2. **Never query embeddings across sessions** — always scope similarity search by `sessionId`
3. **Provider cache in `getAIProvider()` must be reset via `resetAIProvider()` when switching providers per request** — the current cache is global; consider making it per-request if users can switch mid-session
4. **SSE connections must clean up event listeners on `req.close`** — already noted in Phase 2
5. **pg-boss schema tables are managed by pg-boss itself** — do not create them manually via Drizzle
6. **Ollama must be running for `provider: "ollama"` or hybrid offloading** — always handle Ollama errors gracefully with fallback to OpenAI rather than crashing
