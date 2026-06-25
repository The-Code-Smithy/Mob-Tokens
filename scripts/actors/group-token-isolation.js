import { isGroupActor } from "./group-model.js";

export async function ensureUniqueGroupActorToken(tokenDocument, options = {})
{
    if (!game.user?.isGM) return;
    if (!tokenDocument?.actorLink) return;
    if (options?.actorGrouperSkipIsolation) return;

    const scene = tokenDocument.parent;
    if (!scene) return;

    const actor = tokenDocument.actor;
    if (!(actor instanceof Actor)) return;
    if (!isGroupActor(actor)) return;

    const duplicateToken = (scene.tokens ?? []).some((entry) =>
        entry.id !== tokenDocument.id && entry.actorId === tokenDocument.actorId
    );

    if (!duplicateToken) return;

    const actorData = actor.toObject();
    delete actorData._id;

    actorData.prototypeToken ??= {};
    actorData.prototypeToken.actorLink = true;
    actorData.prototypeToken.name = actorData.name;

    const clonedActor = await Actor.create(actorData, { renderSheet: false });
    if (!(clonedActor instanceof Actor)) return;

    await tokenDocument.update({
        actorId: clonedActor.id,
        actorLink: true,
        name: clonedActor.name
    });
}
