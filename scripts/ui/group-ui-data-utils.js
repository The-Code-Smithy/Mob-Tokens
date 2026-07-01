import { clampNumber } from "../core/helpers.js";
import { getSystemAdapter } from "../systems/system-adapter.js";

export function getCreateDialogStatConfig(actor)
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

export function resolveFirstNumericPath(actor, candidatePaths)
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

export function parseOptionalNumericInput(value)
{
    if (value === null || value === undefined) return null;
    const trimmed = String(value).trim();
    if (!trimmed) return null;

    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
}

export function applyOptionalActorNumericOverride(target, path, value)
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

export function getActorFolderOptions(defaultFolderId = "")
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

export function getFolderIdFromInput(value)
{
    const folderId = String(value ?? "").trim();
    return folderId.length > 0 ? folderId : null;
}

export function parseSplitCounts(value)
{
    return String(value ?? "")
        .split(/[\s,]+/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .map((part) => Number(part));
}

export function suggestSplitCounts(total, groups)
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

export function distributeHPAcrossSplits(totalCurrentHP, splitCounts, hpPerCreature)
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
