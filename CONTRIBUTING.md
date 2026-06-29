# Contributing

## System-Specific Logic Policy

To keep this module maintainable as more game systems are supported, system branching must stay centralized.

### Rule

- Do not add direct system checks (for example `game.system.id`) outside `scripts/systems/system-adapter.js`.
- Feature files should call adapter capabilities, not inspect the current system.

### Current Adapter Entry Point

- `scripts/systems/system-adapter.js`
- Use `getSystemAdapter()` from this file.

### When You Need System-Specific Behavior

1. Add a capability to the adapter contract (data field or function).
2. Implement default behavior in `generic`.
3. Override only where needed in specific adapters (`dnd5e`, `osric`, etc.).
4. Update feature code to consume the adapter capability.

### Preferred Pattern

- Prefer data-driven adapter configuration over scattered conditional logic.
- Keep feature logic system-agnostic.
- Keep adapter methods narrowly scoped and named by behavior.

### PR Review Checklist

- No new direct `game.system.id` checks outside adapter file.
- System-specific changes are implemented via adapter capability.
- Generic adapter behavior remains sensible fallback.
- New adapter fields/methods are used by feature code without additional system conditionals.
