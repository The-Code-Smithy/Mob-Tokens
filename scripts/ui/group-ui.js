import { FLAG_SCOPE, GROUP_MODE_MOB } from "../core/constants.js";
import { clampNumber, getInputValue, getRootElement } from "../core/helpers.js";
import { createWallAwareTokenDataForActors } from "../core/token-placement.js";
import { applyHPUpdate, calculateRemainingCount, formatGroupName, getDefaultHPPerCreature, getGroupFlags, getHitPointPaths, isGroupActor, isPartyProxyGroupActor } from "../actors/group-model.js";
import { formatMoraleStatus, resetMoraleFlags } from "../actors/morale.js";
import { createPartyProxyGroupActor, createPartyProxyGroupFromActors, getPartyProxyMemberActors, setPartyProxyMemberActors, splitPartyProxyGroupActor } from "../actors/pc-group.js";
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

function getNamedInput(root, name)
{
    return root?.querySelector?.(`[name='${name}']`) ?? null;
}

function getDialogContentRoot(dialogLike)
{
    const host = dialogLike?.element ?? dialogLike;
    const root = getRootElement(host);
    if (!root) return null;
    return root.querySelector("form") ?? root;
}

function openDialogCompat(config)
{
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2)
    {
        throw new Error("Mob Tokens requires foundry.applications.api.DialogV2 for dialog rendering.");
    }

    const buttons = Object.entries(config?.buttons ?? {}).map(([action, buttonConfig]) => ({
        action,
        label: buttonConfig?.label,
        icon: buttonConfig?.icon,
        default: action === config?.default,
        callback: async (event, button, dialog) =>
        {
            if (typeof buttonConfig?.callback !== "function") return;
            const root = getDialogContentRoot(dialog);
            await buttonConfig.callback(root ?? dialog, event, button, dialog);
        }
    }));

    const dialog = new DialogV2({
        window: {
            title: config?.title ?? ""
        },
        content: config?.content ?? "",
        buttons,
        close: config?.close
    });

    if (typeof config?.render === "function")
    {
        const hookId = Hooks.on("renderDialogV2", (app) =>
        {
            if (app !== dialog) return;
            Hooks.off("renderDialogV2", hookId);
            const root = getDialogContentRoot(dialog);
            config.render(root ?? dialog);
        });
    }

    dialog.render(true);
    return dialog;
}

function isLikelyPlayerCharacter(actor)
{
    const actorType = String(actor?.type ?? "").trim().toLowerCase();
    if (actorType === "character" || actorType === "pc" || actorType === "player") return true;
    if (actorType === "npc" || actorType === "monster") return false;
    return Boolean(actor?.hasPlayerOwner);
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

    return openDialogCompat({
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
            const root = getDialogContentRoot(html);
            const nameInput = getNamedInput(root, "groupName");
            const countInput = getNamedInput(root, "creatureCount");
            if (!(nameInput instanceof HTMLInputElement) || !(countInput instanceof HTMLInputElement)) return;
            let nameDirty = false;

            nameInput.addEventListener("input", () =>
            {
                nameDirty = true;
            });

            countInput.addEventListener("change", () =>
            {
                if (nameDirty) return;
                const count = Math.max(Number(countInput.value) || 1, 1);
                nameInput.value = formatGroupName(actor.name, count);
            });

            countInput.focus();
        }
    });
}

export async function openCreatePartyGroupFromActorsDialog(seedActor = null, preselectedActorIds = null)
{
    const preselectedSet = new Set(
        Array.isArray(preselectedActorIds)
            ? preselectedActorIds.map((id) => String(id ?? "")).filter(Boolean)
            : []
    );

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
        const isPlayerCharacter = isLikelyPlayerCharacter(actor);
        const isNonPlayerCharacter = !isPlayerCharacter;
        const shouldCheck = preselectedSet.has(String(actor.id ?? "")) || seedActor?.id === actor.id;
        const checked = shouldCheck ? " checked" : "";
        return `
            <label class="mob-tokens-party-actor-option" data-ag="party-actor-option" data-actor-name="${foundry.utils.escapeHTML(actorName.toLowerCase())}" data-actor-type="${escapedType.toLowerCase()}" data-actor-is-pc="${isPlayerCharacter ? "1" : "0"}" data-actor-is-npc="${isNonPlayerCharacter ? "1" : "0"}">
                <input type="checkbox" name="memberActorIds" value="${actor.id}"${checked}>
                <span class="mob-tokens-party-actor-name">${escapedName}</span>
                <small class="mob-tokens-party-actor-type">(${escapedType || "actor"})</small>
            </label>
        `;
    }).join("");

    const defaultSelectedCount = allActors.reduce((count, actor) =>
    {
        const isSelected = preselectedSet.has(String(actor.id ?? "")) || seedActor?.id === actor.id;
        return isSelected ? count + 1 : count;
    }, 0);
    const defaultGroupName = game.i18n.format("MOBTOKENS.DialogPartyGroupDefaultName", {
        count: Math.max(defaultSelectedCount, 2)
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
            <div class="form-group mob-tokens-checkbox-group mob-tokens-party-filter-options">
                <label>
                    <input data-ag="party-filter-pc" type="checkbox" name="showOnlyPlayerCharacters">
                    ${game.i18n.localize("MOBTOKENS.DialogPartyFilterOnlyPlayerCharacters")}
                </label>
                <label>
                    <input data-ag="party-filter-npc" type="checkbox" name="showOnlyNonPlayerCharacters">
                    ${game.i18n.localize("MOBTOKENS.DialogPartyFilterOnlyNonPlayerCharacters")}
                </label>
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

    return openDialogCompat({
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
            const playerCharacterFilter = root?.querySelector?.("[data-ag='party-filter-pc']");
            const nonPlayerCharacterFilter = root?.querySelector?.("[data-ag='party-filter-npc']");
            if (!(searchInput instanceof HTMLInputElement)) return;
            if (!(playerCharacterFilter instanceof HTMLInputElement)) return;
            if (!(nonPlayerCharacterFilter instanceof HTMLInputElement)) return;

            const applyFilter = () =>
            {
                const query = String(searchInput.value ?? "").trim().toLowerCase();
                const showOnlyPlayerCharacters = playerCharacterFilter.checked;
                const showOnlyNonPlayerCharacters = nonPlayerCharacterFilter.checked;
                const rows = Array.from(root.querySelectorAll("[data-ag='party-actor-option']"));
                for (const row of rows)
                {
                    const name = String(row.getAttribute("data-actor-name") ?? "");
                    const type = String(row.getAttribute("data-actor-type") ?? "");
                    const isPlayerCharacter = row.getAttribute("data-actor-is-pc") === "1";
                    const isNonPlayerCharacter = row.getAttribute("data-actor-is-npc") === "1";
                    const matchesQuery = !query || name.includes(query) || type.includes(query);

                    let matchesTypeFilter = true;
                    if (showOnlyPlayerCharacters || showOnlyNonPlayerCharacters)
                    {
                        matchesTypeFilter = (showOnlyPlayerCharacters && isPlayerCharacter)
                            || (showOnlyNonPlayerCharacters && isNonPlayerCharacter);
                    }

                    row.style.display = (matchesQuery && matchesTypeFilter) ? "" : "none";
                }
            };

            searchInput.addEventListener("input", applyFilter);
            playerCharacterFilter.addEventListener("change", applyFilter);
            nonPlayerCharacterFilter.addEventListener("change", applyFilter);
            applyFilter();
        }
    });
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

    return openDialogCompat({
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
            const root = getDialogContentRoot(html);
            const inputCount = getNamedInput(root, "splitGroupCount");
            const inputCounts = getNamedInput(root, "splitCounts");
            const inputSplitIndividuals = getNamedInput(root, "splitIndividuals");
            if (!(inputCount instanceof HTMLInputElement)
                || !(inputCounts instanceof HTMLInputElement)
                || !(inputSplitIndividuals instanceof HTMLInputElement)) return;

            const setIndividualsMode = (isIndividuals) =>
            {
                if (isIndividuals)
                {
                    inputCount.value = String(totalCount);
                    inputCounts.value = Array.from({ length: totalCount }, () => 1).join(", ");
                    inputCount.disabled = true;
                    inputCounts.disabled = true;
                    return;
                }

                inputCount.disabled = false;
                inputCounts.disabled = false;
                const requestedGroups = Number(inputCount.value) || defaultGroups;
                const normalizedGroups = clampNumber(Math.round(requestedGroups), 2, totalCount);
                inputCount.value = String(normalizedGroups);
                inputCounts.value = suggestSplitCounts(totalCount, normalizedGroups);
            };

            inputCount.addEventListener("change", () =>
            {
                if (inputSplitIndividuals.checked) return;
                const requestedGroups = Number(inputCount.value) || defaultGroups;
                const normalizedGroups = clampNumber(Math.round(requestedGroups), 2, totalCount);
                inputCount.value = String(normalizedGroups);
                inputCounts.value = suggestSplitCounts(totalCount, normalizedGroups);
            });

            inputSplitIndividuals.addEventListener("change", () =>
            {
                setIndividualsMode(inputSplitIndividuals.checked);
            });

            setIndividualsMode(false);
            inputCount.focus();
        }
    });
}

export async function showQuickStartPrompt()
{
    const content = await renderActorGrouperTemplate("help-quick-start-prompt");

    openDialogCompat({
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
    });
}

export async function showQuickStartGuide()
{
    const content = await renderActorGrouperTemplate("help-quick-start-guide");

    openDialogCompat({
        title: game.i18n.localize("MOBTOKENS.HelpGuideTitle"),
        content,
        buttons: {
            close: {
                icon: "<i class=\"fas fa-check\"></i>",
                label: game.i18n.localize("MOBTOKENS.ButtonClose")
            }
        },
        default: "close"
    });
}

export async function injectGroupPanel(actor, html)
{
    const root = getRootElement(html);
    if (!root) return;
    const isPartyProxy = isPartyProxyGroupActor(actor);
    if (!isPartyProxy && root.querySelector(".mob-tokens-panel"))
    {
        refreshGroupPanel(actor, root);
        return;
    }

    const flags = getGroupFlags(actor);
    const showMorale = shouldDisplayMoraleUI();
    const panel = isPartyProxy
        ? await renderActorGrouperTemplate("group-panel-party", buildPartyPanelData(actor))
        : await renderActorGrouperTemplate("group-panel", {
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

    if (isPartyProxy)
    {
        root.querySelectorAll(".mob-tokens-panel").forEach((node) => node.remove());
        // Party proxies use a dedicated management layout instead of the base system sheet.
        target.innerHTML = "";
        target.append(panelElement);
        root.classList.add("mob-tokens-party-sheet-layout");
    }
    else
    {
        root.classList.remove("mob-tokens-party-sheet-layout");
        target.prepend(panelElement);
    }

    refreshGroupPanel(actor, root);
}

export function wireGroupPanelActions(actor, html)
{
    const root = getRootElement(html);
    const panel = root?.querySelector?.(".mob-tokens-panel");
    if (!panel) return;

    if (isPartyProxyGroupActor(actor))
    {
        wirePartyProxyPanelActions(actor, panel);
        return;
    }

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

    if (isPartyProxyGroupActor(actor))
    {
        refreshPartyProxyPanel(actor, panel);
        return;
    }

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

function buildPartyPanelData(actor)
{
    const flags = getGroupFlags(actor);
    const members = getPartyProxyMemberActors(actor).map((memberActor) => buildPartyMemberDisplayData(memberActor));

    return {
        sourceActorName: flags.sourceActorName ?? "-",
        creatureCount: Number(flags.creatureCount) || members.length,
        remainingCount: Number(flags.remainingCount) || members.length,
        isGM: Boolean(game.user?.isGM),
        hasMembers: members.length > 0,
        members
    };
}

function buildPartyMemberDisplayData(memberActor)
{
    const hpPaths = getHitPointPaths(memberActor.system ?? {});
    const hpCurrent = hpPaths ? (Number(foundry.utils.getProperty(memberActor, hpPaths.current)) || 0) : 0;
    const hpMax = hpPaths ? (Number(foundry.utils.getProperty(memberActor, hpPaths.max)) || 0) : 0;

    const acPath = resolveFirstNumericPath(memberActor, getSystemAdapter().acPathCandidates);
    const acValue = Number.isFinite(Number(foundry.utils.getProperty(memberActor, acPath)))
        ? Number(foundry.utils.getProperty(memberActor, acPath))
        : "-";

    const conditions = (memberActor.effects ?? [])
        .filter((effect) => !effect?.disabled && !effect?.isSuppressed)
        .map((effect) => String(effect?.name ?? effect?.label ?? "").trim())
        .filter(Boolean)
        .join(", ") || "-";

    const hpPercent = hpMax > 0
        ? clampNumber((hpCurrent / hpMax) * 100, 0, 100)
        : 0;

    return {
        actorId: String(memberActor.id ?? ""),
        img: memberActor.prototypeToken?.texture?.src || memberActor.img || "icons/svg/mystery-man.svg",
        name: String(memberActor.name ?? "-"),
        hpCurrent,
        hpMax,
        hpPercent,
        ac: acValue,
        conditions
    };
}

function refreshPartyProxyPanel(actor, panel)
{
    const flags = getGroupFlags(actor);
    setPanelField(panel, "creatureCount", Number(flags.creatureCount) || 0);
    setPanelField(panel, "remainingCount", Number(flags.remainingCount) || 0);

    const membersHost = panel.querySelector("[data-ag-section='party-members']");
    if (!(membersHost instanceof HTMLElement)) return;

    const members = getPartyProxyMemberActors(actor).map((memberActor) => buildPartyMemberDisplayData(memberActor));
    if (members.length < 1)
    {
        membersHost.innerHTML = `<div class="mob-tokens-party-member-empty">${foundry.utils.escapeHTML(game.i18n.localize("MOBTOKENS.PanelPartyNoMembers"))}</div>`;
        return;
    }

    const removeLabel = foundry.utils.escapeHTML(game.i18n.localize("MOBTOKENS.ButtonRemove"));
    membersHost.innerHTML = members.map((member) => `
        <div class="mob-tokens-party-member-row" data-ag-party-member-row="${foundry.utils.escapeHTML(member.actorId)}">
            <img class="mob-tokens-party-member-portrait" src="${foundry.utils.escapeHTML(member.img)}" alt="${foundry.utils.escapeHTML(member.name)}">
            <div class="mob-tokens-party-member-main">
                <div class="mob-tokens-party-member-name">${foundry.utils.escapeHTML(member.name)}</div>
                <div class="mob-tokens-party-member-hpbar" aria-label="HP ${member.hpCurrent}/${member.hpMax}">
                    <div class="mob-tokens-party-member-hpfill" style="width: ${member.hpPercent}%;"></div>
                </div>
                <div class="mob-tokens-party-member-meta">HP ${member.hpCurrent}/${member.hpMax} | AC ${member.ac} | ${foundry.utils.escapeHTML(member.conditions)}</div>
            </div>
            ${game.user?.isGM ? `<button type="button" class="mob-tokens-party-member-remove mob-tokens-button" data-ag-action="remove-party-member" data-ag-actor-id="${foundry.utils.escapeHTML(member.actorId)}">${removeLabel}</button>` : ""}
        </div>
    `).join("");

    wirePartyProxyPanelActions(actor, panel);
}

function wirePartyProxyPanelActions(actor, panel)
{
    const consumeDropEvent = (event) =>
    {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
    };

    const dropZones = [
        panel.querySelector("[data-ag-section='party-dropzone']"),
        panel.querySelector("[data-ag-section='party-members']")
    ].filter((element) => element instanceof HTMLElement);

    for (const dropZone of dropZones)
    {
        if (dropZone.dataset.actorGrouperDropBound === "1") continue;
        dropZone.dataset.actorGrouperDropBound = "1";

        const clearDropTarget = () =>
        {
            dropZone.classList.remove("is-drop-target");
        };

        dropZone.addEventListener("dragover", (event) =>
        {
            if (!game.user?.isGM) return;
            consumeDropEvent(event);
            event.dataTransfer.dropEffect = "copy";
            dropZone.classList.add("is-drop-target");
        }, true);

        dropZone.addEventListener("dragenter", (event) =>
        {
            if (!game.user?.isGM) return;
            consumeDropEvent(event);
            dropZone.classList.add("is-drop-target");
        }, true);

        dropZone.addEventListener("dragleave", (event) =>
        {
            if (game.user?.isGM) consumeDropEvent(event);
            clearDropTarget();
        }, true);

        dropZone.addEventListener("drop", async (event) =>
        {
            if (!game.user?.isGM) return;
            consumeDropEvent(event);
            clearDropTarget();

            const droppedActors = await getDroppedActorsFromEvent(event);
            if (droppedActors.length < 1)
            {
                ui.notifications?.warn(game.i18n.localize("MOBTOKENS.Errors.PartyDropActorsOnly"));
                return;
            }

            const currentMembers = getPartyProxyMemberActors(actor);
            const existingIds = new Set(currentMembers.map((memberActor) => String(memberActor.id ?? "")));
            const actorsToAdd = droppedActors.filter((memberActor) =>
                memberActor instanceof Actor
                && !isGroupActor(memberActor)
                && !existingIds.has(String(memberActor.id ?? ""))
            );

            if (actorsToAdd.length < 1)
            {
                ui.notifications?.warn(game.i18n.localize("MOBTOKENS.Errors.PartyDropNoNewMembers"));
                return;
            }

            const nextMembers = [...currentMembers, ...actorsToAdd];
            const updated = await setPartyProxyMemberActors(actor, nextMembers);
            if (!updated) return;

            ui.notifications?.info(game.i18n.format("MOBTOKENS.Notifications.PartyMembersAdded", {
                count: actorsToAdd.length
            }));
            refreshOpenGroupPanels(actor);
        }, true);
    }

    const addButton = panel.querySelector("[data-ag-action='add-party-members']");
    if (addButton && addButton.dataset.actorGrouperBound !== "1")
    {
        addButton.dataset.actorGrouperBound = "1";
        addButton.addEventListener("click", async (event) =>
        {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            if (!game.user?.isGM) return;
            await openAddPartyMembersDialog(actor);
        });
    }

    const removeButtons = panel.querySelectorAll("[data-ag-action='remove-party-member']");
    for (const button of removeButtons)
    {
        if (button.dataset.actorGrouperBound === "1") continue;
        button.dataset.actorGrouperBound = "1";
        button.addEventListener("click", async (event) =>
        {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            if (!game.user?.isGM) return;

            const actorId = String(button.getAttribute("data-ag-actor-id") ?? "").trim();
            if (!actorId) return;

            const currentMembers = getPartyProxyMemberActors(actor);
            const nextMembers = currentMembers.filter((memberActor) => String(memberActor.id) !== actorId);
            if (nextMembers.length < 1)
            {
                ui.notifications?.warn(game.i18n.localize("MOBTOKENS.Errors.PartyGroupNeedsOneMember"));
                return;
            }

            const updated = await setPartyProxyMemberActors(actor, nextMembers);
            if (!updated) return;
            refreshOpenGroupPanels(actor);
        });
    }
}

async function getDroppedActorsFromEvent(event)
{
    const data = getDragDataFromEvent(event);
    if (!data) return [];

    if (Array.isArray(data))
    {
        const resolved = [];
        for (const entry of data)
        {
            const actor = await resolveActorFromDragData(entry);
            if (actor instanceof Actor) resolved.push(actor);
        }
        return uniqueActors(resolved);
    }

    const single = await resolveActorFromDragData(data);
    return single instanceof Actor ? [single] : [];
}

function getDragDataFromEvent(event)
{
    try
    {
        const textEditorImpl = foundry?.applications?.ux?.TextEditor?.implementation;
        const dragData = textEditorImpl?.getDragEventData?.(event);
        if (dragData && Object.keys(dragData).length > 0) return dragData;
    }
    catch (_error)
    {
        // Fall through to manual parsing.
    }

    const plain = event?.dataTransfer?.getData?.("text/plain")
        || event?.dataTransfer?.getData?.("application/json")
        || "";
    if (!plain) return null;

    try
    {
        return JSON.parse(plain);
    }
    catch (_error)
    {
        return null;
    }
}

async function resolveActorFromDragData(data)
{
    if (!data || typeof data !== "object") return null;

    const type = String(data.type ?? "").toLowerCase();
    const directId = String(data.actorId ?? data.id ?? "").trim();
    if ((type === "actor" || !type) && directId)
    {
        const actor = game.actors?.get(directId);
        if (actor instanceof Actor) return actor;
    }

    const uuid = String(data.uuid ?? data.documentUuid ?? "").trim();
    if (uuid)
    {
        try
        {
            const document = await fromUuid(uuid);
            if (document instanceof Actor) return document;
        }
        catch (_error)
        {
            return null;
        }
    }

    return null;
}

function uniqueActors(actors)
{
    const byId = new Map();
    for (const actor of actors)
    {
        if (!(actor instanceof Actor)) continue;
        byId.set(String(actor.id ?? ""), actor);
    }
    return Array.from(byId.values());
}

async function openAddPartyMembersDialog(groupActor)
{
    const existingMembers = getPartyProxyMemberActors(groupActor);
    const existingIds = new Set(existingMembers.map((actor) => String(actor.id)));
    const candidates = Array.from(game.actors?.contents ?? [])
        .filter((actor) => actor instanceof Actor)
        .filter((actor) => !isGroupActor(actor))
        .filter((actor) => !existingIds.has(String(actor.id)));

    if (candidates.length < 1)
    {
        ui.notifications?.warn(game.i18n.localize("MOBTOKENS.Errors.PartyGroupNoEligibleMembersToAdd"));
        return;
    }

    const rows = candidates.map((actor) => `
        <label class="mob-tokens-party-actor-option" data-ag="party-actor-option" data-actor-name="${foundry.utils.escapeHTML(String(actor.name ?? "").toLowerCase())}" data-actor-type="${foundry.utils.escapeHTML(String(actor.type ?? "").toLowerCase())}">
            <input type="checkbox" name="memberActorIds" value="${foundry.utils.escapeHTML(String(actor.id ?? ""))}">
            <span class="mob-tokens-party-actor-name">${foundry.utils.escapeHTML(String(actor.name ?? "-"))}</span>
            <small class="mob-tokens-party-actor-type">(${foundry.utils.escapeHTML(String(actor.type ?? "actor"))})</small>
        </label>
    `).join("");

    const content = `
        <form class="mob-tokens-dialog mob-tokens-token-dialog mob-tokens-party-actors-dialog">
            <div class="form-group">
                <label>${game.i18n.localize("MOBTOKENS.DialogPartyActorSearch")}</label>
                <input data-ag="party-actor-filter" type="text" autocomplete="off" placeholder="${foundry.utils.escapeHTML(game.i18n.localize("MOBTOKENS.DialogPartyActorSearchPlaceholder"))}">
            </div>
            <div class="mob-tokens-party-actor-list" data-ag="party-actor-list">
                ${rows}
            </div>
        </form>
    `;

    openDialogCompat({
        title: game.i18n.localize("MOBTOKENS.DialogAddPartyMembersTitle"),
        content,
        buttons: {
            add: {
                icon: "<i class=\"fas fa-plus\"></i>",
                label: game.i18n.localize("MOBTOKENS.ButtonAddMembers"),
                callback: async (html) =>
                {
                    const root = html instanceof HTMLElement ? html : html?.[0];
                    const selectedIds = Array.from(root?.querySelectorAll?.("input[name='memberActorIds']:checked") ?? [])
                        .map((input) => String(input.value ?? ""))
                        .filter(Boolean);
                    if (selectedIds.length < 1) return;

                    const selectedActors = selectedIds
                        .map((id) => game.actors?.get(id))
                        .filter((actor) => actor instanceof Actor && !isGroupActor(actor));
                    if (selectedActors.length < 1) return;

                    const mergedMembers = [...existingMembers, ...selectedActors];
                    const updated = await setPartyProxyMemberActors(groupActor, mergedMembers);
                    if (!updated) return;

                    ui.notifications?.info(game.i18n.format("MOBTOKENS.Notifications.PartyMembersAdded", {
                        count: selectedActors.length
                    }));
                    refreshOpenGroupPanels(groupActor);
                }
            },
            cancel: {
                icon: "<i class=\"fas fa-times\"></i>",
                label: game.i18n.localize("MOBTOKENS.ButtonCancel")
            }
        },
        default: "add",
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
    });
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

    const tokenData = await createWallAwareTokenDataForActors(createdActors, {
        anchorDocument: anchor,
        includeAnchorSlot: false
    });

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
