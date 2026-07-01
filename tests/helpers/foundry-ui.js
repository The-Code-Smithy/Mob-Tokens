async function loginToFoundry(page)
{
    const username = process.env.FOUNDRY_LOGIN_USER || process.env.FOUNDRY_USERNAME || "Gamemaster";
    const password = process.env.FOUNDRY_PASSWORD || "";
    const world = process.env.FOUNDRY_WORLD || "";

    for (let attempt = 0; attempt < 3; attempt++)
    {
        if (page.url().includes("/game"))
        {
            await waitForGameReady(page);
            return page;
        }

        await page.goto("/join", { waitUntil: "domcontentloaded" });

        if (page.url().includes("/game"))
        {
            await waitForGameReady(page);
            return page;
        }

        const joinForm = page.locator("#join-game-form");
        const criticalFailure = page.getByRole("heading", { name: /Critical Failure/i });
        const pageState = await Promise.race([
            joinForm.waitFor({ state: "visible", timeout: 15000 }).then(() => "join"),
            criticalFailure.waitFor({ state: "visible", timeout: 15000 }).then(() => "critical")
        ]).catch(() => "unknown");

        if (pageState === "critical")
        {
            await page.waitForTimeout(1000);
            continue;
        }

        await joinForm.waitFor({ state: "visible", timeout: 15000 });

        const worldSelect = joinForm.locator('select[name="world"], #world').first();
        if (world && (await worldSelect.count()) > 0)
        {
            await selectBestOption(worldSelect, world);
        }

        const userSelect = joinForm.locator('select[name="userid"], select[name="user"], #userid, #user').first();
        if ((await userSelect.count()) > 0)
        {
            const userId = await userSelect.evaluate((select, requestedUserName) =>
            {
                const normalize = (value) => (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
                const target = normalize(requestedUserName);
                const options = Array.from(select.options);
                const option = options.find((candidate) => normalize(candidate.textContent) === target)
                    ?? options.find((candidate) => normalize(candidate.label) === target)
                    ?? options.find((candidate) => normalize(candidate.textContent).includes(target))
                    ?? options.find((candidate) => normalize(candidate.label).includes(target));
                return option?.value ?? null;
            }, username);

            if (!userId)
            {
                const availableUsers = await userSelect.evaluate((select) =>
                    Array.from(select.options || [])
                        .map((option) => option.label || option.textContent || option.value)
                        .map((entry) => entry.trim())
                ).catch(() => []);
                throw new Error(`Unable to find Foundry user '${username}' in join dropdown. Available users: ${availableUsers.join(", ")}`);
            }

            const selected = await userSelect.evaluate((select, value) =>
            {
                const options = Array.from(select.options || []);
                const option = options.find((candidate) => String(candidate.value) === String(value));
                if (!option) return false;

                select.value = option.value;
                select.dispatchEvent(new Event("change", { bubbles: true }));
                return true;
            }, userId).catch(() => false);

            if (!selected)
            {
                throw new Error(`Unable to set Foundry user selection to '${username}'.`);
            }
        }

        const userInput = joinForm.locator('input[name="userid"], input[name="user"], #userid, #user').first();
        if ((await userInput.count()) > 0)
        {
            await userInput.fill(username);
        }

        const passwordInput = joinForm.locator('input[name="password"], input[type="password"], #password').first();
        if ((await passwordInput.count()) > 0)
        {
            await passwordInput.fill(password);
        }

        const joinButton = joinForm.locator('button[name="join"], button[type="submit"], button:has-text("Join Game"), button:has-text("Join")').first();
        await joinButton.waitFor({ state: "visible", timeout: 10000 });
        await joinButton.click();

        await waitForGameReady(page);

        const activeUserName = await page.evaluate(() => game?.user?.name ?? "").catch(() => "");
        if (activeUserName && normalizeName(activeUserName) !== normalizeName(username))
        {
            throw new Error(`Logged in as '${activeUserName}' instead of requested user '${username}'.`);
        }

        return page;
    }

    throw new Error("Foundry join page did not become available. Is the world active?");
}

async function waitForGameReady(page)
{
    await page.waitForURL("**/game", { timeout: 60000 });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() =>
    {
        const hasGame = typeof window !== "undefined" && Boolean(window.game);
        const hasUi = typeof window !== "undefined" && Boolean(window.ui);
        const activeUser = Boolean(window.game?.user);
        const notificationsReady = Boolean(window.ui?.notifications);
        const sidebarReady = Boolean(document.querySelector("#sidebar, #ui-right"));
        const joinFormVisible = Boolean(document.querySelector("#join-game-form"));
        const setupVisible = Boolean(document.querySelector("#setup"));

        return hasGame
            && hasUi
            && activeUser
            && notificationsReady
            && sidebarReady
            && !joinFormVisible
            && !setupVisible;
    }, null, { timeout: 240000 });
}

function normalizeName(value)
{
    return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function isClosedContextError(error)
{
    const message = String(error?.message ?? error ?? "");
    return /Target page, context or browser has been closed|Execution context was destroyed|has been closed/i.test(message);
}

async function evaluateOrFallback(page, pageFunction, arg, fallbackValue)
{
    if (page?.isClosed?.()) return fallbackValue;

    try
    {
        return await page.evaluate(pageFunction, arg);
    }
    catch (error)
    {
        if (isClosedContextError(error)) return fallbackValue;
        throw error;
    }
}

async function selectBestOption(selectLocator, value)
{
    const target = String(value ?? "").trim().toLowerCase();
    if (!target) return false;

    return selectLocator.evaluate((select, requested) =>
    {
        const options = Array.from(select.options || []);

        const exactLabel = options.find((option) => option.label?.trim().toLowerCase() === requested);
        if (exactLabel)
        {
            select.value = exactLabel.value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
        }

        const exactText = options.find((option) => option.textContent?.trim().toLowerCase() === requested);
        if (exactText)
        {
            select.value = exactText.value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
        }

        const exactValue = options.find((option) => String(option.value).trim().toLowerCase() === requested);
        if (exactValue)
        {
            select.value = exactValue.value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
        }

        const containsLabel = options.find((option) => option.label?.trim().toLowerCase().includes(requested));
        if (containsLabel)
        {
            select.value = containsLabel.value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
        }

        const containsText = options.find((option) => option.textContent?.trim().toLowerCase().includes(requested));
        if (containsText)
        {
            select.value = containsText.value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
        }

        return false;
    }, target).catch(() => false);
}

async function dismissQuickStartPromptIfPresent(page)
{
    const prompt = page.locator(".window-app.dialog").filter({ hasText: "Actor Group Quick Start" }).last();
    if ((await prompt.count()) < 1) return;

    const dismissButton = prompt.locator("button").filter({ hasText: "I Will Do That Later" }).first();
    if ((await dismissButton.count()) > 0)
    {
        await dismissButton.click();
        return;
    }

    const closeButton = prompt.locator(".header-button.close, .close").first();
    if ((await closeButton.count()) > 0)
    {
        await closeButton.click();
    }
}

async function openActorsSidebar(page)
{
    await page.waitForFunction(() => Boolean(document.querySelector("#sidebar, #ui-right")), null, { timeout: 30000 });

    for (let attempt = 0; attempt < 5; attempt++)
    {
        const isVisible = await evaluateOrFallback(page, () =>
        {
            const actors = document.querySelector("#actors");
            return Boolean(actors && actors.offsetParent !== null);
        }, null, false);
        if (isVisible) return;

        await evaluateOrFallback(page, () =>
        {
            try
            {
                if (!ui?.sidebar?.activateTab) return false;
                ui.sidebar.activateTab("actors");
                return true;
            }
            catch (_error)
            {
                return false;
            }
        }, null, false);

        const actorsTab = page.locator("#sidebar [data-tab='actors'], #ui-right [data-tab='actors'], [data-tab='actors']").first();
        if (await actorsTab.isVisible().catch(() => false))
        {
            await actorsTab.click({ force: true }).catch(() => undefined);
        }

        await page.waitForTimeout(250);
    }

    await page.waitForFunction(() =>
    {
        const actors = document.querySelector("#actors");
        return Boolean(actors && actors.offsetParent !== null);
    }, null, { timeout: 30000 });
}

async function ensureActorDirectoryEntry(page, actorName)
{
    const actorId = await page.evaluate(async (name) =>
    {
        const normalize = (value) => (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
        let actor = game.actors.find((candidate) => normalize(candidate.name) === normalize(name));

        if (!actor)
        {
            const actorType = game.system?.documentTypes?.Actor?.[0] ?? "character";
            actor = await Actor.create({ name, type: actorType }, { renderSheet: false });
        }

        const searchInput = document.querySelector("#actors input[type='search'], #actors input[name='search']");
        if (searchInput)
        {
            searchInput.value = actor.name;
            searchInput.dispatchEvent(new Event("input", { bubbles: true }));
            searchInput.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));
        }

        return actor.id;
    }, actorName);

    await page.waitForFunction((id) =>
    {
        const selector = `#actors li[data-document-id='${id}'], #actors li[data-entry-id='${id}']`;
        return Boolean(document.querySelector(selector));
    }, actorId, { timeout: 15000 });

    return actorId;
}

async function openActorContextAction(page, actorName, actionLabel)
{
    const actorId = await page.evaluate((name) =>
    {
        const normalize = (value) => (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
        const actor = game.actors.find((candidate) => normalize(candidate.name) === normalize(name));
        return actor?.id ?? null;
    }, actorName);

    if (!actorId)
    {
        throw new Error(`Could not resolve actor id for '${actorName}'.`);
    }

    for (let attempt = 0; attempt < 3; attempt++)
    {
        const opened = await page.evaluate((id) =>
        {
            const target = document.querySelector(`#actors li[data-document-id='${id}'], #actors li[data-entry-id='${id}']`);
            if (!target) return false;

            const scrollHost = target.closest(".directory-list") || target.parentElement;
            if (scrollHost)
            {
                const top = target.offsetTop - 40;
                scrollHost.scrollTop = top > 0 ? top : 0;
            }

            const rect = target.getBoundingClientRect();
            target.dispatchEvent(new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                view: window,
                button: 2,
                buttons: 2,
                clientX: rect.left + 12,
                clientY: rect.top + 12
            }));

            return true;
        }, actorId);

        if (!opened)
        {
            throw new Error(`Could not locate actor directory row for '${actorName}' (id ${actorId}).`);
        }

        const contextItem = page.locator("#context-menu li, nav#context-menu li, .context li")
            .filter({ hasText: actionLabel })
            .first();

        if (await contextItem.isVisible().catch(() => false))
        {
            await contextItem.click();
            return;
        }

        await page.waitForTimeout(250);
    }

    throw new Error(`Could not open context action '${actionLabel}' for actor '${actorName}'.`);
}

async function waitForActorEntryByName(page, actorName)
{
    await page.waitForFunction((name) =>
    {
        const entries = Array.from(document.querySelectorAll("#actors li.directory-item, #actors li[data-document-id], #actors li[data-entry-id]"));
        return entries.some((entry) =>
        {
            const title = entry.querySelector("h4")?.textContent || entry.textContent || "";
            return title.trim() === name;
        });
    }, actorName, { timeout: 15000 });
}

async function getGroupActorCount(page)
{
    return evaluateOrFallback(page, () =>
        game.actors.filter((actor) => Boolean(actor.flags?.["mob-tokens"]?.isGroupActor)).length
        , null, 0);
}

async function getGroupActorIdsForSource(page, sourceActorName)
{
    return evaluateOrFallback(page, (baseName) =>
    {
        const flagsKey = "mob-tokens";
        return game.actors
            .filter((actor) =>
            {
                if (!actor.flags?.[flagsKey]?.isGroupActor) return false;
                if (!baseName) return true;
                return (actor.flags?.[flagsKey]?.sourceActorName || "") === baseName;
            })
            .map((actor) => actor.id);
    }, sourceActorName, []);
}

async function deleteGroupActorsByIds(page, actorIds)
{
    await evaluateOrFallback(page, async (ids) =>
    {
        const uniqueIds = Array.from(new Set(ids || [])).filter(Boolean);
        for (const actorId of uniqueIds)
        {
            const actor = game.actors?.get(actorId);
            if (actor) await actor.delete();
        }
    }, actorIds, null);
}

module.exports = {
    deleteGroupActorsByIds,
    dismissQuickStartPromptIfPresent,
    ensureActorDirectoryEntry,
    getGroupActorIdsForSource,
    getGroupActorCount,
    loginToFoundry,
    openActorContextAction,
    openActorsSidebar,
    waitForActorEntryByName
};
