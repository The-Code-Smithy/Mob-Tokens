export function clampNumber(value, min, max)
{
    return Math.min(Math.max(value, min), max);
}

export function escapeHtml(value)
{
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

export function getInputValue(html, name)
{
    if (typeof html?.find === "function")
    {
        return html.find(`[name='${name}']`).val();
    }

    const root = html instanceof HTMLElement ? html : html?.[0];
    return root?.querySelector?.(`[name='${name}']`)?.value ?? "";
}

export function getRootElement(html)
{
    if (!html) return null;
    if (html instanceof HTMLElement) return html;
    if (html[0] instanceof HTMLElement) return html[0];
    if (html.element instanceof HTMLElement) return html.element;
    if (html.element?.[0] instanceof HTMLElement) return html.element[0];
    return null;
}
