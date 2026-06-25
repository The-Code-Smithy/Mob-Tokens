import { FLAG_SCOPE, MODULE_ID, UPDATE_GUARD } from "../core/constants.js";
import { escapeHtml } from "../core/helpers.js";
import { getGroupFlags, getMoraleTarget } from "./group-model.js";

export function formatMoraleStatus(flags)
{
    if (flags.isRouting) return game.i18n.localize("MOBTOKENS.MoraleRouting");
    if (flags.moralePassed === true) return game.i18n.localize("MOBTOKENS.MoraleSteady");
    if (flags.moraleCheckedHalf) return game.i18n.localize("MOBTOKENS.MoraleChecked");
    return game.i18n.localize("MOBTOKENS.MoralePending");
}

export async function resetMoraleFlags(actor)
{
    await actor.update({
        [`flags.${FLAG_SCOPE}.moraleCheckedHalf`]: false,
        [`flags.${FLAG_SCOPE}.moraleRollTotal`]: null,
        [`flags.${FLAG_SCOPE}.moralePassed`]: null,
        [`flags.${FLAG_SCOPE}.isRouting`]: false
    }, { [UPDATE_GUARD]: true });
}

export async function maybeRunMoraleCheck(actor, { updates, previousHP, currentGroupHP, maxGroupHP, remainingCount })
{
    if (!game.settings.get(MODULE_ID, "enableMoraleCheck")) return;

    const flags = getGroupFlags(actor);
    if (flags.moraleCheckedHalf) return;
    if (maxGroupHP <= 0) return;

    const threshold = maxGroupHP * 0.5;
    const crossedThreshold = previousHP > threshold && currentGroupHP <= threshold;
    if (!crossedThreshold || currentGroupHP <= 0 || remainingCount <= 0) return;

    const moraleTarget = getMoraleTarget(actor);
    const roll = await (new Roll("2d6")).evaluate();
    const passed = roll.total <= moraleTarget;

    updates[`flags.${FLAG_SCOPE}.moraleCheckedHalf`] = true;
    updates[`flags.${FLAG_SCOPE}.moraleRollTotal`] = roll.total;
    updates[`flags.${FLAG_SCOPE}.moralePassed`] = passed;
    updates[`flags.${FLAG_SCOPE}.isRouting`] = !passed;

    const outcome = passed
        ? game.i18n.localize("MOBTOKENS.MoraleResultPass")
        : game.i18n.localize("MOBTOKENS.MoraleResultFail");

    const moraleMessage = game.i18n.format("MOBTOKENS.MoraleChatMessage", {
        actorName: actor.name,
        rollTotal: roll.total,
        moraleTarget,
        outcome
    });

    const speaker = ChatMessage.getSpeaker({ actor });
    try
    {
        const messageData = {
            speaker,
            flavor: moraleMessage,
            content: `<p>${escapeHtml(moraleMessage)}</p>`,
            rolls: [roll]
        };

        const rollType = CONST?.CHAT_MESSAGE_TYPES?.ROLL;
        if (rollType !== undefined)
        {
            messageData.type = rollType;
        }

        await ChatMessage.create({
            ...messageData
        });
    }
    catch (error)
    {
        console.error(`${MODULE_ID} | Failed to create morale roll chat card`, error);
        await ChatMessage.create({
            speaker,
            content: `<p>${escapeHtml(moraleMessage)}</p>`
        });
    }

    if (!passed)
    {
        ui.notifications?.warn(game.i18n.format("MOBTOKENS.MoraleNotificationRouting", {
            actorName: actor.name
        }));
    }
}
