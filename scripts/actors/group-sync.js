import { FLAG_SCOPE, UPDATE_GUARD } from "../core/constants.js";
import { calculateRemainingCount, clampHP, formatGroupName, getActorHPState, getGroupFlags } from "./group-model.js";
import { maybeRunMoraleCheck } from "./morale.js";
import { renderTokenCountBadge } from "./actor-badge.js";

export async function syncGroupActor(actor)
{
    const flags = getGroupFlags(actor);
    const hpPerCreature = Number(flags.hpPerCreature) || 0;
    const previousHP = Number(flags.currentGroupHP) || 0;
    const hpState = getActorHPState(actor);
    const currentGroupHP = clampHP(hpState.current, hpState.max || flags.maxGroupHP);
    const maxGroupHP = Math.max(Number(hpState.max) || Number(flags.maxGroupHP) || 0, 0);
    const remainingCount = calculateRemainingCount({
        currentHP: currentGroupHP,
        maxGroupHP,
        creatureCount: Number(flags.creatureCount) || 0,
        hpPerCreature
    });
    const displayName = formatGroupName(flags.sourceActorName || actor.name, remainingCount);

    const updates = {};
    if (currentGroupHP !== Number(flags.currentGroupHP))
    {
        updates[`flags.${FLAG_SCOPE}.currentGroupHP`] = currentGroupHP;
    }
    if (maxGroupHP !== Number(flags.maxGroupHP))
    {
        updates[`flags.${FLAG_SCOPE}.maxGroupHP`] = maxGroupHP;
    }
    if (remainingCount !== Number(flags.remainingCount))
    {
        updates[`flags.${FLAG_SCOPE}.remainingCount`] = remainingCount;
    }
    if (actor.name !== displayName)
    {
        updates.name = displayName;
    }
    if (actor.prototypeToken?.name !== displayName)
    {
        updates["prototypeToken.name"] = displayName;
    }

    await maybeRunMoraleCheck(actor, {
        updates,
        previousHP,
        currentGroupHP,
        maxGroupHP,
        remainingCount
    });

    if (Object.keys(updates).length > 0)
    {
        await actor.update(updates, { [UPDATE_GUARD]: true });
    }

    await syncActiveTokens(actor, displayName, currentGroupHP <= 0);
}

async function syncActiveTokens(actor, displayName, isDefeated)
{
    const activeTokens = actor.getActiveTokens?.() ?? [];
    const defeatedIcon = CONFIG?.controlIcons?.defeated ?? null;

    for (const token of activeTokens)
    {
        const tokenDocument = token.document ?? token;
        const tokenUpdates = {};
        if (tokenDocument?.name !== displayName)
        {
            tokenUpdates.name = displayName;
        }

        const currentOverlay = tokenDocument?.overlayEffect ?? null;
        const desiredOverlay = isDefeated ? defeatedIcon : null;
        if (currentOverlay !== desiredOverlay)
        {
            tokenUpdates.overlayEffect = desiredOverlay;
        }

        if (Object.keys(tokenUpdates).length > 0)
        {
            await tokenDocument.update(tokenUpdates, { [UPDATE_GUARD]: true });
        }

        renderTokenCountBadge(tokenDocument.object ?? token);

        const combatant = token.combatant ?? tokenDocument.combatant;
        if (combatant && combatant.defeated !== isDefeated)
        {
            await combatant.update({ defeated: isDefeated }, { [UPDATE_GUARD]: true });
        }
    }
}
