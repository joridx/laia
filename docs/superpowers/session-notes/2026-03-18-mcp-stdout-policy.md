# Session notes — MCP stdout policy (Codex discussion)

Date: 2026-03-18

## Context
We implemented MCP stdio server mode (`src/mcp-server.js`, `--mcp` flag). In MCP stdio, **stdout is the JSON-RPC wire**. Any unintended `stdout` output corrupts framing. We already redirected `console.*` to `stderr` in MCP mode.

## Question
Should we add a strict switch that intercepts `process.stdout.write` to prevent non-protocol writes?

## Codex position (gpt-5.3-codex)
Recommendation: **B (hard fail) as default in strict MCP mode**, with **A (redirect) only as an explicit compatibility fallback**.

### A) Redirect non-protocol stdout -> stderr (warn)
Pros:
- More forgiving if dependencies write to stdout.
- Server may continue working.

Cons:
- Risk of misclassification if detection is content-based.
- Can mask bugs and create heisenbugs.

### B) Hard fail on non-protocol stdout
Pros:
- Strong protocol integrity guarantee.
- Deterministic failures with fast diagnosis.

Cons:
- Harsh if dependencies are noisy.

## Key implementation guidance (avoid false positives)
Do **not** parse output content to decide “protocol vs not”. Instead:
- Use an **authorization guard**: only the MCP transport code path may write to stdout.
- Monkeypatch `process.stdout.write`:
  - If call is authorized -> allow
  - Else apply policy (strict: throw/exit; redirect: write to stderr)

Use `AsyncLocalStorage` to make the authorization flag async-safe.

## Proposed CLI
- `--mcp-stdout-policy=strict|redirect` (default: strict)

## Next step
Implement stdout guard in `src/mcp-server.js` + wire CLI parsing in `bin/claudia.js`, then re-run tests and do a quick MCP smoke test.
