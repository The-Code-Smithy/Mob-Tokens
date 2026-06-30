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
            if (anchorDocument)
            {
                const anchorX = Number(anchorDocument?.x);
                const anchorY = Number(anchorDocument?.y);
                const proxyTokenDoc = await createdActor.getTokenDocument({
                    x: Number.isFinite(anchorX) ? anchorX : 0,
                    y: Number.isFinite(anchorY) ? anchorY : 0
                });
                const [token] = await scene.createEmbeddedDocuments("Token", [proxyTokenDoc.toObject()]);
                createdToken = token ?? null;
            }
            else
            {
                createdToken = await placePartyProxyTokenByClick(createdActor, scene);
            }
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

async function placePartyProxyTokenByClick(actor, scene)
{
    const stage = canvas?.app?.stage;
    if (!stage)
    {
        ui.notifications?.warn(game.i18n.localize("MOBTOKENS.Errors.NoActiveScene"));
        return null;
    }

    ui.notifications?.info(game.i18n.localize("MOBTOKENS.Notifications.ClickToPlacePartyProxy"));

    const preview = await createPartyProxyPlacementPreview(actor);

    return new Promise((resolve) =>
    {
        let completed = false;

        const cleanup = () =>
        {
            if (completed) return;
            completed = true;
            stage.off?.("pointerdown", onPointerDown);
            stage.off?.("pointermove", onPointerMove);
            stage.off?.("rightdown", onRightDown);
            preview?.destroy?.();
        };

        const resolvePointerPosition = (event) =>
        {
            const local = event?.data?.getLocalPosition?.(canvas.stage)
                ?? canvas?.mousePosition
                ?? { x: 0, y: 0 };
            return {
                x: Number(local.x) || 0,
                y: Number(local.y) || 0
            };
        };

        const onPointerMove = (event) =>
        {
            if (!preview) return;
            const localPosition = resolvePointerPosition(event);
            const snappedPosition = getSnappedCanvasPosition(localPosition.x, localPosition.y);
            preview.update?.(snappedPosition.x, snappedPosition.y);
        };

        const onRightDown = (event) =>
        {
            event?.stopPropagation?.();
            cleanup();
            resolve(null);
        };

        const onPointerDown = async (event) =>
        {
            const button = Number(event?.button ?? event?.data?.originalEvent?.button ?? 0);
            if (button === 2)
            {
                onRightDown(event);
                return;
            }
            if (button !== 0) return;

            event?.stopPropagation?.();

            const localPosition = resolvePointerPosition(event);
            const snappedPosition = getSnappedCanvasPosition(localPosition.x, localPosition.y);

            try
            {
                const proxyTokenDoc = await actor.getTokenDocument({
                    x: snappedPosition.x,
                    y: snappedPosition.y
                });
                const [token] = await scene.createEmbeddedDocuments("Token", [proxyTokenDoc.toObject()]);
                cleanup();
                resolve(token ?? null);
            }
            catch (_error)
            {
                cleanup();
                resolve(null);
            }
        };

        stage.on?.("pointermove", onPointerMove);
        stage.on?.("pointerdown", onPointerDown);
        stage.on?.("rightdown", onRightDown);
        onPointerMove(null);
    });
}

async function createPartyProxyPlacementPreview(actor)
{
    const PIXIRef = globalThis.PIXI;
    const stage = canvas?.app?.stage;
    if (!PIXIRef || !stage) return null;

    const gridSize = Number(canvas?.grid?.size) || 100;
    const tokenWidth = Math.max(Number(actor?.prototypeToken?.width) || 1, 1) * gridSize;
    const tokenHeight = Math.max(Number(actor?.prototypeToken?.height) || 1, 1) * gridSize;
    const texturePath = actor?.prototypeToken?.texture?.src || actor?.img;

    const container = new PIXIRef.Container();
    container.eventMode = "none";
    container.zIndex = 100000;

    const sprite = new PIXIRef.Sprite();
    sprite.width = tokenWidth;
    sprite.height = tokenHeight;
    sprite.alpha = 0.55;
    sprite.tint = 0xffffff;

    if (texturePath)
    {
        try
        {
            const textureLoader = foundry?.canvas?.loadTexture ?? globalThis.loadTexture;
            const texture = typeof textureLoader === "function"
                ? await textureLoader(texturePath)
                : null;
            if (texture) sprite.texture = texture;
        }
        catch (_error)
        {
            sprite.texture = PIXIRef.Texture.WHITE;
        }
    }
    else
    {
        sprite.texture = PIXIRef.Texture.WHITE;
    }

    const border = new PIXIRef.Graphics();
    border.lineStyle(2, 0xf4b942, 0.95);
    border.beginFill(0x000000, 0.12);
    border.drawRect(0, 0, tokenWidth, tokenHeight);
    border.endFill();

    container.addChild(sprite);
    container.addChild(border);
    stage.addChild(container);

    return {
        update: (x, y) =>
        {
            container.position.set(Number(x) || 0, Number(y) || 0);
        },
        destroy: () =>
        {
            try
            {
                container.parent?.removeChild?.(container);
                container.destroy({ children: true });
            }
            catch (_error)
            {
                // no-op
            }
        }
    };
}

function getSnappedCanvasPosition(x, y)
{
    const snapMode = CONST?.GRID_SNAPPING_MODES?.CENTER ?? 1;

    try
    {
        const snappedLegacy = canvas?.grid?.getSnappedPosition?.(x, y, { mode: snapMode });
        if (Number.isFinite(Number(snappedLegacy?.x)) && Number.isFinite(Number(snappedLegacy?.y)))
        {
            return {
                x: Number(snappedLegacy.x),
                y: Number(snappedLegacy.y)
            };
        }
    }
    catch (_error)
    {
        // Fall through to other snapping APIs.
    }

    try
    {
        const snappedPoint = canvas?.grid?.getSnappedPoint?.({ x, y }, { mode: snapMode });
        if (Number.isFinite(Number(snappedPoint?.x)) && Number.isFinite(Number(snappedPoint?.y)))
        {
            return {
                x: Number(snappedPoint.x),
                y: Number(snappedPoint.y)
            };
        }
    }
    catch (_error)
    {
        // Fall through to raw coordinates.
    }

    return {
        x: Number(x) || 0,
        y: Number(y) || 0
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
