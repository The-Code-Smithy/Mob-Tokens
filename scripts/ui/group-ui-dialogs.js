import { clampNumber, getInputValue } from "../core/helpers.js";
import { formatGroupName, getDefaultHPPerCreature, getGroupFlags, isGroupActor } from "../actors/group-model.js";
import { createPartyProxyGroupFromActors } from "../actors/pc-group.js";
import { getActorFolderOptions, getCreateDialogStatConfig, getFolderIdFromInput, parseOptionalNumericInput, parseSplitCounts, suggestSplitCounts } from "./group-ui-data-utils.js";
import { getDialogContentRoot, getNamedInput, isCheckboxChecked, isLikelyPlayerCharacter, openDialogCompat, renderActorGrouperTemplate } from "./group-ui-dialog-utils.js";
import { createGroupActor, splitGroupActor } from "./group-ui-actors.js";

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
