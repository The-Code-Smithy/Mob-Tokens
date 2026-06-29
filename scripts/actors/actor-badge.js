import { BADGE_KEY } from "../core/constants.js";
import { clampNumber } from "../core/helpers.js";
import { getGroupFlags, isGroupActor } from "./group-model.js";

export function renderTokenCountBadge(token)
{
    if (!token?.document) return;

    const actor = token.actor ?? token.document.actor;
    if (!(actor instanceof Actor) || !isGroupActor(actor))
    {
        removeTokenCountBadge(token);
        return;
    }

    const flags = getGroupFlags(actor);
    const remainingCount = Math.max(Number(flags.remainingCount) || 0, 0);
    const isRouting = Boolean(flags.isRouting);

    let badge = token[BADGE_KEY];
    if (!badge)
    {
        badge = createTokenCountBadge();
        token[BADGE_KEY] = badge;
        token.addChild(badge);
    }

    const text = badge.getChildByName("text");
    const background = badge.getChildByName("background");
    if (!text || !background) return;

    const metrics = getBadgeMetrics(token);
    if (typeof text.style === "object")
    {
        text.style.fontSize = metrics.fontSize;
        text.style.strokeThickness = metrics.strokeThickness;
    }

    text.text = String(remainingCount);
    const boxWidth = Math.max(metrics.minWidth, text.width + metrics.padX * 2);
    const boxHeight = Math.max(metrics.minHeight, text.height + metrics.padY * 2);

    background.clear();
    background.lineStyle(metrics.borderWidth, 0xFFFFFF, 0.95);
    background.beginFill(isRouting ? 0x8F1D1D : 0x111827, 0.82);
    background.drawRoundedRect(0, 0, boxWidth, boxHeight, metrics.radius);
    background.endFill();

    text.position.set(boxWidth / 2, boxHeight / 2);
    badge.position.set(Math.max((token.w ?? 0) - boxWidth - metrics.offset, metrics.offset), metrics.offset);
    badge.visible = true;
}

export function removeTokenCountBadge(token)
{
    const badge = token?.[BADGE_KEY];
    if (!badge) return;
    badge.destroy({ children: true });
    delete token[BADGE_KEY];
}

function createTokenCountBadge()
{
    const badge = new PIXI.Container();
    badge.eventMode = "none";
    badge.zIndex = 20;

    const background = new PIXI.Graphics();
    background.name = "background";
    badge.addChild(background);

    const textStyle = new PIXI.TextStyle({
        fontFamily: "Signika",
        fontSize: 18,
        fontWeight: "700",
        fill: "#FFFFFF",
        stroke: "#000000",
        strokeThickness: 4,
        align: "center"
    });

    const text = new PIXI.Text("0", textStyle);
    text.name = "text";
    if (text.anchor?.set) text.anchor.set(0.5);
    badge.addChild(text);

    return badge;
}

function getBadgeMetrics(token)
{
    const baseSize = Math.max(Math.min(token?.w ?? 0, token?.h ?? 0), 32);
    const fontSize = clampNumber(Math.round(baseSize * 0.14), 9, 15);
    const strokeThickness = clampNumber(Math.round(fontSize * 0.2), 2, 3);
    const padX = clampNumber(Math.round(fontSize * 0.35), 3, 7);
    const padY = clampNumber(Math.round(fontSize * 0.16), 2, 4);
    const minHeight = clampNumber(Math.round(baseSize * 0.16), 13, 22);
    const minWidth = clampNumber(Math.round(baseSize * 0.18), 15, 26);
    const radius = clampNumber(Math.round(baseSize * 0.06), 3, 7);
    const offset = clampNumber(Math.round(baseSize * 0.02), 1, 4);
    const borderWidth = clampNumber(Math.round(baseSize * 0.015), 1, 2);

    return {
        fontSize,
        strokeThickness,
        padX,
        padY,
        minHeight,
        minWidth,
        radius,
        offset,
        borderWidth
    };
}
