import { getRootElement } from "../core/helpers.js";

const TEMPLATE_BASE_PATH = "modules/mob-tokens/templates";

export async function renderActorGrouperTemplate(templateName, data = {})
{
    const templatePath = `${TEMPLATE_BASE_PATH}/${templateName}.hbs`;
    const renderFn = foundry?.applications?.handlebars?.renderTemplate
        ?? globalThis.renderTemplate;
    if (typeof renderFn !== "function")
    {
        throw new Error("Mob Tokens could not find a template renderer.");
    }

    return renderFn(templatePath, data);
}

export function isCheckboxChecked(html, name)
{
    if (typeof html?.find === "function")
    {
        return html.find(`[name='${name}']`).is(":checked");
    }

    const root = html instanceof HTMLElement ? html : html?.[0];
    return Boolean(root?.querySelector?.(`[name='${name}']`)?.checked);
}

export function getNamedInput(root, name)
{
    return root?.querySelector?.(`[name='${name}']`) ?? null;
}

export function getDialogContentRoot(dialogLike)
{
    const host = dialogLike?.element ?? dialogLike;
    const root = getRootElement(host);
    if (!root) return null;
    return root.querySelector("form") ?? root;
}

export function openDialogCompat(config)
{
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2)
    {
        throw new Error("Mob Tokens requires foundry.applications.api.DialogV2 for dialog rendering.");
    }

    const buttons = Object.entries(config?.buttons ?? {}).map(([action, buttonConfig]) => ({
        action,
        label: buttonConfig?.label,
        icon: buttonConfig?.icon,
        default: action === config?.default,
        callback: async (event, button, dialog) =>
        {
            if (typeof buttonConfig?.callback !== "function") return;
            const root = getDialogContentRoot(dialog);
            await buttonConfig.callback(root ?? dialog, event, button, dialog);
        }
    }));

    const dialog = new DialogV2({
        window: {
            title: config?.title ?? ""
        },
        content: config?.content ?? "",
        buttons,
        close: config?.close
    });

    if (typeof config?.render === "function")
    {
        const hookId = Hooks.on("renderDialogV2", (app) =>
        {
            if (app !== dialog) return;
            Hooks.off("renderDialogV2", hookId);
            const root = getDialogContentRoot(dialog);
            config.render(root ?? dialog);
        });
    }

    dialog.render(true);
    return dialog;
}

export function isLikelyPlayerCharacter(actor)
{
    const actorType = String(actor?.type ?? "").trim().toLowerCase();
    if (actorType === "character" || actorType === "pc" || actorType === "player") return true;
    if (actorType === "npc" || actorType === "monster") return false;
    return Boolean(actor?.hasPlayerOwner);
}
