# Mob Tokens

Version: 0.7.2

Mob Tokens is a Foundry VTT v14 module that lets a GM represent multiple identical creatures as a single token on the canvas. It is aimed at large encounter management where token count, combat overhead, and scene clutter would otherwise slow play down.

## Highlights

- Create a Mob Token from any existing actor in the Actor Directory.
- Create movement-only Party Proxy groups from selected player actors.
- Create Party Proxy groups from an Actor Directory searchable picker.
- Track pooled HP across the group while keeping a single combatant.
- Recalculate surviving members automatically as HP changes.
- Update the actor and token display name to reflect remaining creatures.
- Mark combatants defeated when the group HP reaches 0.
- Show group metadata directly on the actor sheet.

## Supported Foundry Version

- Foundry VTT v14

## Initial System Target

- OSRIC
- Designed to stay system-agnostic where practical by detecting likely HP fields dynamically.

## Installation

1. Copy this module into your Foundry `Data/modules` directory.
2. Enable **Mob Tokens** in your world.
3. Make sure the GM account has permission to create actors.

## Usage

1. Open the Actor Directory.
2. Right-click a base actor.
3. Choose **Create Group**.
4. Enter the creature count.
5. Confirm or adjust the HP per creature value.
6. Click **Create**.

The module creates a new actor named like `Giant Rat x10`. When that actor takes damage through its normal HP field, the remaining count is recalculated with `floor(currentHP / hpPerCreature)`. At 0 HP, the remaining count becomes 0 and linked combatants are marked defeated.

### Party Proxy Groups

1. Open the Actor Directory.
2. Use the context action to open **Create Party Group**.
3. Search and select world actors to include.
4. Confirm to create a movement-only Party Proxy group.

Party Proxy groups are intended for movement and member organization workflows. They preserve party membership and can be split back into their original member actors.

## Stored Data

Mob token actors store their metadata in actor flags under `flags.mob-tokens`.

Tracked values:

- `sourceActorId`
- `sourceActorName`
- `creatureCount`
- `remainingCount`
- `hpPerCreature`
- `maxGroupHP`
- `currentGroupHP`
- `isGroupActor`

## Recent Version Updates

### v0.6.0

- Added movement-only Party Proxy grouping mode with dedicated HUD create/split controls and member restore behavior.
- Added Actor Directory shortcut to create Party Proxy groups from a searchable world-actor picker.
- Added system adapter scaffolding (`generic`, `dnd5e`, `osric`) to centralize system-specific behavior.
- Added optional Morale and Armor Class fields to group creation dialogs when those fields are available.

### v0.5.0

- Group sheets now support GM Current HP edits with direct values or signed adjustments (example: `22`, `+9`, `-9`).
- Current HP sheet input now auto-selects on focus and applies updates on Enter or blur.
- Defeat sync now preserves/restores prior non-defeated overlays instead of clearing unrelated overlay state.
- Token badge layering/placement now avoids obscuring stacked token effect icons.
- Morale defaults are now system-aware (new dnd5e worlds default morale checks off), and morale UI visibility follows the morale setting.

### v0.4.0

- Create-from-selection now supports creating multiple group actors in one step using explicit counts (example: `10, 10, 3`).
- Split dialog now includes a one-click option to split into individuals (example: 6 -> `1, 1, 1, 1, 1, 1`).
- Group creation dialogs now allow selecting the destination Actor folder.
- Split flows can place newly created tokens near the original grouped token.

### v0.3.0

- Added split-group dialog workflow with explicit subgroup counts.
- Added token HUD create/split actions for selected map tokens.
- Added editable group naming in create dialogs.
- Added Playwright UI regression tests and Foundry login helpers.

### v0.2.0

- Added initial Foundry v14 module scaffold and create-group directory action.
- Added pooled HP tracking and automatic surviving-member recalculation.
- Added morale workflow, token count badge, and actor-sheet group panel.

## v0.6.0 Scope

Included in this version:

- Mob token creation from any actor in the directory
- Mob creation from selected tokens with multi-result counts
- Mob splitting with explicit subgroup counts
- Mob splitting into individual actors
- Pooled HP tracking
- Remaining member calculation
- Token and actor name updates
- Basic defeat handling in combat
- Morale check and reset flow (setting-controlled visibility)
- Mob information panel on the actor sheet
- GM Current HP editing from the group sheet (absolute and relative)
- Movement-only Party Proxy groups and restore-from-split behavior
- Actor Directory Party Group picker with searchable world-actor list
- System adapter scaffolding for system-specific field/path handling
- Optional create-time Morale and AC overrides when available on source actor

Not included in this version:

- Merging groups
- Mixed creature groups
- Automatic attack scaling
- Swarm mechanics
- Formation tracking
- AI features
- Loot generation
- Advanced statistics

## Notes

- For best results, place linked tokens from the generated Mob Token actor.
- The module updates the actor name to match the current remaining count so the combat tracker and linked tokens stay aligned.
- Defeated state sync now mirrors the defeated overlay outside combat while preserving any prior non-defeated overlay for restoration.
- Group count badge placement/layering is tuned to avoid obscuring stacked token status effect icons.
- Morale UI visibility now follows the world morale setting, and new dnd5e worlds default morale checks off.
- Party Proxy groups are intentionally movement-only and do not apply mob HP pooling behavior.
- HP field detection is intentionally generic, but systems with unusual actor HP schemas may need a follow-up compatibility pass.

## Playwright UI Tests

This module now includes Playwright regression tests under `tests/` so repeated UI checks can run automatically.

### Prerequisites

- Foundry VTT is running.
- The Gamemaster account exists in your world (default for all worlds).

### Setup

1. Install dependencies:

	 ```bash
	 npm install
	 ```

2. Optional: copy `.env.example` to `.env` and adjust values for your instance.

	 ```bash
	 copy .env.example .env
	 ```

Key variables:

- `FOUNDRY_BASE_URL` (default: `http://127.0.0.1:30000`)
- `FOUNDRY_WORLD` (optional world name from join screen)
- `FOUNDRY_USERNAME` (default: `Gamemaster`)
- `FOUNDRY_PASSWORD` (default: empty)

### Run

- Headless mode (default):

	```bash
	npm run test:ui
	```

- Headed mode:

	```bash
	npm run test:ui:headed
	```

### Current Coverage

- Open Create Group from Actor Directory context menu.
- Create a group and split it 4,3.
- Split using explicit counts and verify resulting actors.
- Split into individual actors.
- Verify regroup HUD button appears for selected mob token actors.
- Create Party Proxy groups from Actor Directory with searchable actor picker.
- Verify Actor Folder context action visibility rules for Party Group creation.
- Add party members via party-panel drag and drop without opening unintended actor sheets.
- Remove party members via party-panel controls while preserving dedicated party layout.
