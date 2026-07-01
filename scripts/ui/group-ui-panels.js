import { FLAG_SCOPE } from "../core/constants.js";
import { clampNumber, getRootElement } from "../core/helpers.js";
import { getGroupFlags, getHitPointPaths, isGroupActor, isPartyProxyGroupActor } from "../actors/group-model.js";
import { formatMoraleStatus, resetMoraleFlags } from "../actors/morale.js";
import { getPartyProxyMemberActors, setPartyProxyMemberActors } from "../actors/pc-group.js";
import { getSystemAdapter } from "../systems/system-adapter.js";
import { resolveFirstNumericPath } from "./group-ui-data-utils.js";
import { openDialogCompat, renderActorGrouperTemplate } from "./group-ui-dialog-utils.js";

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
