# Mob Tokens — Backlog

## Near Term

- Add a movement-only party group mode (no pooled HP) to bundle selected PC tokens into one controllable proxy and split back to individuals.
- Extend actor sheet controls beyond Current HP (for example original count and HP per creature) with safe pooled-HP recalculation.
- Add a module setting for count badge location (upper-left, upper-right, or hidden).
- Expand system adapters with explicit HP/AC/morale path coverage and compatibility checks for supported systems.
- Add a confirmation flow for creating multiple groups from the same source actor.

### Movement-Only Party Group (V1)

- V1 scope: create a proxy group token for selected placed tokens, move as one unit, and split back out to original member actors/tokens.
- V1 non-goals: pooled HP, shared AC/effects/resources, morale logic, attack scaling, mixed combat stat aggregation.
- Data model: add `groupMode` (`mob` | `partyProxy`) and `memberTokens` metadata under module flags for party proxies.
- Create flow: add HUD action for selected tokens to "Create Party Group" with confirmation showing selected token count.
- Proxy token behavior: spawn one linked proxy actor/token that stores member references and shows member count in name.
- Split flow: add HUD/context action to "Split Party Group" and recreate individual member tokens near proxy location.
- Ownership/permissions: preserve player ownership by restoring original actor links; GM-only creation/split actions.
- Safety checks: block creation when fewer than 2 valid tokens are selected; block split when member references are missing.
- Conflict handling: if a referenced member actor/token is deleted, split remaining valid members and warn for missing entries.
- UX details: optional checkbox to delete original selected tokens on grouping (default on), matching existing group replacement behavior.
- Test plan: Playwright flow for create-party-group, move proxy token, split-back validation, and missing-member warning path.

## Future Features

- Merge compatible groups.
- Support mixed-creature or leader-plus-followers group compositions.
- Add optional attack scaling and swarm-style damage rules.
- Add encounter-side utilities for converting many placed tokens into grouped actors.
- Add tests or reproducible validation fixtures for supported systems.
