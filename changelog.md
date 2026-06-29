# Mob Tokens — Changelog

## Unreleased

- Fixed defeat sync to preserve non-defeated token overlays when applying and clearing the defeated icon.
- Fixed token badge layering/placement so stacked token status effect icons remain visible.

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
