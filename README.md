# Agentic Research Assistant API

A TypeScript Express REST API for agentic research assistant with seamless integration of local (Ollama) and cloud (OpenAI) AI providers. Designed with pgvector-enabled PostgreSQL for semantic search capabilities.

## 🚀 Tech Stack

- **Language**: TypeScript (strict mode)
- **Runtime**: Node.js 20
- **Framework**: Express.js
- **Database**: PostgreSQL with pgvector extension
- **ORM**: Drizzle ORM with migrations
- **AI Providers**: Ollama (local) + OpenAI (cloud)
- **Logging**: Pino (structured JSON logging)
- **Rate Limiting**: express-rate-limit
- **Code Formatting**: Prettier
- **Package Manager**: pnpm
- **Containerization**: Docker & Docker Compose

## 📋 Prerequisites

- Node.js 20.x (managed via nvm)
- pnpm 10.x or higher
- Docker & Docker Compose (optional, for local development databases)
- PostgreSQL 16+ (or use the provided Docker Compose)
- OpenAI API key (for cloud AI provider)
- Ollama (for local AI provider, optional)

## 🔧 Setup

### 1. Initial Setup

```bash
# Use Node 20 via nvm (if you have nvm installed)
nvm use

# Clone and navigate to the project
cd agentic-research-assistant-api

# Install dependencies
pnpm install
```

### 2. Environment Configuration

Copy `.env.example` to `.env` and configure your values:

```bash
cp .env.example .env
```

**Environment Variables**:

| Variable          | Required | Description                                         |
| ----------------- | -------- | --------------------------------------------------- |
| `PORT`            | ❌       | Server port (default: 3005)                         |
| `DATABASE_URL`    | ✅       | PostgreSQL connection string                        |
| `API_KEY`         | ✅       | API key for request authentication                  |
| `OPENAI_API_KEY`  | ✅       | OpenAI API key for cloud AI operations              |
| `OLLAMA_BASE_URL` | ❌       | Ollama server URL (default: http://localhost:11434) |
| `NODE_ENV`        | ❌       | Environment: `development` or `production`          |

**Example `.env`**:

```env
PORT=3005
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/agentic_research_db"
API_KEY="your-secure-api-key-here"
OPENAI_API_KEY="sk-your-openai-api-key-here"
OLLAMA_BASE_URL="http://localhost:11434"
NODE_ENV="development"
```

### 3. Database Setup (Docker Compose)

Start PostgreSQL and Ollama with:

```bash
docker compose up -d postgres
```

For Ollama as well (requires separate profile):

```bash
docker compose --profile ollama up -d
```

Then generate and run migrations:

```bash
pnpm db:generate
pnpm db:migrate
```

**Manual PostgreSQL Setup** (without Docker):

```bash
# Create database and enable pgvector extension
createdb agentic_research_db
psql agentic_research_db -c "CREATE EXTENSION IF NOT EXISTS vector;"

# Run migrations
pnpm db:generate
pnpm db:migrate
```

## 📦 Available Scripts

```bash
# Development server with hot reload
pnpm dev

# Build TypeScript to JavaScript
pnpm build

# Start production server
pnpm start

# Database management
pnpm db:generate    # Generate migrations from schema
pnpm db:migrate     # Apply pending migrations
pnpm db:studio      # Open Drizzle Studio GUI for database exploration

# Code quality
pnpm format         # Format code with Prettier
pnpm format:check   # Check formatting without modifying
```

## 🏗️ Project Structure

```
src/
├── index.ts                    # Application entry point
├── app.ts                      # Express app setup & middleware
├── config/
│   ├── env.ts                  # Environment variable validation (Zod)
│   └── database.ts             # Drizzle ORM initialization
├── middleware/
│   ├── auth.ts                 # API key authentication
│   ├── error-handler.ts        # Global error handling
│   ├── rate-limiter.ts         # Express rate limiting
│   └── request-logger.ts       # Pino HTTP request logging
├── lib/
│   └── logger.ts               # Shared Pino logger instance
├── routes/
│   ├── index.ts                # Route aggregator
│   ├── health.routes.ts        # Health check endpoints
│   └── research.routes.ts      # Research/AI endpoints
├── ai/
│   ├── provider.ts             # AI provider interface contract
│   ├── ollama.provider.ts      # Ollama local AI implementation
│   ├── openai.provider.ts      # OpenAI cloud AI implementation
│   └── index.ts                # AI provider factory
├── db/
│   └── schema/
│       └── index.ts            # Drizzle schema definitions
└── types/
    └── index.ts                # Shared TypeScript types

drizzle/                         # Auto-generated migrations (after pnpm db:generate)
dist/                            # Compiled JavaScript (after pnpm build)
```

## 🔌 API Endpoints

### Health Check (No Auth Required)

```bash
GET /health
GET /api/health/status
```

**Response**:

```json
{
  "status": "ok",
  "database": "connected",
  "timestamp": "2026-04-02T10:30:00Z"
}
```

### Research Sessions (Requires API Key)

All research endpoints require `x-api-key` header with your configured API key.

```bash
# Get all research sessions
GET /api/research/sessions
-H "x-api-key: your-api-key"

# Create a new session
POST /api/research/sessions
-H "x-api-key: your-api-key"
-H "Content-Type: application/json"
-d '{ "title": "My Research Session" }'

# Get specific session
GET /api/research/sessions/:id
-H "x-api-key: your-api-key"

# Submit research query
POST /api/research/query
-H "x-api-key: your-api-key"
-H "Content-Type: application/json"
-d '{
  "sessionId": "session-1",
  "query": "What are embeddings in machine learning?"
}'
```

## 🤖 AI Providers

The application supports two AI providers with a unified interface. Switch between them based on your needs.

### Using OpenAI (Cloud)

```typescript
import { getAIProvider } from '@/ai';

const aiProvider = getAIProvider('openai');
const response = await aiProvider.chat([{ role: 'user', content: 'Explain quantum computing' }]);
```

### Using Ollama (Local)

```typescript
import { getAIProvider } from '@/ai';

const aiProvider = getAIProvider('ollama');
const response = await aiProvider.chat([{ role: 'user', content: 'Explain quantum computing' }]);
```

### AI Provider Interface

All providers implement the `AIProvider` interface:

```typescript
interface AIProvider {
  chat(messages: ChatMessage[], systemPrompt?: string): Promise<string>;
  embed(text: string): Promise<number[]>;
  complete(prompt: string, maxTokens?: number): Promise<string>;
}
```

## 🛡️ Authentication & Rate Limiting

### API Key Authentication

All API endpoints (except `/health`) require the `x-api-key` header:

```bash
curl -H "x-api-key: your-api-key" http://localhost:3000/api/research/sessions
```

### Rate Limits

- **General**: 100 requests per 15 minutes per IP
- **AI Endpoints** (`/api/research`): 20 requests per 15 minutes per IP

When rate limit is exceeded, the API returns `429 Too Many Requests` with retry info in headers.

## 📊 Database Schema

### `research_sessions`

```sql
CREATE TABLE research_sessions (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### `documents`

```sql
CREATE TABLE documents (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding vector(1536),  -- pgvector for semantic search
  source TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
```

**Note**: The `embedding` column uses pgvector (1536 dimensions for OpenAI embeddings) for semantic similarity searches.

## 🐳 Docker Deployment

### Development with Docker Compose

```bash
# Start all services
docker compose up -d

# View logs
docker compose logs -f app

# Stop services
docker compose down
```

### Build Docker Image

```bash
docker build -t agentic-research-api:latest .
```

### Run Docker Container

```bash
docker run \
  -e DATABASE_URL="postgresql://postgres:postgres@db:5432/agentic_research_db" \
  -e API_KEY="your-api-key" \
  -e OPENAI_API_KEY="sk-your-key" \
  -p 3005:3005 \
  agentic-research-api:latest
```

## 📝 Logging

The application uses Pino for structured JSON logging.

### Development

In development, logs are pretty-printed with colors:

```
[15:30:45.123] INFO: Server listening on http://localhost:3000
```

### Production

In production, logs are output as JSON for easy parsing:

```json
{
  "level": "info",
  "time": "2026-04-02T15:30:45.123Z",
  "msg": "Server listening on http://localhost:3000"
}
```

### Custom Logging

```typescript
import { logger } from '@/lib/logger';

logger.info('User action', { userId: 123, action: 'query_submitted' });
logger.error(error, 'Failed to process request');
logger.debug({ data }, 'Debug information');
```

## 🧪 Testing

Testing framework setup is optional and can be added when needed:

```bash
pnpm add -D vitest @vitest/ui
```

## 🔐 Security Best Practices

1. **Environment Variables**: Never commit `.env` files; use `.env.example` as a template
2. **API Keys**: Rotate API keys regularly; use strong random values
3. **Helmet**: Enabled by default for security headers
4. **CORS**: Configured for safe cross-origin requests
5. **Rate Limiting**: Prevents abuse of AI endpoints
6. **Input Validation**: Zod schema validation on configuration

## 🚨 Error Handling

All errors are caught globally and returned as JSON:

```json
{
  "error": {
    "status": 400,
    "message": "Bad Request",
    "details": { "field": "error details" }
  }
}
```

## 📚 Useful Commands

```bash
# Explore database with Drizzle Studio
pnpm db:studio

# Format all code
pnpm format

# Check if code matches prettier format
pnpm format:check

# Run TypeScript compiler check
pnpm build

# Interactive development mode
pnpm dev
```

## 🛠️ Troubleshooting

### Database Connection Issues

```bash
# Check PostgreSQL is running
docker compose ps

# View PostgreSQL logs
docker compose logs postgres

# Manually test connection
psql "postgresql://postgres:postgres@localhost:5432/agentic_research_db"
```

### Ollama Connection Issues

```bash
# Ensure Ollama is running
curl http://localhost:11434/api/tags

# Pull a model
curl http://localhost:11434/api/pull -d '{"name": "llama2"}'
```

### Port Already in Use

```bash
# Find and kill process using port 3005
lsof -i :3005
kill -9 <PID>
```

## 📖 Resources

- [Express.js Documentation](https://expressjs.com/)
- [TypeScript Documentation](https://www.typescriptlang.org/)
- [Drizzle ORM Documentation](https://orm.drizzle.team/)
- [Pino Logger Documentation](https://getpino.io/)
- [OpenAI API Documentation](https://platform.openai.com/docs/)
- [Ollama Documentation](https://ollama.com/)
- [pgvector Documentation](https://github.com/pgvector/pgvector)

## 📄 License

ISC

## 🤝 Contributing

Contributions welcome! Please follow the existing code style and test before submitting PRs.
