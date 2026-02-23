# Architectural Analysis: pi-subagents Extension

A deep-dive into the design patterns, architecture, and implementation details of the `pi-subagents` extension — the orchestration layer that enables pi to spawn, manage, and compose sub-agent processes.

---

## 1. File Structure & Modularity

The extension follows a strict **single-responsibility decomposition** across ~40 files. Each file owns one concern and exports only what other modules need. The boundaries are drawn along these axes:

| Axis | Files | Pattern |
|------|-------|---------|
| **Core types** | `types.ts`, `schemas.ts`, `settings.ts` | Shared definitions, no logic dependencies |
| **Agent lifecycle** | `agents.ts`, `agent-scope.ts`, `agent-selection.ts`, `agent-serializer.ts` | Discovery → scope resolution → merge → serialize |
| **Execution** | `execution.ts`, `chain-execution.ts`, `async-execution.ts`, `subagent-runner.ts` | Sync single, sync chain, async (jiti-spawned) |
| **TUI overlay** | `agent-manager*.ts`, `chain-clarify.ts`, `text-editor.ts`, `render-helpers.ts` | State machines + pure render functions |
| **Infrastructure** | `file-coalescer.ts`, `completion-dedupe.ts`, `jsonl-writer.ts`, `artifacts.ts`, `notify.ts` | Reusable utilities with zero domain coupling |

The key structural insight is the **separation of state machines from renderers**. The agent manager root (`agent-manager.ts`) owns state transitions but delegates rendering to sub-modules (`agent-manager-list.ts`, `agent-manager-detail.ts`, etc.). Each sub-module exports two functions — a `renderX()` and a `handleXInput()` — keeping the root component as a thin dispatcher:

```typescript
// agent-manager.ts — root dispatches, doesn't render
render(width: number): string[] {
  switch (this.screen) {
    case "list": return renderList(this.listState, ...);
    case "detail": return renderDetail(this.detailState, ...);
    case "edit": return renderEdit(this.editState, ...);
    // ...12 more cases
  }
}
```

This means you can read any single screen's behavior by opening one file. No screen needs to understand another screen's internals.

**File naming conventions** are rigorous: `agent-manager-*.ts` for overlay sub-screens, `*-execution.ts` for process spawning, `*.test.ts` co-located with source. Chain-specific files use the `chain-` prefix. The only file that breaks the pattern is `index.ts`, which serves as the extension registration entrypoint and necessarily touches everything.

---

## 2. Type System Usage

The type system is wielded as a **design tool**, not just annotation. Several patterns stand out:

### Discriminated unions for state

`ManagerResult` uses action-based discrimination to make illegal states unrepresentable:

```typescript
export type ManagerResult =
  | { action: "launch"; agent: string; task: string; skipClarify?: boolean }
  | { action: "chain"; agents: string[]; task: string; skipClarify?: boolean }
  | { action: "parallel"; tasks: Array<{agent:string;task:string}>; skipClarify?: boolean }
  | { action: "launch-chain"; chain: ChainConfig; task: string; skipClarify?: boolean }
  | undefined;
```

This forces every consumer to handle every mode. You cannot accidentally pass a chain result to a single-agent handler — the `agents: string[]` vs `agent: string` fields are structurally incompatible.

### Type guards as documentation

```typescript
export function isParallelStep(step: ChainStep): step is ParallelStep {
  return "parallel" in step && Array.isArray((step as ParallelStep).parallel);
}
```

This guard does double duty: it narrows the type for the compiler and documents the structural expectation (must have `parallel` as an array). Every callsite that needs to branch on step type uses this guard, ensuring one canonical check.

### TypeBox schemas with pragmatic escape hatches

```typescript
// schemas.ts
const SkillOverride = Type.Any({ description: "..." });
// "Note: Using Type.Any() for Google API compatibility (doesn't support anyOf)"
```

Rather than fighting provider API limitations with complex schema workarounds, the code uses `Type.Any()` with descriptive metadata and documents **why** inline. This is pragmatic — the LLM gets the description, and the code still validates at the TypeScript level. The schema exists for the LLM tool interface, not for runtime validation.

### Null-as-signal pattern

The text editor and input handlers return `null` to mean "not handled, try the next handler":

```typescript
export function handleEditorInput(state, data, textWidth, options?): TextEditorState | null
```

This enables **composable input chains** where multiple handlers try to process input in priority order. The first non-null return wins. This is cleaner than boolean "handled" flags because the caller gets the new state in the same return.

---

## 3. Overlay/UI Patterns

### Agent Manager: 14-screen state machine

The agent manager is a **flat state machine** (no hierarchical states) with 14 screens encoded as a string union:

```typescript
type ManagerScreen = "list" | "detail" | "chain-detail" | "edit" | "edit-field" 
  | "edit-prompt" | "task-input" | "confirm-delete" | "name-input" 
  | "chain-edit" | "template-select" | "parallel-builder";
```

Transitions happen by assigning `this.screen` and initializing the relevant state. The root component holds state for all screens simultaneously — screens don't create/destroy, they just become active/inactive. This avoids lifecycle complexity (no mount/unmount, no cleanup) at the cost of memory for inactive screen state.

### ChainClarifyComponent: nested sub-modes

The chain clarify overlay adds a second dimension of state nesting. Within the "editing a step" state, there are 6 sub-modes:

```typescript
type EditMode = "template" | "output" | "reads" | "model" | "thinking" | "skills";
```

Input routing cascades through these layers:

```typescript
handleInput(data): void {
  if (this.savingChain) { this.handleSaveChainNameInput(data); return; }
  if (this.editingStep !== null) {
    if (this.editMode === "model") { this.handleModelSelectorInput(data); }
    else if (this.editMode === "thinking") { this.handleThinkingSelectorInput(data); }
    else if (this.editMode === "skills") { this.handleSkillSelectorInput(data); }
    else { this.handleEditInput(data); }
    return;
  }
  // navigation mode: e/m/t/w/r/p/s/S/W keys
}
```

The early-return cascade ensures exactly one handler fires per keypress. Each handler is a separate method, keeping them readable despite the combinatorial complexity.

### Sparse overlay map for user edits

Rather than copying the entire resolved behavior array and mutating it, the clarify component stores only what the user changed:

```typescript
private behaviorOverrides: Map<number, BehaviorOverride> = new Map();

private getEffectiveBehavior(stepIndex): ResolvedStepBehavior {
  const base = this.resolvedBehaviors[stepIndex];
  const override = this.behaviorOverrides.get(stepIndex);
  if (!override) return base;
  return { output: override.output !== undefined ? override.output : base.output, ... };
}
```

This means "reset to default" is just `overrides.delete(stepIndex)` — no need to remember original values. It also makes it trivial to detect "has the user changed anything?" (`overrides.size > 0`).

### Dependency propagation

When a user changes an output path in the clarify screen, downstream steps that read that file need updating:

```typescript
private propagateOutputChange(changedStepIndex, oldOutput, newOutput): void
// checks all i > changedStepIndex for reads containing oldOutput, replaces with newOutput
```

This is a simple linear scan (chains are short — rarely >10 steps) that maintains referential integrity without building a dependency graph.

---

## 4. Theme Integration

The extension integrates with pi's theme system through the `th` (theme helper) object. Colors are semantic, not literal:

```typescript
const highlighted = template
  .replace(/\{task\}/g, th.fg("success", "{task}"))
  .replace(/\{previous\}/g, th.fg("warning", "{previous}"))
  .replace(/\{chain_dir\}/g, th.fg("accent", "{chain_dir}"));
```

Template variables get different semantic colors so users can visually parse chain templates at a glance. The chain visualization uses semantic status mapping:

```
✓ scout → ● planner → ○ reviewer
```

Where `✓` uses success color, `●` uses accent/running, `✗` uses error, and `○` uses muted. This means the extension respects any pi theme without hardcoding ANSI codes.

All overlay screens use consistent Unicode box-drawing characters (`╭─╮ │ │ ╰─╯`) via `render-helpers.ts`, giving them a cohesive look:

```typescript
// render-helpers.ts
// pad() uses visibleWidth() from pi-tui (handles ANSI escape codes correctly)
// row() pads content to inner width then wraps in │ borders
```

The `visibleWidth()` dependency is critical — raw `string.length` would break layouts when ANSI escape codes are present.

---

## 5. Error Handling

### Recursive post-execution scanning

After a sub-agent completes, `detectSubagentError()` scans tool results backwards looking for the last error that wasn't followed by a success:

```typescript
// detectSubagentError: scans tool results backwards for last error without subsequent success
//   - checks isError flag, bash exit code regex, fatal pattern list
```

This is necessary because sub-agents might fail a command, then retry successfully. Only "unrecovered" errors matter. The backward scan with success-cancellation handles this elegantly.

### Recursion guard via environment variables

```typescript
export function checkSubagentDepth(): { blocked: boolean; depth: number; maxDepth: number }
export function getSubagentDepthEnv(): Record<string, string>
// PI_SUBAGENT_DEPTH=N+1, PI_SUBAGENT_MAX_DEPTH=2 (default)
```

Each spawned sub-agent increments `PI_SUBAGENT_DEPTH` in its environment. At depth ≥ `PI_SUBAGENT_MAX_DEPTH`, the tool blocks execution. This prevents runaway agent-spawning-agent loops without any inter-process coordination — just env vars propagated through `spawn()`.

### Graceful process termination

```typescript
if (signal) {
  const kill = () => {
    proc.kill("SIGTERM");
    setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 3000);
  };
}
```

SIGTERM first, then a 3-second grace period before SIGKILL. The `!proc.killed` check avoids sending SIGKILL to an already-exited process, preventing potential PID reuse issues.

### Truncation with byte-boundary correctness

```typescript
export function truncateOutput(output, config, artifactPath): TruncationResult {
  // binary search on UTF-8 byte boundaries
}
```

When output exceeds limits, truncation uses binary search to find the right cut point on UTF-8 character boundaries. This prevents mid-character truncation that would produce invalid UTF-8 — a subtle bug that would corrupt downstream processing.

---

## 6. Testing

The test suite uses **Node's built-in test runner** (`node:test` + `node:assert/strict`) with no framework dependencies. Tests are co-located with source files.

### Pure function testing (no mocks)

```typescript
// agent-selection.test.ts: 7 test cases for mergeAgentsForScope precedence
// Inputs are plain objects, outputs are checked directly
```

By keeping core logic in pure functions (input → output, no side effects), the tests avoid mocking entirely. `mergeAgentsForScope()` takes agent configs and returns merged results — no file system, no network, no state.

### Injected dependencies for time-sensitive code

```typescript
// file-coalescer.ts: injected timer API for testability
// defaultTimerApi uses real setTimeout; tests inject fake timers
```

The file coalescer accepts a `timerApi` parameter, letting tests control time deterministically without monkey-patching globals. This is dependency injection at its simplest — a function parameter.

### Test coverage map

| File | What's tested | Pattern |
|------|---------------|---------|
| `agent-selection.test.ts` | Scope merge precedence (7 cases) | Pure function, edge cases |
| `file-coalescer.test.ts` | Debounce timing | Injected timer |
| `completion-dedupe.test.ts` | Key building, TTL expiry | Pure function |
| `single-output.test.ts` | Path resolution, instruction injection | Pure function |
| `recursion-guard.test.ts` | Depth checking | Env var manipulation |
| `agent-scope.test.ts` | Scope resolution | Pure function |
| `pi-spawn.test.ts` | Spawn command resolution | Pure function |
| `jsonl-writer.test.ts` | JSONL write + close | File I/O |

The coverage strategy is **test the logic, not the plumbing**. Execution, rendering, and TUI interactions are not unit-tested — they're exercised through manual testing and the TUI itself.

---

## 7. Configuration/Settings

### ChainStep: the union that enables composition

```typescript
export interface SequentialStep {
  agent: string; task?: string; cwd?: string;
  output?: string | false; reads?: string[] | false;
  progress?: boolean; skill?: string | string[] | false; model?: string;
}
export interface ParallelStep {
  parallel: ParallelTaskItem[]; concurrency?: number; failFast?: boolean;
}
export type ChainStep = SequentialStep | ParallelStep;
```

The `false` literal in `output?: string | false` is a deliberate design choice — it means "explicitly disabled" as distinct from `undefined` (inherit from agent config). This three-valued logic (`explicit value | false | undefined`) flows through `resolveStepBehavior()`:

```typescript
// Priority resolution: step override > agent frontmatter > false
export function resolveStepBehavior(agentConfig, stepOverrides, chainSkills): ResolvedStepBehavior
```

### Template variable system

Chain steps use `{task}`, `{previous}`, and `{chain_dir}` as template variables:

```typescript
export function resolveChainTemplates(steps): ResolvedTemplates
```

`{previous}` is the critical one — it carries the output of the prior step, enabling pipeline composition without explicit file coordination. `{chain_dir}` provides a shared filesystem namespace when file-based handoff is needed (e.g., large outputs that shouldn't go through the prompt).

### Instruction injection

```typescript
export function buildChainInstructions(behavior, chainDir, isFirstProgress, previousSummary): { prefix, suffix }
```

Returns a prefix (file READ/WRITE instructions) and suffix (progress reporting format, previous step summary). These get injected around the user's task template, so the sub-agent knows where to write output and what the previous step produced — without the user specifying this boilerplate.

### Parallel output namespacing

```typescript
// parallel-{stepIndex}/{taskIndex}-{agentName}/{outputFile}
export function resolveParallelBehaviors(tasks, agentConfigs, stepIndex, chainSkills): ResolvedStepBehavior[]
```

Parallel tasks within a chain step get namespaced output directories to prevent collisions. The naming scheme is deterministic (`stepIndex/taskIndex-agentName`), so subsequent steps can reference specific parallel outputs by path.

Parallel results aggregate into a structured string for `{previous}`:

```typescript
export function aggregateParallelOutputs(results): string
// Format: "=== Parallel Task N (agentName) ===\n<output>"
```

---

## 8. Input Handling

### Cascading dispatch with early returns

Every overlay component uses the same input routing pattern — cascading if/else with early returns:

```typescript
handleInput(data): void {
  if (this.savingChain) { this.handleSaveChainNameInput(data); return; }
  if (this.editingStep !== null) {
    if (this.editMode === "model") { this.handleModelSelectorInput(data); return; }
    // ...more sub-modes
    this.handleEditInput(data); return;
  }
  // Default: navigation mode
}
```

This pattern has two virtues: (1) the priority order is visually obvious (top = highest priority), and (2) each handler is isolated — it doesn't need to know about other modes.

### Null-return composition in text editor

```typescript
export function handleEditorInput(state, data, textWidth, options?): TextEditorState | null
```

Returning `null` means "I didn't handle this keypress." The caller can chain handlers:

```typescript
const newState = handleEditorInput(state, data, width)
  ?? handleNavigationInput(state, data)
  ?? handleFallback(state, data);
```

This is essentially a **responsibility chain** without the ceremony of a formal Chain of Responsibility pattern.

### Inline config parsing for slash commands

```typescript
// /run agent[output=file,model=claude,skill=brave] task
// Parsed via parseInlineConfig() + parseAgentToken()
```

The bracket syntax provides a compact way to override agent behavior from the command line, avoiding multi-step forms for power users who know what they want.

### Fuzzy filtering in list screens

```typescript
// fuzzyFilter: consecutive match scoring with bonus for consecutive chars
```

The fuzzy filter uses consecutive character matching with a bonus for adjacent matches, giving results that feel natural (typing "sc" matches "scout" higher than "specialist-core"). This is used in the agent list screen for real-time filtering as the user types.

---

## 9. Async Patterns

### Three execution modes

1. **Sync single** (`execution.ts`): Spawns `pi` CLI as a child process, parses JSONL stdout in real-time, blocks until completion.
2. **Sync chain** (`chain-execution.ts`): Calls sync single in a loop, threading `{previous}` between steps. Parallel steps within a chain use `mapConcurrent()`.
3. **Async** (`async-execution.ts`): Spawns a detached process via jiti, returns immediately with an async ID.

### Jiti-based detached spawning

```typescript
const proc = spawn("node", [jitiCliPath, runner, cfgPath], {
  detached: true, stdio: "ignore"
});
proc.unref(); // Don't keep event loop alive
```

Jiti enables running TypeScript files directly without a build step. The process is fully detached (`detached: true` + `unref()`), so it survives if the parent pi session exits. Configuration is passed via a JSON file on disk to avoid argument length limits.

The jiti discovery is defensive, trying multiple candidate paths:

```typescript
const candidates = [
  () => path.join(require.resolve("jiti/package.json"), ...),
  () => path.join(require.resolve("@mariozechner/jiti/package.json"), ...),
  () => { /* resolve from pi's own package */ }
];
```

This handles different installation scenarios (local, global, bundled) without requiring the user to configure anything.

### Polling + file watching hybrid

Running async jobs are tracked via two mechanisms:

1. **File watcher**: `fs.watch(RESULTS_DIR)` with `FileCoalescer` debouncing detects completion.
2. **Polling**: `setInterval(250ms)` reads `status.json` for progress updates on running jobs.

```typescript
// Widget deduplication — avoids re-render when nothing changed:
let lastWidgetHash = "";
function computeWidgetHash(jobs): string {
  return jobs.slice(0, MAX_WIDGET_JOBS).map(job =>
    `${job.asyncId}:${job.status}:${job.currentStep}:${job.updatedAt}:${job.totalTokens?.total}`
  ).join("|");
}
// But always re-renders if any job is "running" (output tail changes constantly)
```

The hash-based deduplication avoids unnecessary re-renders for completed jobs, while running jobs always re-render (their output tail changes constantly). The poller `unref()`s itself to avoid blocking Node's event loop on exit.

### Progress throttling

```typescript
const scheduleUpdate = () => {
  const elapsed = now - lastUpdateTime;
  if (elapsed >= UPDATE_THROTTLE_MS) { /* fire immediately */ }
  else if (!updatePending) { /* schedule timer for remaining ms */ }
};
```

Progress updates from the JSONL stream are throttled to 50ms intervals. Without this, rapid tool execution would flood the UI. The throttle is "fire immediately if enough time has passed, otherwise schedule one future update" — ensuring both responsiveness and bounded update rate.

### mapConcurrent: lightweight worker pool

```typescript
// mapConcurrent: N-worker pool using shared `next` counter (no queue overhead)
```

Rather than using a proper queue library, parallel execution uses a shared counter that N workers increment atomically. Each worker takes the next item, processes it, and loops. This is ~10 lines of code that handles concurrency limiting for parallel chain steps.

---

## 10. Text Editor Component

The text editor (`text-editor.ts`) is a **pure functional widget** — no classes, no mutation, no side effects:

```typescript
export interface TextEditorState { buffer: string; cursor: number; viewportOffset: number; }
export function handleEditorInput(state, data, textWidth, options?): TextEditorState | null
```

Every operation returns a new `TextEditorState` or `null`. The caller stores the state; the editor never holds it. This makes the editor trivially composable — multiple screens can embed it without lifecycle conflicts.

### Line wrapping with cursor tracking

```typescript
export function wrapText(text, width): { lines: string[]; starts: number[] }
// starts[i] = buffer offset of line i's first character
```

The `starts` array is the key insight — it maps visual line numbers back to buffer character offsets. This enables two-pass cursor positioning:

```typescript
export function getCursorDisplayPos(cursor, starts): { line, col }
```

Given a buffer offset (the canonical cursor position), this finds which visual line it falls on and at what column. The reverse mapping (visual position → buffer offset) is implicit via the `starts` array.

### Viewport management

```typescript
export function ensureCursorVisible(cursorLine, viewportHeight, currentOffset): number
```

The viewport slides to keep the cursor visible, returning the new viewport offset. This is separate from cursor movement — the editor first moves the cursor, then adjusts the viewport. Separating these concerns makes both simpler.

### Paste handling

```typescript
function normalizeInsertText(data, multiLine): string | null
// Strips bracketed paste markers, handles \r\n
```

Terminal paste comes with bracketed paste escape sequences (`\x1b[200~...\x1b[201~`). The editor strips these and normalizes line endings before insertion. The `multiLine` flag controls whether newlines are preserved or stripped (single-line fields vs. prompt editor).

---

## 11. Chain Execution

Chains are the most complex feature. The execution model is:

1. **Template resolution**: Replace `{task}`, `{previous}`, `{chain_dir}` in all step task strings.
2. **Sequential execution**: For each step, resolve behavior (output path, reads, skills), inject instructions (prefix + suffix), spawn the sub-agent, collect output.
3. **Parallel steps**: When a `ParallelStep` is encountered, fan out with `mapConcurrent()`, namespace outputs, aggregate results into a structured `{previous}` string.
4. **Progress tracking**: Each step updates `AgentProgress[]`, which the widget renders as `✓ scout → ● planner → ○ reviewer`.

### The {previous} threading model

The output of step N becomes `{previous}` for step N+1. For sequential steps, this is the raw output string. For parallel steps, outputs are aggregated:

```typescript
"=== Parallel Task 1 (scout) ===\n<output>\n\n=== Parallel Task 2 (reviewer) ===\n<output>"
```

This means downstream steps can parse parallel results by looking for the `===` delimiters, though in practice they're usually consumed by an LLM that handles the structure naturally.

### Chain directory as shared filesystem

`{chain_dir}` gives all steps in a chain a shared directory. Steps can write files there (via `output` config) and subsequent steps can read them (via `reads` config). This handles cases where `{previous}` is too large for a prompt — the step writes to a file, the next step reads from the file.

### Saved chains vs ad-hoc chains

The extension supports two chain modes:

- **Ad-hoc chains**: Built interactively in the Agent Manager's parallel builder or chain composer. Executed directly via `executeChain()`.
- **Saved chains**: Serialized to `.chain.md` files via `chain-serializer.ts`. Loaded on discovery alongside regular agents. Launched through the LLM tool interface.

The clarify screen can convert an ad-hoc chain into a saved chain:

```typescript
private buildChainConfig(name): ChainConfig  // collects templates + overrides
// writes to ~/.pi/agent/agents/{name}.chain.md
```

---

## 12. Novel Patterns

### Environment-variable recursion guard

Using `PI_SUBAGENT_DEPTH` / `PI_SUBAGENT_MAX_DEPTH` env vars is brilliantly simple. No IPC, no shared state, no coordination protocol. Each process reads its depth from the environment, increments it for children, and blocks if over the limit. The env var propagates automatically through `spawn()`.

### Sparse override maps

The `behaviorOverrides: Map<number, BehaviorOverride>` pattern in `chain-clarify.ts` avoids the copy-on-write overhead of cloning large config objects. Only user changes are stored; everything else falls through to the base config. "Reset" is a delete, not a restore.

### Binary search for UTF-8 truncation

Truncating output to a byte limit while respecting UTF-8 boundaries uses binary search — `O(log n)` instead of the naive `O(n)` byte-counting approach. This matters for large outputs (the common case for truncation).

### Null-return handler composition

Returning `null` from input handlers to mean "not handled" enables clean handler chaining without boolean flags or event objects. Multiple handlers compose naturally with `??`.

### Widget hash deduplication with running-job bypass

The hash check prevents unnecessary re-renders for static state, but the `isAnyRunning` bypass ensures running jobs always get fresh output tails. This is a targeted optimization that avoids both waste (re-rendering unchanged content) and staleness (showing outdated progress).

### Global TTL-based dedup store

```typescript
// completion-dedupe.ts
// Global store in globalThis for cross-module sharing
// TTL-based: 10 minute expiry, prunes on each markSeenWithTtl() call
```

Using `globalThis` ensures the dedup store survives module reloads (which happen during development with jiti). The TTL with prune-on-write keeps the store bounded without a background cleanup timer.

### Config-via-JSON-file for subprocess spawning

```typescript
fs.writeFileSync(cfgPath, JSON.stringify(cfg));
// spawn("node", [jitiCliPath, runner, cfgPath], ...)
```

Passing complex configuration through a JSON file instead of CLI arguments avoids shell escaping issues and argument length limits. The file is written atomically before spawn and can be inspected for debugging.

### Injected timer API for testable time

The file coalescer accepts a timer API parameter rather than calling `setTimeout` directly. Tests inject a fake implementation. This is simpler than jest's fake timers or sinon's clock — it's just a function parameter.

---

## Patterns to Adopt

### 1. Separate state machines from renderers

Split each screen into `renderX()` + `handleXInput()` in its own file. Keep the root component as a thin dispatcher. This scales to 14+ screens without the root becoming unreadable.

```typescript
// Root: dispatch only
case "list": return renderList(this.listState, width, theme);
// list.ts: all list logic self-contained
export function renderList(state, width, theme): string[] { ... }
export function handleListInput(state, data): ListAction | null { ... }
```

### 2. Use null-return for composable input handlers

Return `null` to signal "not handled" instead of boolean flags. Compose handlers with `??`:

```typescript
function handleInput(state, data): State {
  return handleEditorInput(state, data)
    ?? handleShortcutInput(state, data)
    ?? state; // fallback: no change
}
```

### 3. Sparse override maps for user customization

When users can override computed defaults, store only their changes in a `Map<key, Partial<Config>>`. Merge on read:

```typescript
private overrides = new Map<number, Partial<StepConfig>>();

getEffective(index: number): StepConfig {
  const base = this.computed[index];
  const patch = this.overrides.get(index);
  return patch ? { ...base, ...patch } : base;
}
```

Reset is `overrides.delete(index)`. Detection of changes is `overrides.size > 0`.

### 4. Environment-variable guards for recursive processes

For any system where process A can spawn process B which can spawn process A:

```typescript
const depth = parseInt(process.env.MY_DEPTH ?? "0");
const max = parseInt(process.env.MY_MAX_DEPTH ?? "3");
if (depth >= max) throw new Error(`Recursion limit (${max})`);
// When spawning child:
env.MY_DEPTH = String(depth + 1);
env.MY_MAX_DEPTH = String(max);
```

Zero coordination overhead. Works across any process boundary.

### 5. Hash-based widget deduplication with bypass for active states

Compute a cheap hash of widget-relevant state. Skip re-render if unchanged. But always re-render if any item is in an active/changing state:

```typescript
const hash = computeHash(items);
const isActive = items.some(i => i.status === "running");
if (hash === lastHash && !isActive) return; // skip
lastHash = hash;
// re-render
```

### 6. Three-valued config: value | false | undefined

Use `false` to mean "explicitly disabled" and `undefined` to mean "inherit default." This three-valued logic enables layered configuration where each layer can actively override, actively disable, or defer:

```typescript
interface StepConfig {
  output?: string | false; // string=custom path, false=disabled, undefined=inherit
}

function resolve(step: StepConfig, agent: AgentConfig): string | false {
  if (step.output !== undefined) return step.output; // explicit override or disable
  return agent.defaultOutput ?? false; // inherit or default-off
}
```

### 7. Dependency injection via function parameters (not frameworks)

For testable time-dependent code, accept the dependency as a parameter:

```typescript
interface TimerApi {
  setTimeout(fn: () => void, ms: number): NodeJS.Timeout;
  clearTimeout(id: NodeJS.Timeout): void;
}

export function createCoalescer(delayMs: number, timer: TimerApi = defaultTimerApi) {
  // uses timer.setTimeout internally
}

// Test:
const calls: Array<{fn, ms}> = [];
const fakeTimer = { setTimeout: (fn, ms) => { calls.push({fn, ms}); return 0 as any; }, ... };
const coalescer = createCoalescer(100, fakeTimer);
```

No mocking library needed. The production code and test code use the same interface.

### 8. JSONL event streaming for subprocess communication

Instead of parsing stdout as text, have sub-processes emit structured JSONL events:

```typescript
// Child writes: {"type":"tool_start","name":"bash","args":{...}}\n
// Parent reads line by line, JSON.parse each:
for await (const line of readline.createInterface({ input: proc.stdout })) {
  const event = JSON.parse(line);
  switch (event.type) {
    case "tool_execution_start": updateProgress(event); break;
    case "message_end": collectResult(event); break;
  }
}
```

This is more robust than regex-parsing text output and supports rich metadata (tokens, timing, errors).

### 9. Throttle-with-guarantee for UI updates

The 50ms throttle pattern ensures both responsiveness and bounded update rate:

```typescript
let lastUpdate = 0;
let pending: NodeJS.Timeout | null = null;

function scheduleUpdate(callback: () => void) {
  const elapsed = Date.now() - lastUpdate;
  if (elapsed >= 50) {
    lastUpdate = Date.now();
    callback();
  } else if (!pending) {
    pending = setTimeout(() => {
      pending = null;
      lastUpdate = Date.now();
      callback();
    }, 50 - elapsed);
  }
  // If pending already exists, skip — the scheduled update will fire
}
```

The first event fires immediately (no latency). Subsequent rapid events coalesce into one scheduled update. At most one timer is active at any time.

### 10. Detached process spawning with config files

For long-running background work that must survive the parent:

```typescript
const configPath = path.join(tmpdir, `run-${id}.json`);
fs.writeFileSync(configPath, JSON.stringify(config));

const proc = spawn("node", [entrypoint, configPath], {
  detached: true,
  stdio: "ignore",
  env: { ...process.env, RUN_ID: id }
});
proc.unref();
```

The JSON config file avoids argument escaping. `detached + unref` ensures the parent can exit. The child reads its own config on startup.

### 11. wrapText with buffer-offset tracking

When implementing a text editor or any line-wrapped display with cursor support, track the buffer offset of each visual line:

```typescript
function wrapText(text: string, width: number): { lines: string[]; starts: number[] } {
  // starts[i] = index into `text` where visual line i begins
}
```

This enables O(1) conversion between buffer positions and visual positions, which is essential for correct cursor movement in wrapped text.

### 12. Propagate changes through dependent state

When one field change can invalidate downstream fields (like output paths affecting reads), do a linear scan and fix:

```typescript
function propagateChange(changedIndex: number, oldVal: string, newVal: string, steps: Step[]) {
  for (let i = changedIndex + 1; i < steps.length; i++) {
    if (steps[i].reads?.includes(oldVal)) {
      steps[i].reads = steps[i].reads.map(r => r === oldVal ? newVal : r);
    }
  }
}
```

For small collections (chains with <20 steps), a simple linear scan beats building and maintaining a dependency graph. The code is readable, correct, and fast enough.
