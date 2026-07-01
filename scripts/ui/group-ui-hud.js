import { clampNumber, getInputValue, getRootElement } from "../core/helpers.js";
import { createWallAwareTokenDataForActors } from "../core/token-placement.js";
import { formatGroupName, getDefaultHPPerCreature, getGroupFlags, getHitPointPaths, isGroupActor, isPartyProxyGroupActor } from "../actors/group-model.js";
import { createPartyProxyGroupActor, splitPartyProxyGroupActor } from "../actors/pc-group.js";
import { createGroupActor } from "./group-ui-actors.js";
import { openSplitGroupDialog } from "./group-ui-dialogs.js";
import { applyOptionalActorNumericOverride, distributeHPAcrossSplits, getActorFolderOptions, getCreateDialogStatConfig, getFolderIdFromInput, parseOptionalNumericInput, parseSplitCounts, suggestSplitCounts } from "./group-ui-data-utils.js";
import { getDialogContentRoot, getNamedInput, isCheckboxChecked, openDialogCompat, renderActorGrouperTemplate } from "./group-ui-dialog-utils.js";

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

    return openDialogCompat({
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
            const root = getDialogContentRoot(html);
            const nameInput = getNamedInput(root, "groupName");
            const countInput = getNamedInput(root, "creatureCount");
            const resultGroupCountInput = getNamedInput(root, "resultGroupCount");
            const groupCountsInput = getNamedInput(root, "groupCounts");
            if (!(nameInput instanceof HTMLInputElement)
                || !(countInput instanceof HTMLInputElement)
                || !(resultGroupCountInput instanceof HTMLInputElement)
                || !(groupCountsInput instanceof HTMLInputElement)) return;
            let nameDirty = false;

            nameInput.addEventListener("input", () =>
            {
                nameDirty = true;
            });

            const refreshGroupCounts = () =>
            {
                const total = Math.max(Number(countInput.value) || 1, 1);
                const requestedGroups = Math.max(Number(resultGroupCountInput.value) || 1, 1);
                const normalizedGroups = clampNumber(Math.round(requestedGroups), 1, total);
                resultGroupCountInput.value = String(normalizedGroups);
                if (normalizedGroups <= 1)
                {
                    groupCountsInput.value = String(total);
                    return;
                }

                groupCountsInput.value = suggestSplitCounts(total, normalizedGroups);
            };

            countInput.addEventListener("change", () =>
            {
                const count = Math.max(Number(countInput.value) || 1, 1);
                if (!nameDirty)
                {
                    nameInput.value = formatGroupName(sourceActor.name, count);
                }
                refreshGroupCounts();
            });

            resultGroupCountInput.addEventListener("change", () =>
            {
                refreshGroupCounts();
            });

            refreshGroupCounts();
            countInput.focus();
        }
    });
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

    return openDialogCompat({
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
    });
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

    const createdTokenData = await createWallAwareTokenDataForActors(groupActors, {
        anchorDocument,
        includeAnchorSlot: true
    });

    if (createdTokenData.length > 0)
    {
        await scene.createEmbeddedDocuments("Token", createdTokenData);
    }

    const deleteIds = Array.from(new Set(
        selectedTokens
            .map((entry) => entry?.document?.id)
            .filter(Boolean)
    )).filter((id) => scene?.tokens?.has(id));

    if (deleteIds.length > 0)
    {
        await scene.deleteEmbeddedDocuments("Token", deleteIds);
    }
}
