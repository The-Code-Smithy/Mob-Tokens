import { FLAG_SCOPE, MODULE_ID, UPDATE_GUARD } from "./core/constants.js";
import { getActorFromDirectoryLi, isGroupActor } from "./actors/group-model.js";
import
{
    injectTokenHudGroupAction,
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

Hooks.once("init", () =>
{
    console.log(`${MODULE_ID} | Initializing`);

    game.settings.register(MODULE_ID, "enableMoraleCheck", {
        name: "Enable 50% morale checks",
        hint: "When a mob drops to half HP (or lower) for the first time, roll morale.",
        scope: "world",
        config: true,
        type: Boolean,
        default: true
    });

    game.settings.register(MODULE_ID, "welcomePromptSeen", {
        name: "Mob Tokens Welcome Prompt Seen",
        hint: "Tracks whether the world has already shown the Mob Tokens quick-start prompt.",
        scope: "world",
        config: false,
        type: Boolean,
        default: false
    });
});

Hooks.once("ready", async () =>
{
    if (!game.user?.isGM) return;

    const welcomePromptSeen = game.settings.get(MODULE_ID, "welcomePromptSeen");
    if (welcomePromptSeen) return;

    await game.settings.set(MODULE_ID, "welcomePromptSeen", true);
    await showQuickStartPrompt();
});

Hooks.on("getActorContextOptions", (_app, entryOptions) =>
{
    addActorContextEntries(entryOptions);
});

Hooks.on("updateActor", async (actor, _changed, options) =>
{
    if (options?.[UPDATE_GUARD]) return;
    if (!isGroupActor(actor)) return;
    await syncGroupActor(actor);
    refreshOpenGroupPanels(actor);
});

Hooks.on("renderActorSheetV2", async (app, element) =>
{
    const actor = app.actor ?? app.document;
    if (!(actor instanceof Actor) || !isGroupActor(actor)) return;
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
    if (entryOptions.some((entry) => entry.label === splitLabel || entry.name === splitLabel)) return;

    entryOptions.push({
        label: splitLabel,
        icon: "<i class=\"fas fa-people-group\"></i>",
        visible: (li) =>
        {
            if (!game.user?.isGM) return false;
            const actor = getActorFromDirectoryLi(li);
            if (!(actor instanceof Actor)) return false;
            if (!isGroupActor(actor)) return false;
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
