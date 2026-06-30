import { FLAG_SCOPE, GROUP_MODE_PARTY_PROXY } from "../core/constants.js";
import { createWallAwareTokenDataForActors } from "../core/token-placement.js";
import { getGroupFlags, isGroupActor } from "./group-model.js";

export async function createPartyProxyGroupActor(selectedTokens, {
    groupName,
    replaceSelectedTokens,
    referenceToken
} = {})
{
    const tokenEntries = (selectedTokens ?? [])
        .map((entry) =>
        {
            const tokenDocument = entry?.document ?? entry;
            const actor = tokenDocument?.actor ?? entry?.actor ?? null;
            if (!(actor instanceof Actor) || !tokenDocument?.id) return null;

            return {
                actor,
                tokenDocument
            };
        })
        .filter(Boolean);

    if (tokenEntries.length < 2)
    {
        ui.notifications?.warn(game.i18n.localize("MOBTOKENS.Errors.InvalidTokenSelectionCount"));
        return null;
    }

    const result = await createPartyProxyGroupFromActors(
        tokenEntries.map((entry) => entry.actor),
        {
            groupName,
            placeTokenOnScene: true,
            referenceToken,
            memberTokenEntries: tokenEntries,
            notify: false
        }
    );
    if (!result?.actor) return null;

    if (replaceSelectedTokens)
    {
        const scene = canvas?.scene;
        const deleteIds = Array.from(new Set(
            tokenEntries
                .map((entry) => entry.tokenDocument.id)
                .filter(Boolean)
        )).filter((id) => scene?.tokens?.has(id));
        if (scene && deleteIds.length > 0)
        {
            await scene.deleteEmbeddedDocuments("Token", deleteIds);
        }
    }

    ui.notifications?.info(game.i18n.format("MOBTOKENS.Notifications.PartyGroupCreated", {
        name: result.actor.name,
        count: tokenEntries.length
    }));

    return result;
}

export async function createPartyProxyGroupFromActors(memberActors, {
    groupName,
    placeTokenOnScene = false,
    referenceToken = null,
    memberTokenEntries = null,
    notify = true
} = {})
{
    const actors = (memberActors ?? []).filter((actor) => actor instanceof Actor && !isGroupActor(actor));
    if (actors.length < 2)
    {
        ui.notifications?.warn(game.i18n.localize("MOBTOKENS.Errors.InvalidPartyActorSelectionCount"));
        return null;
    }

    const sourceActor = actors[0];
    const resolvedGroupName = String(groupName ?? "").trim()
        || game.i18n.format("MOBTOKENS.DialogPartyGroupDefaultName", { count: actors.length });
    const actorData = sourceActor.toObject();
    delete actorData._id;
    actorData.name = resolvedGroupName;
    actorData.prototypeToken ??= {};
    actorData.prototypeToken.name = resolvedGroupName;
    actorData.prototypeToken.actorLink = true;

    actorData.ownership = buildPartyProxyOwnership(actors);

    const scene = canvas?.scene ?? null;
    actorData.flags ??= {};
    actorData.flags[FLAG_SCOPE] = {
        ...(actorData.flags[FLAG_SCOPE] ?? {}),
        isGroupActor: true,
        groupMode: GROUP_MODE_PARTY_PROXY,
        sourceActorId: sourceActor.id,
        sourceActorName: sourceActor.name,
        creatureCount: actors.length,
        remainingCount: actors.length,
        hpPerCreature: 0,
        maxGroupHP: 0,
        currentGroupHP: 0,
        moraleCheckedHalf: false,
        moraleRollTotal: null,
        moralePassed: null,
        isRouting: false,
        memberTokens: actors.map((actor, index) => ({
            actorId: actor.id,
            actorName: actor.name,
            tokenId: String(memberTokenEntries?.[index]?.tokenDocument?.id ?? ""),
            sceneId: String(scene?.id ?? "")
        }))
    };

    const createdActor = await Actor.create(actorData, { renderSheet: false });

    let createdToken = null;
    if (placeTokenOnScene)
    {
        if (!scene)
        {
            ui.notifications?.warn(game.i18n.localize("MOBTOKENS.Errors.NoActiveScene"));
        }
        else
        {
            const anchorDocument = referenceToken?.document ?? null;
            const gridSize = Number(canvas?.grid?.size) || 100;
            const defaultX = gridSize * 2;
            const defaultY = gridSize * 2;
            const anchorX = Number(anchorDocument?.x);
            const anchorY = Number(anchorDocument?.y);

            const proxyTokenDoc = await createdActor.getTokenDocument({
                x: Number.isFinite(anchorX) ? anchorX : defaultX,
                y: Number.isFinite(anchorY) ? anchorY : defaultY
            });
            const [token] = await scene.createEmbeddedDocuments("Token", [proxyTokenDoc.toObject()]);
            createdToken = token ?? null;
        }
    }

    if (notify)
    {
        ui.notifications?.info(game.i18n.format("MOBTOKENS.Notifications.PartyGroupCreated", {
            name: createdActor.name,
            count: actors.length
        }));
    }

    return {
        actor: createdActor,
        token: createdToken
    };
}

export async function splitPartyProxyGroupActor(groupActor, referenceToken)
{
    const scene = canvas?.scene;
    if (!scene)
    {
        ui.notifications?.warn(game.i18n.localize("MOBTOKENS.Errors.NoActiveScene"));
        return;
    }

    const flags = getGroupFlags(groupActor);
    const members = Array.isArray(flags.memberTokens) ? flags.memberTokens : [];
    if (members.length < 1)
    {
        ui.notifications?.warn(game.i18n.localize("MOBTOKENS.Errors.PartyGroupMembersMissing"));
        return;
    }

    const anchorDocument = referenceToken?.document
        ?? groupActor.getActiveTokens?.()[0]?.document
        ?? null;
    if (!anchorDocument)
    {
        ui.notifications?.warn(game.i18n.localize("MOBTOKENS.Errors.TokenNotFound"));
        return;
    }

    const memberActors = [];
    let missingCount = 0;

    for (let index = 0; index < members.length; index++)
    {
        const member = members[index] ?? {};
        const memberActor = game.actors?.get(String(member.actorId ?? ""));
        if (!(memberActor instanceof Actor))
        {
            missingCount += 1;
            continue;
        }

        memberActors.push(memberActor);
    }

    const [anchorMemberActor, ...remainingMemberActors] = memberActors;
    if (!(anchorMemberActor instanceof Actor))
    {
        ui.notifications?.warn(game.i18n.localize("MOBTOKENS.Errors.PartyGroupMembersMissing"));
        return;
    }

    const anchorReplacementDoc = await anchorMemberActor.getTokenDocument({
        x: Number(anchorDocument.x) || 0,
        y: Number(anchorDocument.y) || 0
    });
    const anchorUpdate = anchorReplacementDoc.toObject();
    delete anchorUpdate._id;

    await anchorDocument.update(anchorUpdate);

    const tokenData = await createWallAwareTokenDataForActors(remainingMemberActors, {
        anchorDocument,
        includeAnchorSlot: false
    });

    if ((tokenData.length + 1) < 1)
    {
        ui.notifications?.warn(game.i18n.localize("MOBTOKENS.Errors.PartyGroupMembersMissing"));
        return;
    }

    if (tokenData.length > 0)
    {
        await scene.createEmbeddedDocuments("Token", tokenData);
    }

    await groupActor.delete({ deleteAllTokens: false });

    if (missingCount > 0)
    {
        ui.notifications?.warn(game.i18n.format("MOBTOKENS.Errors.PartyGroupMembersPartialMissing", {
            count: missingCount
        }));
    }

    ui.notifications?.info(game.i18n.format("MOBTOKENS.Notifications.PartyGroupSplit", {
        count: tokenData.length + 1
    }));
}

function buildPartyProxyOwnership(actors)
{
    const ownership = { default: 0 };
    for (const actor of actors)
    {
        const actorOwnership = actor?.ownership ?? {};
        for (const [userId, level] of Object.entries(actorOwnership))
        {
            const numericLevel = Number(level);
            if (!Number.isFinite(numericLevel)) continue;

            const current = Number(ownership[userId] ?? Number.NEGATIVE_INFINITY);
            if (!Number.isFinite(current) || numericLevel > current)
            {
                ownership[userId] = numericLevel;
            }
        }
    }

    return ownership;
}
