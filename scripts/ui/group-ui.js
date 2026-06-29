import { FLAG_SCOPE, GROUP_MODE_MOB } from "../core/constants.js";
import { clampNumber, getInputValue, getRootElement } from "../core/helpers.js";
import { applyHPUpdate, calculateRemainingCount, formatGroupName, getDefaultHPPerCreature, getGroupFlags, getHitPointPaths, isGroupActor, isPartyProxyGroupActor } from "../actors/group-model.js";
import { formatMoraleStatus, resetMoraleFlags } from "../actors/morale.js";
import { createPartyProxyGroupActor, createPartyProxyGroupFromActors, splitPartyProxyGroupActor } from "../actors/pc-group.js";
import { getSystemAdapter } from "../systems/system-adapter.js";

const TEMPLATE_BASE_PATH = "modules/mob-tokens/templates";

async function renderActorGrouperTemplate(templateName, data = {})
{
    const templatePath = `${TEMPLATE_BASE_PATH}/${templateName}.hbs`;
    const renderFn = foundry?.applications?.handlebars?.renderTemplate
        ?? globalThis.renderTemplate;
    if (typeof renderFn !== "function")
    {
        throw new Error("Mob Tokens could not find a template renderer.");
    }

    return renderFn(templatePath, data);
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
    const createStats = getCreateDialogStatConfig(actor);
    const content = await renderActorGrouperTemplate("dialog-create-group", {
        sourceActorName: actor.name,
        defaultGroupName: defaultName,
        defaultHP,
        folderOptions,
        showMoraleField: createStats.showMoraleField,
        defaultMorale: createStats.defaultMorale,
        showArmorClassField: createStats.showArmorClassField,
        defaultArmorClass: createStats.defaultArmorClass
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
                    const moraleValue = createStats.showMoraleField
                        ? parseOptionalNumericInput(getInputValue(html, "morale"))
                        : null;
                    const armorClassValue = createStats.showArmorClassField
                        ? parseOptionalNumericInput(getInputValue(html, "armorClass"))
                        : null;

                    await createGroupActor(actor, {
                        groupName,
                        folderId,
                        creatureCount,
                        hpPerCreature,
                        moralePath: createStats.moralePath,
                        moraleValue,
                        armorClassPath: createStats.armorClassPath,
                        armorClassValue
                    });
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

export async function openCreatePartyGroupFromActorsDialog(seedActor = null)
{
    const allActors = Array.from(game.actors?.contents ?? [])
        .filter((actor) => actor instanceof Actor)
        .filter((actor) => !isGroupActor(actor))
        .sort((left, right) => String(left.name ?? "").localeCompare(String(right.name ?? "")));

    if (allActors.length < 2)
    {
        ui.notifications?.warn(game.i18n.localize("MOBTOKENS.Errors.InvalidPartyActorSelectionCount"));
        return null;
    }

    const actorRows = allActors.map((actor) =>
    {
        const actorName = String(actor.name ?? "-");
        const escapedName = foundry.utils.escapeHTML(actorName);
        const escapedType = foundry.utils.escapeHTML(String(actor.type ?? ""));
        const checked = seedActor?.id === actor.id ? " checked" : "";
        return `
            <label class="mob-tokens-party-actor-option" data-ag="party-actor-option" data-actor-name="${foundry.utils.escapeHTML(actorName.toLowerCase())}" data-actor-type="${escapedType.toLowerCase()}">
                <input type="checkbox" name="memberActorIds" value="${actor.id}"${checked}>
                <span class="mob-tokens-party-actor-name">${escapedName}</span>
                <small class="mob-tokens-party-actor-type">(${escapedType || "actor"})</small>
            </label>
        `;
    }).join("");

    const defaultGroupName = game.i18n.format("MOBTOKENS.DialogPartyGroupDefaultName", {
        count: Math.max(seedActor ? 1 : 0, 2)
    });

    const content = `
        <form class="mob-tokens-dialog mob-tokens-token-dialog mob-tokens-party-actors-dialog">
            <div class="form-group">
                <label>${game.i18n.localize("MOBTOKENS.DialogGroupName")}</label>
                <input data-ag="create-party-group-name" type="text" name="groupName" value="${foundry.utils.escapeHTML(defaultGroupName)}" required>
            </div>
            <div class="form-group">
                <label>${game.i18n.localize("MOBTOKENS.DialogPartyActorSearch")}</label>
                <input data-ag="party-actor-filter" type="text" autocomplete="off" placeholder="${foundry.utils.escapeHTML(game.i18n.localize("MOBTOKENS.DialogPartyActorSearchPlaceholder"))}">
            </div>
            <div class="form-group mob-tokens-checkbox-group">
                <label>
                    <input data-ag="create-party-place-token" type="checkbox" name="placeTokenOnScene">
                    ${game.i18n.localize("MOBTOKENS.DialogPlacePartyTokenOnScene")}
                </label>
            </div>
            <div class="mob-tokens-party-actor-list" data-ag="party-actor-list">
                ${actorRows}
            </div>
        </form>
    `;

    return new Dialog({
        title: game.i18n.localize("MOBTOKENS.ContextCreatePartyGroup"),
        content,
        buttons: {
            create: {
                icon: "<i class=\"fas fa-check\"></i>",
                label: game.i18n.localize("MOBTOKENS.ButtonCreate"),
                callback: async (html) =>
                {
                    const groupName = String(getInputValue(html, "groupName") ?? "").trim();
                    const placeTokenOnScene = isCheckboxChecked(html, "placeTokenOnScene");

                    const root = html instanceof HTMLElement ? html : html?.[0];
                    const selectedIds = Array.from(root?.querySelectorAll?.("input[name='memberActorIds']:checked") ?? [])
                        .map((input) => String(input.value ?? ""))
                        .filter(Boolean);
                    const selectedActors = selectedIds
                        .map((id) => game.actors?.get(id))
                        .filter((actor) => actor instanceof Actor && !isGroupActor(actor));

                    if (selectedActors.length < 2)
                    {
                        ui.notifications?.warn(game.i18n.localize("MOBTOKENS.Errors.InvalidPartyActorSelectionCount"));
                        return;
                    }

                    await createPartyProxyGroupFromActors(selectedActors, {
                        groupName,
                        placeTokenOnScene
                    });
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
            const root = html instanceof HTMLElement ? html : html?.[0];
            const searchInput = root?.querySelector?.("[data-ag='party-actor-filter']");
            if (!(searchInput instanceof HTMLInputElement)) return;

            const applyFilter = () =>
            {
                const query = String(searchInput.value ?? "").trim().toLowerCase();
                const rows = Array.from(root.querySelectorAll("[data-ag='party-actor-option']"));
                for (const row of rows)
                {
                    const name = String(row.getAttribute("data-actor-name") ?? "");
                    const type = String(row.getAttribute("data-actor-type") ?? "");
                    const isMatch = !query || name.includes(query) || type.includes(query);
                    row.style.display = isMatch ? "" : "none";
                }
            };

            searchInput.addEventListener("input", applyFilter);
            applyFilter();
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
    const existingCreateParty = root.querySelector(".control-icon.mob-tokens-create-party-group");
    if (existingCreateParty) existingCreateParty.remove();
    const existingSplitParty = root.querySelector(".control-icon.mob-tokens-split-party-group");
    if (existingSplitParty) existingSplitParty.remove();

    const host = root.querySelector(".col.right") ?? root.querySelector(".right") ?? root;

    const selection = getSelectedTokenGroupingData(token);
    if (selection)
    {
        const createButton = createTokenHudControlButton({
            cssClass: "mob-tokens-create-group",
            action: "mob-tokens-create-group",
            title: game.i18n.localize("MOBTOKENS.HudCreateGroupFromSelection"),
            iconClass: "fa-people-group",
            onClick: async (event) =>
            {
                event.preventDefault();
                event.stopPropagation();
                await openCreateGroupFromTokensDialog(selection.tokens, selection.sourceActor, token, selection.totalCreatureCount);
            }
        });

        host.prepend(createButton);
    }

    const partySelection = getSelectedPartyTokenGroupingData(token);
    if (partySelection)
    {
        const createPartyButton = createTokenHudControlButton({
            cssClass: "mob-tokens-create-party-group",
            action: "mob-tokens-create-party-group",
            title: game.i18n.localize("MOBTOKENS.HudCreatePartyGroupFromSelection"),
            iconClass: "fa-users",
            onClick: async (event) =>
            {
                event.preventDefault();
                event.stopPropagation();
                await openCreatePartyGroupDialog(partySelection.tokens, token);
            }
        });

        host.prepend(createPartyButton);
    }

    const splitData = getSplitTokenGroupingData(token);
    if (splitData)
    {
        const splitButton = createTokenHudControlButton({
            cssClass: "mob-tokens-split-group",
            action: "mob-tokens-split-group",
            title: game.i18n.localize("MOBTOKENS.HudSplitGroupFromToken"),
            iconClass: "fa-code-branch",
            onClick: async (event) =>
            {
                event.preventDefault();
                event.stopPropagation();
                await openSplitGroupDialog(splitData.groupActor, {
                    placeCreatedTokens: true,
                    referenceToken: token
                });
            }
        });

        host.prepend(splitButton);
    }

    const partySplitData = getSplitPartyTokenGroupingData(token);
    if (partySplitData)
    {
        const splitPartyButton = createTokenHudControlButton({
            cssClass: "mob-tokens-split-party-group",
            action: "mob-tokens-split-party-group",
            title: game.i18n.localize("MOBTOKENS.HudSplitPartyGroupFromToken"),
            iconClass: "fa-user-group",
            onClick: async (event) =>
            {
                event.preventDefault();
                event.stopPropagation();
                await splitPartyProxyGroupActor(partySplitData.groupActor, token);
            }
        });

        host.prepend(splitPartyButton);
    }
}

function createTokenHudControlButton({ cssClass, action, title, iconClass, onClick })
{
    const button = document.createElement("div");
    button.classList.add("control-icon", cssClass);
    button.dataset.action = action;
    button.title = title;
    button.innerHTML = `<i class="fas ${iconClass}"></i>`;

    button.addEventListener("click", async (event) =>
    {
        if (typeof onClick === "function")
        {
            await onClick(event);
        }
    });

    return button;
}

function getSplitTokenGroupingData(token)
{
    const groupActor = token?.actor;
    if (!(groupActor instanceof Actor)) return null;
    if (!isGroupActor(groupActor)) return null;
    if (isPartyProxyGroupActor(groupActor)) return null;

    const flags = getGroupFlags(groupActor);
    const remainingCount = Number(flags.remainingCount) || 0;
    if (remainingCount <= 1) return null;

    return { groupActor };
}

function getSplitPartyTokenGroupingData(token)
{
    const groupActor = token?.actor;
    if (!(groupActor instanceof Actor)) return null;
    if (!isPartyProxyGroupActor(groupActor)) return null;

    const flags = getGroupFlags(groupActor);
    const members = Array.isArray(flags.memberTokens) ? flags.memberTokens : [];
    if (members.length <= 1) return null;

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
    const createStats = getCreateDialogStatConfig(sourceActor);
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
        folderOptions,
        showMoraleField: createStats.showMoraleField,
        defaultMorale: createStats.defaultMorale,
        showArmorClassField: createStats.showArmorClassField,
        defaultArmorClass: createStats.defaultArmorClass
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
                    const moraleValue = createStats.showMoraleField
                        ? parseOptionalNumericInput(getInputValue(html, "morale"))
                        : null;
                    const armorClassValue = createStats.showArmorClassField
                        ? parseOptionalNumericInput(getInputValue(html, "armorClass"))
                        : null;

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
                            moralePath: createStats.moralePath,
                            moraleValue,
                            armorClassPath: createStats.armorClassPath,
                            armorClassValue,
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

async function openCreatePartyGroupDialog(selectedTokens, referenceToken)
{
    const tokenCount = Array.isArray(selectedTokens) ? selectedTokens.length : 0;
    if (tokenCount < 2)
    {
        ui.notifications?.warn(game.i18n.localize("MOBTOKENS.Errors.InvalidTokenSelectionCount"));
        return null;
    }

    const defaultGroupName = game.i18n.format("MOBTOKENS.DialogPartyGroupDefaultName", { count: tokenCount });
    const content = `
        <form class="mob-tokens-dialog mob-tokens-token-dialog">
            <div class="form-group">
                <label>${game.i18n.localize("MOBTOKENS.DialogSelectedTokenCount")}</label>
                <input type="number" value="${tokenCount}" disabled>
            </div>
            <div class="form-group">
                <label>${game.i18n.localize("MOBTOKENS.DialogGroupName")}</label>
                <input data-ag="create-party-group-name" type="text" name="groupName" value="${foundry.utils.escapeHTML(defaultGroupName)}" required>
            </div>
            <div class="form-group mob-tokens-checkbox-group">
                <label>
                    <input data-ag="create-party-replace-selected-tokens" type="checkbox" name="replaceSelectedTokens" checked>
                    ${game.i18n.localize("MOBTOKENS.DialogReplaceSelectedTokens")}
                </label>
            </div>
        </form>
    `;

    return new Dialog({
        title: game.i18n.localize("MOBTOKENS.HudCreatePartyGroupFromSelection"),
        content,
        buttons: {
            create: {
                icon: "<i class=\"fas fa-check\"></i>",
                label: game.i18n.localize("MOBTOKENS.ButtonCreate"),
                callback: async (html) =>
                {
                    const groupName = String(getInputValue(html, "groupName") ?? "").trim();
                    const replaceSelectedTokens = isCheckboxChecked(html, "replaceSelectedTokens");

                    await createPartyProxyGroupActor(selectedTokens, {
                        groupName,
                        replaceSelectedTokens,
                        referenceToken
                    });
                }
            },
            cancel: {
                icon: "<i class=\"fas fa-times\"></i>",
                label: game.i18n.localize("MOBTOKENS.ButtonCancel")
            }
        },
        default: "create"
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

function getSelectedPartyTokenGroupingData(token)
{
    const selected = canvas?.tokens?.controlled ?? [];
    const tokens = selected.length > 0
        ? selected
        : (token ? [token] : []);

    if (tokens.length < 2) return null;

    const tokenActors = tokens.map((entry) => entry?.actor);
    if (!tokenActors.every((actor) => actor instanceof Actor)) return null;
    if (tokenActors.some((actor) => isGroupActor(actor))) return null;

    return {
        tokens
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
    const showMorale = shouldDisplayMoraleUI();
    const panel = await renderActorGrouperTemplate("group-panel", {
        sourceActorName: flags.sourceActorName ?? "-",
        creatureCount: Number(flags.creatureCount) || 0,
        remainingCount: Number(flags.remainingCount) || 0,
        hpPerCreature: Number(flags.hpPerCreature) || 0,
        maxGroupHP: Number(flags.maxGroupHP) || 0,
        currentGroupHP: Number(flags.currentGroupHP) || 0,
        moraleStatus: formatMoraleStatus(flags),
        isGM: Boolean(game.user?.isGM),
        showMorale
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
    const panel = root?.querySelector?.(".mob-tokens-panel");
    if (!panel) return;

    const moraleButton = panel.querySelector(".mob-tokens-reset-morale");
    if (moraleButton && moraleButton.dataset.actorGrouperBound !== "1")
    {
        moraleButton.dataset.actorGrouperBound = "1";
        moraleButton.addEventListener("click", async (event) =>
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

    const hpInput = panel.querySelector(".mob-tokens-current-hp-input");
    if (hpInput && hpInput.dataset.actorGrouperBound !== "1")
    {
        hpInput.dataset.actorGrouperBound = "1";
        hpInput.addEventListener("focus", (event) =>
        {
            event.currentTarget?.select?.();
        });

        hpInput.addEventListener("blur", async () =>
        {
            await applyCurrentHPFromPanel(actor, panel);
        });

        hpInput.addEventListener("keydown", async (event) =>
        {
            if (event.key !== "Enter") return;
            event.preventDefault();
            await applyCurrentHPFromPanel(actor, panel);
        });
    }
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
    setPanelInput(panel, "currentGroupHP", Number(flags.currentGroupHP) || 0);
    setPanelField(panel, "moraleStatus", formatMoraleStatus(flags));

    const showMorale = shouldDisplayMoraleUI();
    const moraleRow = panel.querySelector("[data-ag-section='morale-row']");
    if (moraleRow instanceof HTMLElement)
    {
        moraleRow.style.display = showMorale ? "" : "none";
    }

    const moraleActions = panel.querySelector("[data-ag-section='morale-actions']");
    if (moraleActions instanceof HTMLElement)
    {
        moraleActions.style.display = showMorale ? "" : "none";
    }
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

function setPanelInput(panel, fieldName, value)
{
    const input = panel.querySelector(`[data-ag-input='${fieldName}']`);
    if (!(input instanceof HTMLInputElement)) return;
    input.value = String(value ?? "");
}

async function applyCurrentHPFromPanel(actor, panel)
{
    if (!game.user?.isGM) return;
    if (panel?.dataset?.mobTokensUpdatingCurrentHp === "1") return;

    const hpInput = panel?.querySelector?.(".mob-tokens-current-hp-input");
    if (!(hpInput instanceof HTMLInputElement)) return;

    const flags = getGroupFlags(actor);
    const existingCurrentHP = Math.max(Number(flags.currentGroupHP) || 0, 0);
    const maxGroupHP = Math.max(Number(flags.maxGroupHP) || 0, 0);
    const requestedHP = parseCurrentHPInput(hpInput.value, existingCurrentHP);
    if (!Number.isFinite(requestedHP))
    {
        ui.notifications?.error(game.i18n.localize("MOBTOKENS.Errors.InvalidCurrentHP"));
        refreshOpenGroupPanels(actor);
        return;
    }

    const currentGroupHP = clampNumber(requestedHP, 0, maxGroupHP);
    if (Number(flags.currentGroupHP) === currentGroupHP)
    {
        refreshOpenGroupPanels(actor);
        return;
    }

    const hpPaths = getHitPointPaths(actor.system ?? {});
    const updates = {};
    if (hpPaths)
    {
        updates[hpPaths.current] = currentGroupHP;
    }
    else
    {
        updates[`flags.${FLAG_SCOPE}.currentGroupHP`] = currentGroupHP;
    }

    panel.dataset.mobTokensUpdatingCurrentHp = "1";
    try
    {
        await actor.update(updates);
    }
    finally
    {
        panel.dataset.mobTokensUpdatingCurrentHp = "0";
    }
}

function parseCurrentHPInput(rawValue, baseValue)
{
    const value = String(rawValue ?? "").trim();
    if (!value) return Number.NaN;

    const deltaMatch = value.match(/^([+-])\s*(\d+(?:\.\d+)?)$/);
    if (deltaMatch)
    {
        const delta = Number(deltaMatch[2]);
        if (!Number.isFinite(delta)) return Number.NaN;
        return deltaMatch[1] === "-"
            ? Number(baseValue) - delta
            : Number(baseValue) + delta;
    }

    return Number(value);
}

function shouldDisplayMoraleUI()
{
    try
    {
        const enabledSetting = Boolean(game.settings.get(FLAG_SCOPE, "enableMoraleCheck"));
        return getSystemAdapter().shouldShowMoraleUI(enabledSetting);
    }
    catch (_error)
    {
        return false;
    }
}

export async function createGroupActor(sourceActor, {
    groupName,
    folderId,
    creatureCount,
    hpPerCreature,
    initialCurrentHP,
    moralePath,
    moraleValue,
    armorClassPath,
    armorClassValue,
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
        groupMode: GROUP_MODE_MOB,
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
    applyOptionalActorNumericOverride(actorData, moralePath, moraleValue);
    applyOptionalActorNumericOverride(actorData, armorClassPath, armorClassValue);

    const createdActor = await Actor.create(actorData, { renderSheet });

    if (notify)
    {
        ui.notifications?.info(game.i18n.format("MOBTOKENS.Notifications.GroupCreated", {
            name: createdActor.name
        }));
    }
    return createdActor;
}

function getCreateDialogStatConfig(actor)
{
    const adapter = getSystemAdapter();
    const moralePath = resolveFirstNumericPath(actor, adapter.moralePathCandidates);
    const armorClassPath = resolveFirstNumericPath(actor, adapter.acPathCandidates);

    return {
        showMoraleField: Boolean(moralePath),
        moralePath,
        defaultMorale: resolveNumericValue(actor, moralePath, adapter.defaultMoraleValue ?? 50),
        showArmorClassField: Boolean(armorClassPath),
        armorClassPath,
        defaultArmorClass: resolveNumericValue(actor, armorClassPath, adapter.defaultArmorClassValue ?? 10)
    };
}

function resolveFirstNumericPath(actor, candidatePaths)
{
    if (!actor || !Array.isArray(candidatePaths)) return null;

    for (const path of candidatePaths)
    {
        const value = foundry.utils.getProperty(actor, path);
        if (Number.isFinite(parseNumericLike(value))) return path;
    }

    return null;
}

function resolveNumericValue(actor, path, fallback)
{
    if (path)
    {
        const value = parseNumericLike(foundry.utils.getProperty(actor, path));
        if (Number.isFinite(value)) return value;
    }

    return parseNumericLike(fallback);
}

function parseOptionalNumericInput(value)
{
    if (value === null || value === undefined) return null;
    const trimmed = String(value).trim();
    if (!trimmed) return null;

    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
}

function applyOptionalActorNumericOverride(target, path, value)
{
    if (!path) return;
    if (!Number.isFinite(Number(value))) return;
    foundry.utils.setProperty(target, path, Number(value));
}

function parseNumericLike(value)
{
    const direct = Number(value);
    if (Number.isFinite(direct)) return direct;

    const raw = String(value ?? "").trim();
    const match = raw.match(/-?\d+(?:\.\d+)?/);
    if (!match) return Number.NaN;

    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
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
