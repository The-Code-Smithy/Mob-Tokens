import { FLAG_SCOPE, HP_PATH_CANDIDATES, MORALE_PATH_CANDIDATES } from "../core/constants.js";
import { clampNumber } from "../core/helpers.js";

export function getActorFromDirectoryLi(li)
{
    const rawElement = li?.[0] ?? li?.currentTarget ?? li;
    const element = rawElement?.closest?.("[data-entry-id]")
        ?? rawElement?.closest?.("[data-document-id]")
        ?? rawElement;
    const data = typeof li?.data === "function" ? li.data() ?? {} : {};
    const actorId = data.documentId
        ?? data.entryId
        ?? data.actorId
        ?? element?.dataset?.documentId
        ?? element?.dataset?.entryId
        ?? element?.dataset?.actorId
        ?? element?.getAttribute?.("data-document-id")
        ?? element?.getAttribute?.("data-entry-id")
        ?? element?.getAttribute?.("data-actor-id");

    if (actorId)
    {
        return game.actors?.get(actorId) ?? null;
    }

    const actorUuid = data.uuid
        ?? data.documentUuid
        ?? element?.dataset?.uuid
        ?? element?.dataset?.documentUuid
        ?? element?.getAttribute?.("data-uuid")
        ?? element?.getAttribute?.("data-document-uuid");

    if (typeof actorUuid === "string" && actorUuid.startsWith("Actor."))
    {
        return fromUuidSync?.(actorUuid) ?? null;
    }

    return null;
}

export function getGroupFlags(actor)
{
    return actor.flags?.[FLAG_SCOPE] ?? {};
}

export function isGroupActor(actor)
{
    return Boolean(getGroupFlags(actor).isGroupActor);
}

export function formatGroupName(sourceActorName, remainingCount)
{
    return `${sourceActorName} x${remainingCount}`;
}

export function calculateRemainingCount({ currentHP, maxGroupHP, creatureCount, hpPerCreature })
{
    if (currentHP <= 0) return 0;

    const derivedHPPerCreature = creatureCount > 0 ? (maxGroupHP / creatureCount) : 0;
    const effectiveHPPerCreature = derivedHPPerCreature > 0 ? derivedHPPerCreature : hpPerCreature;
    if (effectiveHPPerCreature <= 0) return 0;

    return Math.ceil(currentHP / effectiveHPPerCreature);
}

export function clampHP(value, max)
{
    const numericValue = Number(value) || 0;
    const numericMax = Math.max(Number(max) || 0, 0);
    return Math.min(Math.max(numericValue, 0), numericMax);
}

export function getHitPointPaths(systemData)
{
    for (const candidate of HP_PATH_CANDIDATES)
    {
        const currentValue = foundry.utils.getProperty({ system: systemData }, candidate.current);
        const maxValue = foundry.utils.getProperty({ system: systemData }, candidate.max);
        if (Number.isFinite(Number(currentValue)) || Number.isFinite(Number(maxValue)))
        {
            return candidate;
        }
    }

    return discoverHitPointPaths(systemData);
}

function discoverHitPointPaths(data, path = [])
{
    if (!data || typeof data !== "object") return null;

    for (const [key, value] of Object.entries(data))
    {
        if (!value || typeof value !== "object") continue;

        const lowerKey = key.toLowerCase();
        const nextPath = [...path, key];
        const valuePath = `system.${nextPath.join(".")}.value`;
        const currentPath = `system.${nextPath.join(".")}.current`;
        const maxPath = `system.${nextPath.join(".")}.max`;
        const canUseValue = Number.isFinite(Number(value.value)) && Number.isFinite(Number(value.max));
        const canUseCurrent = Number.isFinite(Number(value.current)) && Number.isFinite(Number(value.max));

        if (/(^hp$|health|hitpoints|hit_points)/.test(lowerKey))
        {
            if (canUseValue) return { current: valuePath, max: maxPath };
            if (canUseCurrent) return { current: currentPath, max: maxPath };
        }

        const nested = discoverHitPointPaths(value, nextPath);
        if (nested) return nested;
    }

    return null;
}

export function getActorHPState(actor)
{
    const hpPaths = getHitPointPaths(actor.system);
    if (!hpPaths)
    {
        const flags = getGroupFlags(actor);
        return {
            current: Number(flags.currentGroupHP) || 0,
            max: Number(flags.maxGroupHP) || 0,
            paths: null
        };
    }

    const current = Number(foundry.utils.getProperty(actor, hpPaths.current)) || 0;
    const max = Number(foundry.utils.getProperty(actor, hpPaths.max)) || 0;
    return { current, max, paths: hpPaths };
}

export function applyHPUpdate(target, hpPaths, current, max)
{
    if (!hpPaths) return;
    foundry.utils.setProperty(target, hpPaths.current, current);
    foundry.utils.setProperty(target, hpPaths.max, max);
}

export function getDefaultHPPerCreature(actor)
{
    const hpState = getActorHPState(actor);
    return Math.max(hpState.max || hpState.current || 1, 1);
}

export function getMoraleTarget(actor)
{
    for (const path of MORALE_PATH_CANDIDATES)
    {
        const value = foundry.utils.getProperty(actor, path);
        const numericValue = Number(value);
        if (Number.isFinite(numericValue))
        {
            return clampNumber(numericValue, 2, 12);
        }
    }

    return 7;
}
