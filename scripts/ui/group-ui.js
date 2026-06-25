import { FLAG_SCOPE } from "../core/constants.js";
import { clampNumber, getInputValue, getRootElement } from "../core/helpers.js";
import { applyHPUpdate, calculateRemainingCount, formatGroupName, getDefaultHPPerCreature, getGroupFlags, getHitPointPaths, isGroupActor } from "../actors/group-model.js";
import { formatMoraleStatus, resetMoraleFlags } from "../actors/morale.js";

const TEMPLATE_BASE_PATH = "modules/mob-tokens/templates";

async function renderActorGrouperTemplate(templateName, data = {})
{
    return renderTemplate(`${TEMPLATE_BASE_PATH}/${templateName}.hbs`, data);
}

function isCheckboxChecked(html, name)
{
    if (typeof html?.find === "function")
    {
        return html.find(`[name='${name}']`).is(":checked");
    }

    const root = html instanceof HTMLElement ? html : html?.[0];
    return Boolean(root?.querySelector?.(`[name='${name}']`)?.checked);
}

export async function openCreateGroupDialog(actor)
{
    const defaultHP = getDefaultHPPerCreature(actor);
    const defaultName = formatGroupName(actor.name, 1);
    const defaultFolderId = actor.folder?.id ?? "";
    const folderOptions = getActorFolderOptions(defaultFolderId);
    const content = await renderActorGrouperTemplate("dialog-create-group", {
        sourceActorName: actor.name,
        defaultGroupName: defaultName,
        defaultHP,
        folderOptions
    });

    return new Dialog({
        title: game.i18n.localize("MOBTOKENS.ContextCreateGroup"),
        content,
        buttons: {
            create: {
                icon: "<i class=\"fas fa-check\"></i>",
                label: game.i18n.localize("MOBTOKENS.ButtonCreate"),
                callback: async (html) =>
                {
                    const groupName = String(getInputValue(html, "groupName") ?? "").trim();
                    const folderId = getFolderIdFromInput(getInputValue(html, "targetFolder"));
                    const creatureCount = Number(getInputValue(html, "creatureCount"));
                    const hpPerCreature = Number(getInputValue(html, "hpPerCreature"));
                    await createGroupActor(actor, { groupName, folderId, creatureCount, hpPerCreature });
                }
            },
            cancel: {
                icon: "<i class=\"fas fa-times\"></i>",
                label: game.i18n.localize("MOBTOKENS.ButtonCancel")
            }
        },
        default: "create",
        render: (html) =>
        {
            const nameInput = html.find("[name='groupName']");
            const countInput = html.find("[name='creatureCount']");
            let nameDirty = false;

            nameInput.on("input", () =>
            {
                nameDirty = true;
            });

            countInput.on("change", () =>
            {
                if (nameDirty) return;
                const count = Math.max(Number(countInput.val()) || 1, 1);
                nameInput.val(formatGroupName(actor.name, count));
            });

            countInput.trigger("focus");
        }
    }).render(true);
}

export function injectTokenHudGroupAction(token, html)
{
    if (!game.user?.isGM) return;
    const root = getRootElement(html);
    if (!root) return;

    const existingCreate = root.querySelector(".control-icon.mob-tokens-create-group");
    if (existingCreate) existingCreate.remove();
    const existingSplit = root.querySelector(".control-icon.mob-tokens-split-group");
    if (existingSplit) existingSplit.remove();

    const host = root.querySelector(".col.right") ?? root.querySelector(".right") ?? root;

    const selection = getSelectedTokenGroupingData(token);
    if (selection)
    {
        const createButton = document.createElement("div");
        createButton.classList.add("control-icon", "mob-tokens-create-group");
        createButton.dataset.action = "mob-tokens-create-group";
        createButton.title = game.i18n.localize("MOBTOKENS.HudCreateGroupFromSelection");
        createButton.innerHTML = "<i class=\"fas fa-people-group\"></i>";

        createButton.addEventListener("click", async (event) =>
        {
            event.preventDefault();
            event.stopPropagation();
            await openCreateGroupFromTokensDialog(selection.tokens, selection.sourceActor, token, selection.totalCreatureCount);
        });

        host.prepend(createButton);
    }

    const splitData = getSplitTokenGroupingData(token);
    if (splitData)
    {
        const splitButton = document.createElement("div");
        splitButton.classList.add("control-icon", "mob-tokens-split-group");
        splitButton.dataset.action = "mob-tokens-split-group";
        splitButton.title = game.i18n.localize("MOBTOKENS.HudSplitGroupFromToken");
        splitButton.innerHTML = "<i class=\"fas fa-code-branch\"></i>";

        splitButton.addEventListener("click", async (event) =>
        {
            event.preventDefault();
            event.stopPropagation();
            await openSplitGroupDialog(splitData.groupActor, {
                placeCreatedTokens: true,
                referenceToken: token
            });
        });

        host.prepend(splitButton);
    }
}

function getSplitTokenGroupingData(token)
{
    const groupActor = token?.actor;
    if (!(groupActor instanceof Actor)) return null;
    if (!isGroupActor(groupActor)) return null;

    const flags = getGroupFlags(groupActor);
    const remainingCount = Number(flags.remainingCount) || 0;
    if (remainingCount <= 1) return null;

    return { groupActor };
}

async function openCreateGroupFromTokensDialog(selectedTokens, sourceActor, referenceToken, initialCreatureCount)
{
    const tokenCount = selectedTokens.length;
    if (tokenCount < 2)
    {
        ui.notifications?.warn(game.i18n.localize("MOBTOKENS.Errors.InvalidTokenSelectionCount"));
        return null;
    }

    const defaultHP = getDefaultHPPerCreature(sourceActor);
    const defaultCreatureCount = Math.max(Number(initialCreatureCount) || tokenCount, 1);
    const defaultName = formatGroupName(sourceActor.name, defaultCreatureCount);
    const defaultFolderId = sourceActor.folder?.id ?? "";
    const defaultGroupCount = 1;
    const folderOptions = getActorFolderOptions(defaultFolderId);
    const createCountsHint = game.i18n.format("MOBTOKENS.DialogCreateCountsHint", { total: defaultCreatureCount });
    const content = await renderActorGrouperTemplate("dialog-create-group-from-tokens", {
        sourceActorName: sourceActor.name,
        defaultGroupName: defaultName,
        tokenCount,
        defaultCreatureCount,
        defaultGroupCount,
        defaultHP,
        maxResultGroupCount: defaultCreatureCount,
        createCountsHint,
        folderOptions
    });

    return new Dialog({
        title: game.i18n.localize("MOBTOKENS.HudCreateGroupFromSelection"),
        content,
        buttons: {
            create: {
                icon: "<i class=\"fas fa-check\"></i>",
                label: game.i18n.localize("MOBTOKENS.ButtonCreate"),
                callback: async (html) =>
                {
                    const groupName = String(getInputValue(html, "groupName") ?? "").trim();
                    const folderId = getFolderIdFromInput(getInputValue(html, "targetFolder"));
                    const creatureCount = Number(getInputValue(html, "creatureCount"));
                    const resultGroupCount = Number(getInputValue(html, "resultGroupCount"));
                    const groupCountsRaw = String(getInputValue(html, "groupCounts") ?? "");
                    const hpPerCreature = Number(getInputValue(html, "hpPerCreature"));
                    const replaceSelectedTokens = isCheckboxChecked(html, "replaceSelectedTokens");

                    if (!Number.isInteger(resultGroupCount) || resultGroupCount < 1 || resultGroupCount > creatureCount)
                    {
                        ui.notifications?.error(game.i18n.localize("MOBTOKENS.Errors.InvalidSplitGroupCount"));
                        return;
                    }

                    let requestedCounts = [creatureCount];
                    if (resultGroupCount > 1)
                    {
                        const parsedCounts = parseSplitCounts(groupCountsRaw);
                        if (!parsedCounts.every((value) => Number.isInteger(value) && value > 0))
                        {
                            ui.notifications?.error(game.i18n.localize("MOBTOKENS.Errors.InvalidSplitCountsFormat"));
                            return;
                        }
                        if (parsedCounts.length !== resultGroupCount)
                        {
                            ui.notifications?.error(game.i18n.localize("MOBTOKENS.Errors.InvalidSplitCountsLength"));
                            return;
                        }

                        const requestedTotal = parsedCounts.reduce((sum, value) => sum + value, 0);
                        if (requestedTotal !== creatureCount)
                        {
                            ui.notifications?.error(game.i18n.format("MOBTOKENS.Errors.InvalidSplitCountsTotal", {
                                total: creatureCount
                            }));
                            return;
                        }

                        requestedCounts = parsedCounts;
                    }

                    const pooledCurrentHP = getSelectedTokensCurrentHP(selectedTokens);
                    const allocatedCurrentHP = distributeHPAcrossSplits(pooledCurrentHP, requestedCounts, hpPerCreature);

                    const createdActors = [];
                    for (let index = 0; index < requestedCounts.length; index++)
                    {
                        const count = requestedCounts[index];
                        const createdActor = await createGroupActor(sourceActor, {
                            groupName: formatGroupName(sourceActor.name, count),
                            folderId,
                            creatureCount: count,
                            hpPerCreature,
                            initialCurrentHP: allocatedCurrentHP[index],
                            renderSheet: false,
                            notify: false
                        });
                        if (createdActor) createdActors.push(createdActor);
                    }

                    if (createdActors.length === 0) return;

                    ui.notifications?.info(game.i18n.format("MOBTOKENS.Notifications.GroupsCreatedFromTokens", {
                        groups: createdActors.length,
                        count: selectedTokens.length
                    }));

                    if (!replaceSelectedTokens) return;
                    await replaceSelectedTokensWithGroups(selectedTokens, createdActors, referenceToken);
                }
            },
            cancel: {
                icon: "<i class=\"fas fa-times\"></i>",
                label: game.i18n.localize("MOBTOKENS.ButtonCancel")
            }
        },
        default: "create",
        render: (html) =>
        {
            const nameInput = html.find("[name='groupName']");
            const countInput = html.find("[name='creatureCount']");
            const resultGroupCountInput = html.find("[name='resultGroupCount']");
            const groupCountsInput = html.find("[name='groupCounts']");
            let nameDirty = false;

            nameInput.on("input", () =>
            {
                nameDirty = true;
            });

            const refreshGroupCounts = () =>
            {
                const total = Math.max(Number(countInput.val()) || 1, 1);
                const requestedGroups = Math.max(Number(resultGroupCountInput.val()) || 1, 1);
                const normalizedGroups = clampNumber(Math.round(requestedGroups), 1, total);
                resultGroupCountInput.val(normalizedGroups);
                if (normalizedGroups <= 1)
                {
                    groupCountsInput.val(String(total));
                    return;
                }

                groupCountsInput.val(suggestSplitCounts(total, normalizedGroups));
            };

            countInput.on("change", () =>
            {
                const count = Math.max(Number(countInput.val()) || 1, 1);
                if (!nameDirty)
                {
                    nameInput.val(formatGroupName(sourceActor.name, count));
                }
                refreshGroupCounts();
            });

            resultGroupCountInput.on("change", () =>
            {
                refreshGroupCounts();
            });

            refreshGroupCounts();
            countInput.trigger("focus");
        }
    }).render(true);
}

function getSelectedTokenGroupingData(token)
{
    const selected = canvas?.tokens?.controlled ?? [];
    const tokens = selected.length > 0
        ? selected
        : (token ? [token] : []);

    if (tokens.length < 2) return null;

    const tokenActors = tokens.map((entry) => entry?.actor);
    if (!tokenActors.every((actor) => actor instanceof Actor)) return null;

    const firstActor = tokenActors[0];
    const firstFlags = isGroupActor(firstActor) ? getGroupFlags(firstActor) : null;
    const sourceActorId = String(firstFlags?.sourceActorId ?? firstActor.id ?? "");
    if (!sourceActorId) return null;

    const hasSameSource = tokenActors.every((actor) =>
    {
        if (!(actor instanceof Actor)) return false;
        if (!isGroupActor(actor)) return String(actor.id ?? "") === sourceActorId;
        const flags = getGroupFlags(actor);
        return String(flags.sourceActorId ?? actor.id ?? "") === sourceActorId;
    });
    if (!hasSameSource) return null;

    const totalCreatureCount = tokenActors.reduce((sum, actor) =>
    {
        if (!(actor instanceof Actor)) return sum;
        if (!isGroupActor(actor)) return sum + 1;
        const flags = getGroupFlags(actor);
        return sum + Math.max(Number(flags.remainingCount) || 0, 0);
    }, 0);
    if (totalCreatureCount < 2) return null;

    const sourceActor = game.actors?.get(sourceActorId) ?? firstActor;

    return {
        sourceActor,
        tokens,
        totalCreatureCount
    };
}

function getSelectedTokensCurrentHP(selectedTokens)
{
    return selectedTokens.reduce((sum, token) =>
    {
        const actor = token?.actor;
        if (!(actor instanceof Actor)) return sum;

        const hpPaths = getHitPointPaths(actor.system ?? {});
        if (!hpPaths) return sum;

        const currentHP = Number(foundry.utils.getProperty(actor, hpPaths.current)) || 0;
        return sum + Math.max(currentHP, 0);
    }, 0);
}

async function replaceSelectedTokensWithGroups(selectedTokens, groupActors, referenceToken)
{
    const scene = canvas?.scene;
    if (!scene)
    {
        ui.notifications?.warn(game.i18n.localize("MOBTOKENS.Errors.NoActiveScene"));
        return;
    }

    const anchorToken = referenceToken ?? selectedTokens[0] ?? null;
    const anchorDocument = anchorToken?.document ?? null;
    if (!anchorDocument)
    {
        ui.notifications?.warn(game.i18n.localize("MOBTOKENS.Errors.TokenNotFound"));
        return;
    }

    const createdTokenData = [];
    const gridSize = Number(canvas?.grid?.size) || 100;
    const baseX = Number(anchorDocument.x) || 0;
    const baseY = Number(anchorDocument.y) || 0;

    for (let index = 0; index < groupActors.length; index++)
    {
        const groupActor = groupActors[index];
        const tokenDoc = await groupActor.getTokenDocument({
            x: baseX + (gridSize * index),
            y: baseY
        });
        createdTokenData.push(tokenDoc.toObject());
    }

    if (createdTokenData.length > 0)
    {
        await scene.createEmbeddedDocuments("Token", createdTokenData);
    }

    const deleteIds = selectedTokens
        .map((entry) => entry?.document?.id)
        .filter(Boolean);

    if (deleteIds.length > 0)
    {
        await scene.deleteEmbeddedDocuments("Token", deleteIds);
    }

}

export async function openSplitGroupDialog(groupActor, options = {})
{
    const flags = getGroupFlags(groupActor);
    const totalCount = Math.max(Number(flags.remainingCount) || 0, 0);
    if (totalCount <= 1)
    {
        ui.notifications?.warn(game.i18n.localize("MOBTOKENS.Errors.InvalidSplitGroupCount"));
        return null;
    }

    const defaultGroups = 2;
    const defaultCounts = suggestSplitCounts(totalCount, defaultGroups);
    const splitCountsHint = game.i18n.format("MOBTOKENS.DialogSplitCountsHint", { total: totalCount });
    const content = await renderActorGrouperTemplate("dialog-split-group", {
        sourceActorName: groupActor.name,
        totalCount,
        defaultGroups,
        defaultCounts,
        splitCountsHint
    });

    return new Dialog({
        title: game.i18n.localize("MOBTOKENS.ContextSplitGroup"),
        content,
        buttons: {
            split: {
                icon: "<i class=\"fas fa-code-branch\"></i>",
                label: game.i18n.localize("MOBTOKENS.ButtonSplit"),
                callback: async (html) =>
                {
                    const splitGroupCount = Number(getInputValue(html, "splitGroupCount"));
                    const splitIndividuals = isCheckboxChecked(html, "splitIndividuals");
                    const splitCountsRaw = String(getInputValue(html, "splitCounts") ?? "");
                    const splitCounts = splitIndividuals
                        ? Array.from({ length: totalCount }, () => 1)
                        : parseSplitCounts(splitCountsRaw);
                    const expectedGroupCount = splitIndividuals ? totalCount : splitGroupCount;

                    if (!Number.isInteger(expectedGroupCount) || expectedGroupCount < 2 || expectedGroupCount > totalCount)
                    {
                        ui.notifications?.error(game.i18n.localize("MOBTOKENS.Errors.InvalidSplitGroupCount"));
                        return;
                    }
                    if (!splitCounts.every((value) => Number.isInteger(value) && value > 0))
                    {
                        ui.notifications?.error(game.i18n.localize("MOBTOKENS.Errors.InvalidSplitCountsFormat"));
                        return;
                    }
                    if (splitCounts.length !== expectedGroupCount)
                    {
                        ui.notifications?.error(game.i18n.localize("MOBTOKENS.Errors.InvalidSplitCountsLength"));
                        return;
                    }

                    const totalRequested = splitCounts.reduce((sum, value) => sum + value, 0);
                    if (totalRequested !== totalCount)
                    {
                        ui.notifications?.error(game.i18n.format("MOBTOKENS.Errors.InvalidSplitCountsTotal", {
                            total: totalCount
                        }));
                        return;
                    }

                    await splitGroupActor(groupActor, splitCounts, options);
                }
            },
            cancel: {
                icon: "<i class=\"fas fa-times\"></i>",
                label: game.i18n.localize("MOBTOKENS.ButtonCancel")
            }
        },
        default: "split",
        render: (html) =>
        {
            const inputCount = html.find("[name='splitGroupCount']");
            const inputCounts = html.find("[name='splitCounts']");
            const inputSplitIndividuals = html.find("[name='splitIndividuals']");

            const setIndividualsMode = (isIndividuals) =>
            {
                if (isIndividuals)
                {
                    inputCount.val(totalCount);
                    inputCounts.val(Array.from({ length: totalCount }, () => 1).join(", "));
                    inputCount.prop("disabled", true);
                    inputCounts.prop("disabled", true);
                    return;
                }

                inputCount.prop("disabled", false);
                inputCounts.prop("disabled", false);
                const requestedGroups = Number(inputCount.val()) || defaultGroups;
                const normalizedGroups = clampNumber(Math.round(requestedGroups), 2, totalCount);
                inputCount.val(normalizedGroups);
                inputCounts.val(suggestSplitCounts(totalCount, normalizedGroups));
            };

            inputCount.on("change", () =>
            {
                if (inputSplitIndividuals.is(":checked")) return;
                const requestedGroups = Number(inputCount.val()) || defaultGroups;
                const normalizedGroups = clampNumber(Math.round(requestedGroups), 2, totalCount);
                inputCount.val(normalizedGroups);
                inputCounts.val(suggestSplitCounts(totalCount, normalizedGroups));
            });

            inputSplitIndividuals.on("change", () =>
            {
                setIndividualsMode(inputSplitIndividuals.is(":checked"));
            });

            setIndividualsMode(false);
            inputCount.trigger("focus");
        }
    }).render(true);
}

export async function showQuickStartPrompt()
{
    const content = await renderActorGrouperTemplate("help-quick-start-prompt");

    new Dialog({
        title: game.i18n.localize("MOBTOKENS.HelpPromptTitle"),
        content,
        buttons: {
            show: {
                icon: "<i class=\"fas fa-book-open\"></i>",
                label: game.i18n.localize("MOBTOKENS.HelpPromptShow"),
                callback: async () => showQuickStartGuide()
            },
            close: {
                icon: "<i class=\"fas fa-check\"></i>",
                label: game.i18n.localize("MOBTOKENS.HelpPromptDismiss")
            }
        },
        default: "show"
    }).render(true);
}

export async function showQuickStartGuide()
{
    const content = await renderActorGrouperTemplate("help-quick-start-guide");

    new Dialog({
        title: game.i18n.localize("MOBTOKENS.HelpGuideTitle"),
        content,
        buttons: {
            close: {
                icon: "<i class=\"fas fa-check\"></i>",
                label: game.i18n.localize("MOBTOKENS.ButtonClose")
            }
        },
        default: "close"
    }).render(true);
}

export async function injectGroupPanel(actor, html)
{
    const root = getRootElement(html);
    if (!root) return;
    if (root.querySelector(".mob-tokens-panel"))
    {
        refreshGroupPanel(actor, root);
        return;
    }

    const flags = getGroupFlags(actor);
    const panel = await renderActorGrouperTemplate("group-panel", {
        sourceActorName: flags.sourceActorName ?? "-",
        creatureCount: Number(flags.creatureCount) || 0,
        remainingCount: Number(flags.remainingCount) || 0,
        hpPerCreature: Number(flags.hpPerCreature) || 0,
        maxGroupHP: Number(flags.maxGroupHP) || 0,
        currentGroupHP: Number(flags.currentGroupHP) || 0,
        moraleStatus: formatMoraleStatus(flags),
        isGM: Boolean(game.user?.isGM)
    });

    const target = root.querySelector("form")
        ?? root.querySelector(".window-content")
        ?? root;

    const fragment = document.createElement("div");
    fragment.innerHTML = panel.trim();
    const panelElement = fragment.firstElementChild;
    if (!panelElement) return;
    target.prepend(panelElement);
    refreshGroupPanel(actor, root);
}

export function wireGroupPanelActions(actor, html)
{
    const root = getRootElement(html);
    const button = root?.querySelector?.(".mob-tokens-reset-morale");
    if (!button) return;
    if (button.dataset.actorGrouperBound === "1") return;
    button.dataset.actorGrouperBound = "1";

    button.addEventListener("click", async (event) =>
    {
        event.preventDefault();
        if (!game.user?.isGM) return;

        await resetMoraleFlags(actor);
        ui.notifications?.info(game.i18n.format("MOBTOKENS.Notifications.MoraleReset", {
            name: actor.name
        }));
        refreshOpenGroupPanels(actor);
    });
}

export function refreshGroupPanel(actor, html)
{
    const root = getRootElement(html);
    const panel = root?.querySelector?.(".mob-tokens-panel");
    if (!panel) return;

    const flags = getGroupFlags(actor);
    setPanelField(panel, "sourceActorName", flags.sourceActorName ?? "-");
    setPanelField(panel, "creatureCount", Number(flags.creatureCount) || 0);
    setPanelField(panel, "remainingCount", Number(flags.remainingCount) || 0);
    setPanelField(panel, "hpPerCreature", Number(flags.hpPerCreature) || 0);
    setPanelField(panel, "maxGroupHP", Number(flags.maxGroupHP) || 0);
    setPanelField(panel, "currentGroupHP", Number(flags.currentGroupHP) || 0);
    setPanelField(panel, "moraleStatus", formatMoraleStatus(flags));
}

export function refreshOpenGroupPanels(actor)
{
    const windows = Object.values(ui.windows ?? {});
    for (const app of windows)
    {
        const appActor = app?.actor ?? app?.document;
        if (!appActor || appActor.id !== actor.id) continue;
        const host = app.element ?? app;
        refreshGroupPanel(actor, host);
    }
}

function setPanelField(panel, fieldName, value)
{
    const node = panel.querySelector(`[data-ag-field='${fieldName}']`);
    if (!node) return;
    node.textContent = String(value ?? "");
}

export async function createGroupActor(sourceActor, {
    groupName,
    folderId,
    creatureCount,
    hpPerCreature,
    initialCurrentHP,
    sourceActorId,
    sourceActorName,
    renderSheet = true,
    notify = true
})
{
    if (!Number.isInteger(creatureCount) || creatureCount < 1)
    {
        ui.notifications?.error(game.i18n.localize("MOBTOKENS.Errors.InvalidCreatureCount"));
        return null;
    }

    if (!Number.isFinite(hpPerCreature) || hpPerCreature < 1)
    {
        ui.notifications?.error(game.i18n.localize("MOBTOKENS.Errors.InvalidHPPerCreature"));
        return null;
    }

    const maxGroupHP = creatureCount * hpPerCreature;
    const currentGroupHP = clampNumber(Number(initialCurrentHP ?? maxGroupHP), 0, maxGroupHP);
    const remainingCount = calculateRemainingCount({
        currentHP: currentGroupHP,
        maxGroupHP,
        creatureCount,
        hpPerCreature
    });
    const actorData = sourceActor.toObject();
    const hpPaths = getHitPointPaths(actorData.system ?? {});
    delete actorData._id;

    const effectiveSourceActorId = sourceActorId ?? sourceActor.id;
    const effectiveSourceActorName = sourceActorName ?? sourceActor.name;
    const resolvedGroupName = String(groupName ?? "").trim() || formatGroupName(effectiveSourceActorName, remainingCount);
    actorData.name = resolvedGroupName;
    if (folderId !== undefined)
    {
        actorData.folder = folderId || null;
    }
    actorData.prototypeToken ??= {};
    actorData.prototypeToken.name = actorData.name;
    actorData.prototypeToken.actorLink = true;
    actorData.flags ??= {};
    actorData.flags[FLAG_SCOPE] = {
        ...(actorData.flags[FLAG_SCOPE] ?? {}),
        isGroupActor: true,
        sourceActorId: effectiveSourceActorId,
        sourceActorName: effectiveSourceActorName,
        creatureCount,
        remainingCount,
        hpPerCreature,
        maxGroupHP,
        currentGroupHP,
        moraleCheckedHalf: false,
        moraleRollTotal: null,
        moralePassed: null,
        isRouting: false
    };

    applyHPUpdate(actorData, hpPaths, currentGroupHP, maxGroupHP);

    const createdActor = await Actor.create(actorData, { renderSheet });
    if (notify)
    {
        ui.notifications?.info(game.i18n.format("MOBTOKENS.Notifications.GroupCreated", {
            name: createdActor.name
        }));
    }
    return createdActor;
}

function getActorFolderOptions(defaultFolderId = "")
{
    const options = [{
        id: "",
        label: game.i18n.localize("MOBTOKENS.DialogFolderRoot"),
        selected: !defaultFolderId
    }];

    const folders = (game.folders?.filter((folder) => folder.type === "Actor") ?? [])
        .slice()
        .sort((a, b) =>
        {
            const bySort = (Number(a.sort) || 0) - (Number(b.sort) || 0);
            if (bySort !== 0) return bySort;
            return String(a.name ?? "").localeCompare(String(b.name ?? ""));
        });

    for (const folder of folders)
    {
        const folderId = String(folder.id ?? "");
        const depth = Math.max((Number(folder.depth) || 1) - 1, 0);
        const indent = depth > 0 ? `${"- ".repeat(depth)}` : "";
        const label = `${indent}${folder.name}`;
        const selected = folderId === String(defaultFolderId ?? "");
        options.push({ id: folderId, label, selected });
    }

    return options;
}

function getFolderIdFromInput(value)
{
    const folderId = String(value ?? "").trim();
    return folderId.length > 0 ? folderId : null;
}

async function splitGroupActor(groupActor, splitCounts, options = {})
{
    const flags = getGroupFlags(groupActor);
    const hpPerCreature = Math.max(Number(flags.hpPerCreature) || 0, 1);
    const totalCurrentHP = Math.max(Number(flags.currentGroupHP) || 0, 0);
    const sourceActor = game.actors?.get(flags.sourceActorId) ?? groupActor;
    const sourceActorId = flags.sourceActorId ?? sourceActor.id;
    const sourceActorName = flags.sourceActorName ?? sourceActor.name;

    const allocatedHP = distributeHPAcrossSplits(totalCurrentHP, splitCounts, hpPerCreature);

    const firstCount = splitCounts[0];
    const firstMaxHP = firstCount * hpPerCreature;
    const firstCurrentHP = allocatedHP[0];
    const firstRemainingCount = calculateRemainingCount({
        currentHP: firstCurrentHP,
        maxGroupHP: firstMaxHP,
        creatureCount: firstCount,
        hpPerCreature
    });

    const updates = {
        name: formatGroupName(sourceActorName, firstRemainingCount),
        "prototypeToken.name": formatGroupName(sourceActorName, firstRemainingCount),
        [`flags.${FLAG_SCOPE}.sourceActorId`]: sourceActorId,
        [`flags.${FLAG_SCOPE}.sourceActorName`]: sourceActorName,
        [`flags.${FLAG_SCOPE}.creatureCount`]: firstCount,
        [`flags.${FLAG_SCOPE}.remainingCount`]: firstRemainingCount,
        [`flags.${FLAG_SCOPE}.hpPerCreature`]: hpPerCreature,
        [`flags.${FLAG_SCOPE}.maxGroupHP`]: firstMaxHP,
        [`flags.${FLAG_SCOPE}.currentGroupHP`]: firstCurrentHP,
        [`flags.${FLAG_SCOPE}.moraleCheckedHalf`]: false,
        [`flags.${FLAG_SCOPE}.moraleRollTotal`]: null,
        [`flags.${FLAG_SCOPE}.moralePassed`]: null,
        [`flags.${FLAG_SCOPE}.isRouting`]: false
    };

    const hpPaths = getHitPointPaths(groupActor.system ?? {});
    if (hpPaths)
    {
        updates[hpPaths.current] = firstCurrentHP;
        updates[hpPaths.max] = firstMaxHP;
    }

    await groupActor.update(updates);

    const createdActors = [];
    for (let index = 1; index < splitCounts.length; index++)
    {
        const created = await createGroupActor(sourceActor, {
            creatureCount: splitCounts[index],
            hpPerCreature,
            initialCurrentHP: allocatedHP[index],
            sourceActorId,
            sourceActorName,
            renderSheet: false,
            notify: false
        });
        if (created) createdActors.push(created);
    }

    if (options?.placeCreatedTokens && createdActors.length > 0)
    {
        await placeCreatedSplitTokens(createdActors, options?.referenceToken);
    }

    ui.notifications?.info(game.i18n.format("MOBTOKENS.Notifications.GroupSplit", {
        name: groupActor.name,
        count: splitCounts.length
    }));
}

async function placeCreatedSplitTokens(createdActors, referenceToken)
{
    const scene = canvas?.scene;
    if (!scene) return;

    const anchor = referenceToken?.document;
    if (!anchor) return;

    const gridSize = Number(canvas?.grid?.size) || 100;
    const baseX = Number(anchor.x) || 0;
    const baseY = Number(anchor.y) || 0;

    const tokenData = [];
    for (let index = 0; index < createdActors.length; index++)
    {
        const actor = createdActors[index];
        const x = baseX + gridSize * (index + 1);
        const y = baseY;
        const tokenDoc = await actor.getTokenDocument({ x, y });
        tokenData.push(tokenDoc.toObject());
    }

    if (tokenData.length > 0)
    {
        await scene.createEmbeddedDocuments("Token", tokenData);
    }
}

function parseSplitCounts(value)
{
    return String(value ?? "")
        .split(/[\s,]+/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .map((part) => Number(part));
}

function suggestSplitCounts(total, groups)
{
    const groupCount = Math.max(Number(groups) || 2, 2);
    const baseCount = Math.floor(total / groupCount);
    let remainder = total % groupCount;
    const values = [];

    for (let index = 0; index < groupCount; index++)
    {
        const bonus = remainder > 0 ? 1 : 0;
        values.push(baseCount + bonus);
        if (remainder > 0) remainder -= 1;
    }

    return values.join(", ");
}

function distributeHPAcrossSplits(totalCurrentHP, splitCounts, hpPerCreature)
{
    let remainingHP = Math.max(Number(totalCurrentHP) || 0, 0);
    return splitCounts.map((count) =>
    {
        const maxHP = Math.max(Number(count) || 0, 0) * hpPerCreature;
        const assigned = clampNumber(remainingHP, 0, maxHP);
        remainingHP -= assigned;
        return assigned;
    });
}
