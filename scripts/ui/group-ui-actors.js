import { FLAG_SCOPE, GROUP_MODE_MOB } from "../core/constants.js";
import { clampNumber } from "../core/helpers.js";
import { createWallAwareTokenDataForActors } from "../core/token-placement.js";
import { applyHPUpdate, calculateRemainingCount, formatGroupName, getGroupFlags, getHitPointPaths } from "../actors/group-model.js";
import { applyOptionalActorNumericOverride, distributeHPAcrossSplits } from "./group-ui-data-utils.js";

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

export async function splitGroupActor(groupActor, splitCounts, options = {})
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
