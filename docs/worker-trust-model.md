# Worker Trust Model

> How LAIA isolates and constrains worker agents.

## Architecture

Workers are spawned via the `agent` tool (defined in `src/tools/agent.js`). They execute as child LAIA processes (`node bin/laia.js -p "..."`) or in-process via `src/swarm.js`.

```
Main Session (user ↔ LAIA)
  │
  ├─ agent({ prompt, allowedTools, timeout })
  │    │
  │    └─ Worker Process / In-process runner
  │         ├─ Fresh context (no parent history)
  │         ├─ Restricted tool set
  │         └─ Hard timeout
  │
  └─ (result returned as tool_result)
```

## Trust Boundaries

### What workers CAN do
- Use tools from `allowedTools` list (if specified)
- Use ALL tools (if `allowedTools` is not specified)
- Read/write files within workspace
- Execute bash commands (subject to permission system)
- Make API calls via skills/commands

### What workers CANNOT do
- Access parent session history or conversation context
- Modify parent session state (typed memories, session notes)
- Override the permission system (still requires per-tool consent)
- Survive beyond their timeout (hard kill)
- Access other workers' context (no inter-worker communication)
- Disable or bypass safety rules in the system prompt

## Isolation Model

| Property | Guarantee | Mechanism |
|----------|-----------|-----------|
| **Context isolation** | ✅ Full | Fresh context window, no parent history injection |
| **Tool restriction** | ✅ Enforced | `allowedTools` filter in tool dispatch |
| **Timeout** | ✅ Hard | `AbortController` + process-level timeout |
| **Memory isolation** | ⚠️ Partial | Workers share filesystem and brain, but NOT session state |
| **Permission isolation** | ⚠️ Partial | Workers inherit parent permission grants for the session |
| **Process isolation** | ❌ None | Workers run in same Node.js process (in-process mode) |

## Important Non-Guarantees

1. **NOT a security sandbox**: Workers run in the same process with same OS privileges. This is *logical* isolation, not *security* isolation.

2. **Shared filesystem**: A worker can read/write any file the parent can. There is no filesystem sandboxing.

3. **Shared brain**: Workers can call `brain_remember` and `brain_search`. Changes persist globally.

4. **Permission inheritance**: If the parent session granted bash permission, workers get it too.

## Configuration

### allowedTools
```javascript
// Read-only worker (can only inspect, not modify)
agent({
  prompt: "Analyze this codebase",
  allowedTools: ["read", "grep", "glob", "bash"]
});

// Restricted worker (no bash, no writes)
agent({
  prompt: "Review the code",
  allowedTools: ["read", "grep", "glob"]
});

// Unrestricted worker (same permissions as parent)
agent({
  prompt: "Fix the bug",
  // allowedTools omitted = all tools available
});
```

### timeout
- Default: 60,000ms (60 seconds)
- Configurable per-worker via `timeout` parameter
- Hard enforcement via `AbortController`

### context: 'fork' (V3 Phase 3)
Skills with `context: fork` run in a forked copy of the conversation context. After execution, the parent context is restored — the skill's turn history does not persist in the main session.

## Best Practices

1. **Always specify `allowedTools`** for workers that don't need full access
2. **Use read-only workers** for analysis tasks: `["read", "grep", "glob"]`
3. **Set appropriate timeouts** for long-running tasks
4. **Don't rely on workers for state changes** — they can't update parent session
5. **Use `context: 'fork'`** for skills that should not pollute conversation history
