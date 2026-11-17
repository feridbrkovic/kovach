export { loadMigrations, migrate, openDatabase } from "./db.js";
export type { Db, Migration, MigrationResult, OpenOptions } from "./db.js";
export { BlobStore, EXCERPT_MAX_BYTES, utf8Prefix } from "./blobs.js";
export { createHistoryStore, ftsQuery } from "./history.js";
export type {
  HistoryApi,
  HistoryOptions,
  HistoryStore,
  NewToolCall,
  ProjectInfo,
  ResumeContext,
  Role,
  SessionStatus,
  ToolResult,
} from "./history.js";
export {
  type AlwaysOnBlock,
  type ContextItem,
  createMemoryStore,
  estimateTokens,
  type MemoryOptions,
  type MemoryServiceApi,
  type MemoryStore,
  normalizeErrorSignature,
  shortId,
  type TaskBlock,
} from "./memory.js";
export { createOpenAiEmbedder, type Embedder, normalize, type OpenAiEmbedderOptions, withPrefix } from "./embeddings.js";
export { isOutdated, KEY_LIBS, manifestHash, type ProjectCard, renderCard, scanProject } from "./scanner.js";
export { redactSecrets, scanSecrets, type SecretFinding } from "./secrets.js";
export { createJobRunner, type JobContext, type JobHandler, type JobKind, type JobRunner } from "./jobs.js";
export { anchorOf, chunkMarkdown, type DocChunk } from "./docs/chunk.js";
export { createDocsIndex, type DocHit, type DocPackView, type DocsIndex, docHandle } from "./docs/packs.js";
export {
  AUTO_LIBRARIES,
  breakingVersion,
  type BuiltDocs,
  createGitDocsFetcher,
  type DocsFetcher,
  type DocsPlan,
  type DocsSource,
  docsLabel,
  fetchDocs,
  hasGit,
  packVersion,
  parseGithubRepo,
  pickTag,
  planDocs,
  RECIPES,
  selectFiles,
} from "./docs/sources.js";
export { type DocbookPage, docbookToMarkdown, parseEntities } from "./docs/docbook.js";
export { extractItems, findConventions, type SeedItem, seedKey } from "./seed.js";
export {
  cleanLesson,
  createEpisodes,
  type DetectedFix,
  detectFixes,
  type EpisodeStore,
  errorSignatureOf,
  type FixSummary,
  normalizeSignature,
  parseChecksOutput,
  plainSummary,
  type RecordedCall,
  type Summarizer,
  summaryPrompt,
} from "./episodes.js";
export {
  buildTranscript,
  claimSupport,
  EXTRACTED_KINDS,
  EXTRACTION_SCHEMA,
  EXTRACTION_SYSTEM,
  EXTRACTION_TEMPERATURE,
  type ExtractedCandidate,
  type Extractor,
  extractionPrompt,
  gate,
  parseExtraction,
  type Transcript,
} from "./extraction.js";
