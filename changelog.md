# Mob Tokens — Changelog

## Unreleased

- Added system adapter scaffolding (`generic`, `dnd5e`, `osric`) to centralize system-specific behavior.
- Added optional Morale and Armor Class fields to group creation dialogs when those fields are available on the source actor.
- Added adapter-driven stat path resolution for creation-time Morale/AC overrides.

## 0.5.0

- Added group sheet Current HP editing for GMs, including signed relative input (`+N`/`-N`) and Enter/blur autosave.
- Added focus-select behavior for sheet Current HP input for faster in-play adjustments.
- Added system-aware morale default initialization so new dnd5e worlds start with morale checks disabled.
- Updated morale panel visibility to follow the morale setting so toggling the setting controls both checks and UI visibility.

## 0.4.0

- Added create-from-selection multi-group support so one action can create multiple group actors from selected tokens using explicit counts (example: `10, 10, 3`).
- Added one-click split option to break a group into individual actors (`1,1,1...`) directly from the split dialog.
- Added split token placement support so newly created split groups can be placed adjacent to the original token.
- Added actor-folder selection in create dialogs so new groups are created in the chosen Actor Directory folder.
- Added localization updates for folder selection, create-time split hints, and split-to-individuals dialog labels.

## 0.3.0

- Added split-group workflow with explicit subgroup sizes and HP-preserving distribution.
- Added token HUD actions for map-first workflows (create from selected tokens and split from grouped token).
- Added editable group naming in create flows.
- Added optional replacement of selected source tokens with newly created grouped token(s).
- Added Playwright UI regression scaffold with Foundry login helpers and create/split flow coverage.

## 0.2.0

- Added initial Foundry VTT v14 module scaffold.
- Added Actor Directory context action to create grouped actors.
- Added pooled HP tracking and automatic remaining-member recalculation.
- Added actor and token name syncing for surviving member counts.
- Added basic combat defeat syncing for groups reduced to 0 HP.
- Added actor sheet group information panel.
- Added modular refactor for hooks, UI, sync logic, morale logic, badge rendering, and shared helpers/constants.
- Added compact token count badge with scaling updates.
- Added morale checks, chat reporting, and sheet-panel morale status/reset workflow.
- Added README and backlog documentation.
