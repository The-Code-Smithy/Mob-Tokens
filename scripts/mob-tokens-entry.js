import { FLAG_SCOPE, MODULE_ID, UPDATE_GUARD } from "./core/constants.js";
import { getActorFolderFromDirectoryLi, getActorFromDirectoryLi, isGroupActor, isMobGroupActor } from "./actors/group-model.js";
import
{
    injectTokenHudGroupAction,
    openCreatePartyGroupFromActorsDialog,
    openSplitGroupDialog,
    injectGroupPanel,
    openCreateGroupDialog,
    refreshOpenGroupPanels,
    showQuickStartPrompt,
    wireGroupPanelActions
} from "./ui/group-ui.js";
import { syncGroupActor } from "./actors/group-sync.js";
import { removeTokenCountBadge, renderTokenCountBadge } from "./actors/actor-badge.js";
import { ensureUniqueGroupActorToken } from "./actors/group-token-isolation.js";
import { getSystemAdapter } from "./systems/system-adapter.js";

Hooks.once("init", () =>
{
    console.log(`${MODULE_ID} | Initializing`);
    const moduleRecord = game.modules?.get(MODULE_ID);
    if (moduleRecord)
    {
        moduleRecord.api = {
            ...(moduleRecord.api ?? {}),
            openCreatePartyGroupFromActorsDialog
        };
    }

    const defaultMoraleEnabled = getSystemAdapter().moraleEnabledByDefault;

    game.settings.register(MODULE_ID, "enableMoraleCheck", {
        name: "Enable 50% morale checks",
        hint: "When a mob drops to half HP (or lower) for the first time, roll morale.",
        scope: "world",
        config: true,
        type: Boolean,
        default: defaultMoraleEnabled
    });

    game.settings.register(MODULE_ID, "welcomePromptSeen", {
        name: "Mob Tokens Welcome Prompt Seen",
        hint: "Tracks whether the world has already shown the Mob Tokens quick-start prompt.",
        scope: "world",
        config: false,
        type: Boolean,
        default: false
    });

    game.settings.register(MODULE_ID, "moraleSettingInitialized", {
        name: "Mob Tokens Morale Setting Initialized",
        hint: "Tracks whether morale default has been initialized for this world.",
        scope: "world",
        config: false,
        type: Boolean,
        default: false
    });
});

Hooks.once("ready", async () =>
{
    if (!game.user?.isGM) return;

    await ensureMoraleSettingInitialized();

    const welcomePromptSeen = game.settings.get(MODULE_ID, "welcomePromptSeen");
    if (welcomePromptSeen) return;

    await game.settings.set(MODULE_ID, "welcomePromptSeen", true);
    await showQuickStartPrompt();
});

async function ensureMoraleSettingInitialized()
{
    const initialized = Boolean(game.settings.get(MODULE_ID, "moraleSettingInitialized"));
    if (initialized) return;

    const enabledByDefault = getSystemAdapter().moraleEnabledByDefault;
    await game.settings.set(MODULE_ID, "enableMoraleCheck", enabledByDefault);
    await game.settings.set(MODULE_ID, "moraleSettingInitialized", true);
}

Hooks.on("getActorContextOptions", (_app, entryOptions) =>
{
    addActorContextEntries(entryOptions);
});

Hooks.on("getActorDirectoryFolderContext", (_app, entryOptions) =>
{
    addActorFolderContextEntries(entryOptions);
});

Hooks.on("getDocumentDirectoryFolderContext", (_app, entryOptions) =>
{
    addActorFolderContextEntries(entryOptions);
});

Hooks.on("getFolderContextOptions", (app, entryOptions) =>
{
    if (!isActorDirectoryApp(app)) return;
    addActorFolderContextEntries(entryOptions);
});

Hooks.on("updateActor", async (actor, _changed, options) =>
{
    if (options?.[UPDATE_GUARD]) return;
    if (!isMobGroupActor(actor)) return;
    await syncGroupActor(actor);
    refreshOpenGroupPanels(actor);
});

Hooks.on("renderActorSheetV2", async (app, element) =>
{
    const actor = app.actor ?? app.document;
    if (!(actor instanceof Actor) || !isMobGroupActor(actor)) return;
    await injectGroupPanel(actor, element);
    wireGroupPanelActions(actor, element);
});

Hooks.on("canvasReady", () =>
{
    for (const token of canvas.tokens?.placeables ?? [])
    {
        renderTokenCountBadge(token);
    }
});

Hooks.on("refreshToken", (token) =>
{
    renderTokenCountBadge(token);
});

Hooks.on("destroyToken", (token) =>
{
    removeTokenCountBadge(token);
});

Hooks.on("renderTokenHUD", (app, html) =>
{
    const token = app?.object ?? app?.token ?? app?.document?.object ?? null;
    if (!token) return;
    injectTokenHudGroupAction(token, html);
});

Hooks.on("createToken", async (tokenDocument, options, userId) =>
{
    if (!game.user?.isGM) return;
    if (game.user.id !== userId) return;
    await ensureUniqueGroupActorToken(tokenDocument, options);
});

function addActorContextEntries(entryOptions)
{
    if (!Array.isArray(entryOptions)) return;

    const createLabel = game.i18n.localize("MOBTOKENS.ContextCreateGroup");
    if (!entryOptions.some((entry) => entry.label === createLabel || entry.name === createLabel))
    {
        entryOptions.push({
            label: createLabel,
            icon: "<i class=\"fas fa-people-group\"></i>",
            visible: (li) =>
            {
                if (!game.user?.isGM) return false;
                const actor = getActorFromDirectoryLi(li);
                if (!(actor instanceof Actor)) return true;
                return !isGroupActor(actor);
            },
            onClick: async (_event, li) =>
            {
                const actor = getActorFromDirectoryLi(li);
                if (!(actor instanceof Actor))
                {
                    ui.notifications?.error(game.i18n.localize("MOBTOKENS.Errors.ActorNotFound"));
                    return;
                }

                await openCreateGroupDialog(actor);
            }
        });
    }

    const splitLabel = game.i18n.localize("MOBTOKENS.ContextSplitGroup");
    if (!entryOptions.some((entry) => entry.label === splitLabel || entry.name === splitLabel))
    {
        entryOptions.push({
            label: splitLabel,
            icon: "<i class=\"fas fa-people-group\"></i>",
            visible: (li) =>
            {
                if (!game.user?.isGM) return false;
                const actor = getActorFromDirectoryLi(li);
                if (!(actor instanceof Actor)) return false;
                if (!isMobGroupActor(actor)) return false;
                const remainingCount = Number(actor.flags?.[FLAG_SCOPE]?.remainingCount) || 0;
                return remainingCount > 1;
            },
            onClick: async (_event, li) =>
            {
                const actor = getActorFromDirectoryLi(li);
                if (!(actor instanceof Actor))
                {
                    ui.notifications?.error(game.i18n.localize("MOBTOKENS.Errors.ActorNotFound"));
                    return;
                }

                await openSplitGroupDialog(actor);
            }
        });
    }

    const createPartyLabel = game.i18n.localize("MOBTOKENS.ContextCreatePartyGroup");
    if (!entryOptions.some((entry) => entry.label === createPartyLabel || entry.name === createPartyLabel))
    {
        entryOptions.push({
            label: createPartyLabel,
            icon: "<i class=\"fas fa-users\"></i>",
            visible: (li) =>
            {
                if (!game.user?.isGM) return false;
                const actor = getActorFromDirectoryLi(li);
                return actor instanceof Actor && !isGroupActor(actor);
            },
            onClick: async (_event, li) =>
            {
                const actor = getActorFromDirectoryLi(li);
                await openCreatePartyGroupFromActorsDialog(actor instanceof Actor ? actor : null);
            }
        });
    }
}

function addActorFolderContextEntries(entryOptions)
{
    if (!Array.isArray(entryOptions)) return;

    const createPartyFromFolderLabel = game.i18n.localize("MOBTOKENS.ContextCreatePartyGroupFromFolder");
    if (entryOptions.some((entry) => entry.label === createPartyFromFolderLabel || entry.name === createPartyFromFolderLabel)) return;

    entryOptions.push({
        label: createPartyFromFolderLabel,
        icon: "<i class=\"fas fa-folder-plus\"></i>",
        visible: (li) =>
        {
            if (!game.user?.isGM) return false;
            const folder = getActorFolderFromDirectoryLi(li);
            if (!folder) return false;
            const actorsInFolder = (game.actors?.contents ?? []).filter((actor) =>
                actor instanceof Actor
                && !isGroupActor(actor)
                && String(actor.folder?.id ?? "") === String(folder.id)
            );
            return actorsInFolder.length >= 2;
        },
        onClick: async (_event, li) =>
        {
            const folder = getActorFolderFromDirectoryLi(li);
            if (!folder)
            {
                ui.notifications?.error(game.i18n.localize("MOBTOKENS.Errors.ActorNotFound"));
                return;
            }

            const actorsInFolder = (game.actors?.contents ?? []).filter((actor) =>
                actor instanceof Actor
                && !isGroupActor(actor)
                && String(actor.folder?.id ?? "") === String(folder.id)
            );

            if (actorsInFolder.length < 2)
            {
                ui.notifications?.warn(game.i18n.localize("MOBTOKENS.Errors.InvalidPartyActorSelectionCount"));
                return;
            }

            await openCreatePartyGroupFromActorsDialog(null, actorsInFolder.map((actor) => actor.id));
        }
    });
}

function isActorDirectoryApp(app)
{
    const documentName = String(app?.documentName ?? app?.options?.documentName ?? "").toLowerCase();
    if (documentName === "actor") return true;
    return app?.collection === game.actors;
}
