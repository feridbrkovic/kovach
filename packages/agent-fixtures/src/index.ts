/**
 * Local Kovach agent fixtures.
 *
 * Record a real agent session once as a JSONL fixture, then replay it
 * deterministically in tests with a scripted model.
 */
export {
  EndEvent,
  type Fixture,
  FixtureEvent,
  FixtureHeader,
  FixtureLine,
  FORMAT_VERSION,
  ModelEvent,
  OUTPUT_EXCERPT_MAX,
  RecordedToolCall,
  ToolResultEvent,
  UserEvent,
} from "./format.js";
export { type RedactionKind, redact, redactDeep } from "./redact.js";
export { createRecorder, type Recorder, type RecorderOptions, type ToolResultInput } from "./recorder.js";
export { FixtureError, loadFixture, parseFixture } from "./loader.js";
export {
  createScriptedModel,
  type ModelTurn,
  ScriptDivergenceError,
  ScriptExhaustedError,
  type ScriptedModel,
  type ScriptInput,
} from "./scripted-model.js";
export { toContractSession } from "./contract.js";
