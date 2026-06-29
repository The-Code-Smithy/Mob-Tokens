const { test, expect } = require("@playwright/test");
const {
    deleteGroupActorsByIds,
    dismissQuickStartPromptIfPresent,
    ensureActorDirectoryEntry,
    getGroupActorIdsForSource,
    getGroupActorCount,
    loginToFoundry,
    openActorContextAction,
    openActorsSidebar,
    waitForActorEntryByName
} = require("./helpers/foundry-ui");

const BASE_ACTOR_NAME = process.env.FOUNDRY_TARGET_ACTOR || "Rat, Giant";

async function getGroupNameCounts(page, baseName)
{
    return page.evaluate((sourceName) =>
    {
        const flagsKey = "mob-tokens";
        return game.actors
            .filter((actor) =>
            {
                if (!actor.flags?.[flagsKey]?.isGroupActor) return false;
                return (actor.flags?.[flagsKey]?.sourceActorName || "") === sourceName;
            })
            .reduce((acc, actor) =>
            {
                const name = String(actor.name || "");
                acc[name] = (acc[name] || 0) + 1;
                return acc;
            }, {});
    }, baseName);
}

async function openActorContextActionById(page, actorId, actionLabel)
{
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
            throw new Error(`Could not locate actor directory row for actor id '${actorId}'.`);
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

    throw new Error(`Could not open context action '${actionLabel}' for actor id '${actorId}'.`);
}

async function waitForNewGroupActorId(page, sourceName, baselineIds, creatureCount)
{
    const handle = await page.waitForFunction(({ baseName, previousIds, count }) =>
    {
        const previous = new Set(previousIds || []);
        const flagsKey = "mob-tokens";

        const match = game.actors.find((actor) =>
        {
            if (!actor.flags?.[flagsKey]?.isGroupActor) return false;
            if (previous.has(actor.id)) return false;
            if ((actor.flags?.[flagsKey]?.sourceActorName || "") !== baseName) return false;
            if (!Number.isInteger(count)) return true;
            return Number(actor.flags?.[flagsKey]?.creatureCount) === count;
        });

        return match?.id ?? null;
    }, { baseName: sourceName, previousIds: baselineIds, count: creatureCount }, { timeout: 30000 });

    return handle.jsonValue();
}

async function setSplitIndividualsMode(splitDialog, enabled)
{
    const checkbox = splitDialog.locator("[data-ag='split-individuals']");
    await checkbox.evaluate((node, value) =>
    {
        node.checked = Boolean(value);
        node.dispatchEvent(new Event("change", { bubbles: true }));
    }, enabled);
}

async function waitForCondition(check, timeoutMs = 120000, intervalMs = 500)
{
    const started = Date.now();
    while (Date.now() - started < timeoutMs)
    {
        if (await check()) return true;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return false;
}

async function waitForWorldAndCanvasReady(page, timeoutMs = 180000)
{
    await page.waitForFunction(() =>
    {
        const hasGame = typeof window !== "undefined" && Boolean(window.game);
        const hasUi = typeof window !== "undefined" && Boolean(window.ui);
        const gameReady = Boolean(window.game?.ready);
        const canvasReady = Boolean(window.canvas?.ready);
        const activeScene = Boolean(window.canvas?.scene);
        const loadingNotificationVisible = Array.from(document.querySelectorAll("#notifications .notification p"))
            .some((node) => /loading\s+/i.test(String(node?.textContent ?? "")));

        return hasGame
            && hasUi
            && gameReady
            && canvasReady
            && activeScene
            && !loadingNotificationVisible;
    }, null, { timeout: timeoutMs });
}

async function setupGroupedTokensForHudTest(page, baseActorName)
{
    return page.evaluate(async (sourceName) =>
    {
        const flagsKey = "mob-tokens";
        const normalize = (value) => String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();

        let sourceActor = game.actors.find((actor) => normalize(actor.name) === normalize(sourceName));
        if (!sourceActor)
        {
            const actorType = game.system?.documentTypes?.Actor?.[0] ?? "character";
            sourceActor = await Actor.create({ name: sourceName, type: actorType }, { renderSheet: false });
        }

        const hpPerCreature = Number(sourceActor.system?.attributes?.hp?.max)
            || Number(sourceActor.system?.hp?.max)
            || 1;

        const createdActors = [];
        for (let index = 0; index < 3; index++)
        {
            const actorData = sourceActor.toObject();
            delete actorData._id;
            actorData.name = `${sourceActor.name} x1 HUD ${Date.now()}-${index}`;
            actorData.flags ??= {};
            actorData.flags[flagsKey] = {
                ...(actorData.flags[flagsKey] ?? {}),
                isGroupActor: true,
                sourceActorId: sourceActor.id,
                sourceActorName: sourceActor.name,
                creatureCount: 1,
                remainingCount: 1,
                hpPerCreature,
                maxGroupHP: hpPerCreature,
                currentGroupHP: hpPerCreature,
                moraleCheckedHalf: false,
                moraleRollTotal: null,
                moralePassed: null,
                isRouting: false
            };

            actorData.prototypeToken ??= {};
            actorData.prototypeToken.name = actorData.name;
            actorData.prototypeToken.actorLink = true;

            const created = await Actor.create(actorData, { renderSheet: false });
            createdActors.push(created);
        }

        let scene = canvas?.scene;
        let createdSceneId = null;
        if (!scene)
        {
            const tempScene = await Scene.create({
                name: `Mob Tokens HUD Test ${Date.now()}`,
                navigation: false,
                active: true
            });
            await tempScene.activate();
            const started = Date.now();
            while (Date.now() - started < 15000)
            {
                const activeSceneId = canvas?.scene?.id;
                if (canvas?.ready && activeSceneId === tempScene.id) break;
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            scene = canvas?.scene;
            createdSceneId = tempScene.id;
        }

        if (!scene) throw new Error("No active scene available.");

        const startX = 1800;
        const startY = 900;
        const spacing = Number(canvas?.grid?.size) || 100;
        const tokenData = [];

        for (let index = 0; index < createdActors.length; index++)
        {
            const tokenDoc = await createdActors[index].getTokenDocument({
                x: startX + (spacing * index),
                y: startY
            });
            tokenData.push(tokenDoc.toObject());
        }

        const createdTokens = await scene.createEmbeddedDocuments("Token", tokenData);

        await canvas.tokens?.releaseAll();
        const tokenObjects = createdTokens
            .map((doc) => canvas.tokens?.get(doc.id))
            .filter(Boolean);

        tokenObjects.forEach((token, index) => token.control({ releaseOthers: index === 0 }));
        if (tokenObjects[0])
        {
            const tokenHud = ui?.hud?.token ?? canvas?.hud?.token;
            if (tokenHud?.bind)
            {
                await tokenHud.bind(tokenObjects[0]);
            }
        }

        return {
            actorIds: createdActors.map((actor) => actor.id),
            tokenIds: createdTokens.map((token) => token.id),
            createdSceneId
        };
    }, baseActorName);
}

async function cleanupHudTestArtifacts(page, payload)
{
    if (!payload) return;

    await page.evaluate(async ({ actorIds, tokenIds, createdSceneId }) =>
    {
        const scene = canvas?.scene;
        const uniqueTokenIds = Array.from(new Set(tokenIds || [])).filter(Boolean);
        const uniqueActorIds = Array.from(new Set(actorIds || [])).filter(Boolean);

        if (scene && uniqueTokenIds.length > 0)
        {
            await scene.deleteEmbeddedDocuments("Token", uniqueTokenIds);
        }

        for (const actorId of uniqueActorIds)
        {
            const actor = game.actors?.get(actorId);
            if (actor) await actor.delete();
        }

        if (createdSceneId)
        {
            const createdScene = game.scenes?.get(createdSceneId);
            if (createdScene) await createdScene.delete();
        }

        canvas.tokens?.releaseAll();
        ui.hud?.token?.clear();
    }, payload);
}

async function setupPartyTokensForProxyTest(page)
{
    return page.evaluate(async () =>
    {
        const actorType = game.system?.documentTypes?.Actor?.[0] ?? "character";
        const stamp = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        const createdActors = [];

        const createMember = async (suffix) =>
        {
            const actor = await Actor.create({
                name: `Party Proxy Member ${suffix} ${stamp}`,
                type: actorType
            }, { renderSheet: false });
            createdActors.push(actor);
            return actor;
        };

        const members = [
            await createMember("A"),
            await createMember("B")
        ];

        let scene = canvas?.scene;
        let createdSceneId = null;
        if (!scene)
        {
            const tempScene = await Scene.create({
                name: `Mob Tokens Party Proxy Test ${stamp}`,
                navigation: false,
                active: true
            });
            await tempScene.activate();
            const started = Date.now();
            while (Date.now() - started < 15000)
            {
                const activeSceneId = canvas?.scene?.id;
                if (canvas?.ready && activeSceneId === tempScene.id) break;
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            scene = canvas?.scene;
            createdSceneId = tempScene.id;
        }

        if (!scene) throw new Error("No active scene available.");

        const startX = 1500;
        const startY = 900;
        const spacing = Number(canvas?.grid?.size) || 100;
        const tokenData = [];

        for (let index = 0; index < members.length; index++)
        {
            const tokenDoc = await members[index].getTokenDocument({
                x: startX + (spacing * index),
                y: startY
            });
            tokenData.push(tokenDoc.toObject());
        }

        const createdTokens = await scene.createEmbeddedDocuments("Token", tokenData);

        await canvas.tokens?.releaseAll();
        const tokenObjects = createdTokens
            .map((doc) => canvas.tokens?.get(doc.id))
            .filter(Boolean);

        tokenObjects.forEach((token, index) => token.control({ releaseOthers: index === 0 }));
        if (tokenObjects[0])
        {
            const tokenHud = ui?.hud?.token ?? canvas?.hud?.token;
            if (tokenHud?.bind)
            {
                await tokenHud.bind(tokenObjects[0]);
            }
        }

        return {
            memberActorIds: members.map((actor) => actor.id),
            memberTokenIds: createdTokens.map((token) => token.id),
            createdSceneId
        };
    });
}

async function cleanupPartyProxyTestArtifacts(page, payload)
{
    if (!payload) return;
    if (page?.isClosed?.()) return;

    await page.evaluate(async ({ memberActorIds, memberTokenIds, createdSceneId }) =>
    {
        const flagsKey = "mob-tokens";
        const memberSet = new Set((memberActorIds || []).filter(Boolean));
        const proxies = game.actors.filter((actor) =>
        {
            const flags = actor.flags?.[flagsKey];
            if (!flags?.isGroupActor) return false;
            if (flags.groupMode !== "partyProxy") return false;

            const members = Array.isArray(flags.memberTokens) ? flags.memberTokens : [];
            return members.some((member) => memberSet.has(String(member?.actorId ?? "")));
        });

        const proxyActorIds = proxies.map((actor) => actor.id);
        const tokenIdsToDelete = new Set((memberTokenIds || []).filter(Boolean));
        const actorIdsToDelete = new Set([...memberSet, ...proxyActorIds]);

        const scene = canvas?.scene;
        if (scene)
        {
            for (const tokenDoc of scene.tokens.contents)
            {
                if (actorIdsToDelete.has(String(tokenDoc.actorId ?? "")))
                {
                    tokenIdsToDelete.add(tokenDoc.id);
                }
            }

            const ids = Array.from(tokenIdsToDelete);
            const existingIds = ids.filter((id) => scene.tokens.has(id));
            if (existingIds.length > 0)
            {
                await scene.deleteEmbeddedDocuments("Token", existingIds);
            }
        }

        for (const actorId of actorIdsToDelete)
        {
            const actor = game.actors?.get(actorId);
            if (actor) await actor.delete();
        }

        if (createdSceneId)
        {
            const createdScene = game.scenes?.get(createdSceneId);
            if (createdScene) await createdScene.delete();
        }

        canvas.tokens?.releaseAll();
        ui.hud?.token?.clear();
    }, payload);
}

async function bindTokenHudById(page, tokenId)
{
    return page.evaluate(async (id) =>
    {
        const token = canvas?.tokens?.get(id);
        if (!token) return false;

        await canvas.tokens?.releaseAll();
        token.control({ releaseOthers: true });

        const tokenHud = ui?.hud?.token ?? canvas?.hud?.token;
        if (tokenHud?.bind)
        {
            await tokenHud.bind(token);
        }

        return true;
    }, tokenId);
}

async function installNotificationCapture(page)
{
    if (page?.isClosed?.()) return;
    await page.evaluate(() =>
    {
        const notifications = ui?.notifications;
        if (!notifications) return;

        window.__mobTokensCapturedNotifications = [];

        if (!notifications.__mobTokensOriginalWarn)
        {
            notifications.__mobTokensOriginalWarn = notifications.warn?.bind(notifications);
        }
        if (!notifications.__mobTokensOriginalInfo)
        {
            notifications.__mobTokensOriginalInfo = notifications.info?.bind(notifications);
        }

        notifications.warn = (message, ...args) =>
        {
            window.__mobTokensCapturedNotifications.push({ level: "warn", message: String(message ?? "") });
            return notifications.__mobTokensOriginalWarn?.(message, ...args);
        };

        notifications.info = (message, ...args) =>
        {
            window.__mobTokensCapturedNotifications.push({ level: "info", message: String(message ?? "") });
            return notifications.__mobTokensOriginalInfo?.(message, ...args);
        };
    });
}

async function restoreNotificationCapture(page)
{
    if (page?.isClosed?.()) return;
    await page.evaluate(() =>
    {
        const notifications = ui?.notifications;
        if (!notifications) return;

        if (notifications.__mobTokensOriginalWarn)
        {
            notifications.warn = notifications.__mobTokensOriginalWarn;
            delete notifications.__mobTokensOriginalWarn;
        }
        if (notifications.__mobTokensOriginalInfo)
        {
            notifications.info = notifications.__mobTokensOriginalInfo;
            delete notifications.__mobTokensOriginalInfo;
        }
    });
}

test.describe("Actor Group module UI", () =>
{
    test("opens the Create Group dialog from actor directory context menu", async ({ page }) =>
    {
        const activePage = await loginToFoundry(page);
        await dismissQuickStartPromptIfPresent(activePage);
        await openActorsSidebar(activePage);
        await ensureActorDirectoryEntry(activePage, BASE_ACTOR_NAME);

        await openActorContextAction(activePage, BASE_ACTOR_NAME, "Create Group");

        const createDialog = activePage.locator(".window-app.dialog").filter({ hasText: "Create Group" }).last();
        await expect(createDialog).toBeVisible();
        await expect(createDialog.locator("[data-ag='create-creature-count']")).toBeVisible();
        await expect(createDialog.locator("[data-ag='create-hp-per-creature']")).toBeVisible();

        const cancelButton = createDialog.locator("button").filter({ hasText: "Cancel" }).first();
        await cancelButton.click();
    });

    test("creates and splits a group from UI dialogs", async ({ page }) =>
    {
        const activePage = await loginToFoundry(page);
        await dismissQuickStartPromptIfPresent(activePage);
        await openActorsSidebar(activePage);
        await ensureActorDirectoryEntry(activePage, BASE_ACTOR_NAME);

        const baselineIds = await getGroupActorIdsForSource(activePage, BASE_ACTOR_NAME);
        const baselineIdSet = new Set(baselineIds);

        try
        {
            const beforeCount = await getGroupActorCount(activePage);

            await openActorContextAction(activePage, BASE_ACTOR_NAME, "Create Group");

            const createDialog = activePage.locator(".window-app.dialog").filter({ hasText: "Create Group" }).last();
            await createDialog.locator("[data-ag='create-creature-count']").fill("7");

            const createButton = createDialog.locator("button").filter({ hasText: "Create" }).first();
            await createButton.click({ force: true });

            const splitTargetId = await waitForNewGroupActorId(activePage, BASE_ACTOR_NAME, baselineIds, 7);
            expect(splitTargetId).toBeTruthy();

            await openActorContextActionById(activePage, splitTargetId, "Split Group");

            const splitDialog = activePage.locator(".window-app.dialog").filter({ hasText: "Split Group" }).last();
            await setSplitIndividualsMode(splitDialog, false);
            await splitDialog.locator("[data-ag='split-group-count']").fill("2");
            await splitDialog.locator("[data-ag='split-counts']").fill("4,3");

            const splitButton = splitDialog.locator("button").filter({ hasText: "Split" }).first();
            await splitButton.click({ force: true });

            const splitOk = await waitForCondition(async () =>
            {
                const state = await activePage.evaluate(({ splitActorId, baseline, sourceName }) =>
                {
                    const flagsKey = "mob-tokens";
                    const splitActor = game.actors.get(splitActorId);
                    const splitRemaining = Number(splitActor?.flags?.[flagsKey]?.remainingCount || 0);

                    const hasCreatedX3 = game.actors.some((actor) =>
                    {
                        if (!actor.flags?.[flagsKey]?.isGroupActor) return false;
                        if (baseline.includes(actor.id)) return false;
                        if (actor.id === splitActorId) return false;
                        if ((actor.flags?.[flagsKey]?.sourceActorName || "") !== sourceName) return false;
                        return Number(actor.flags?.[flagsKey]?.creatureCount || 0) === 3;
                    });

                    return { splitRemaining, hasCreatedX3 };
                }, { splitActorId: splitTargetId, baseline: baselineIds, sourceName: BASE_ACTOR_NAME });

                return state.splitRemaining === 4 && state.hasCreatedX3;
            }, 120000, 500);

            expect(splitOk).toBe(true);

            const afterCount = await getGroupActorCount(activePage);
            expect(afterCount).toBeGreaterThanOrEqual(beforeCount + 1);
        }
        finally
        {
            const currentIds = await getGroupActorIdsForSource(activePage, BASE_ACTOR_NAME);
            const createdIds = currentIds.filter((id) => !baselineIdSet.has(id));
            if (createdIds.length > 0)
            {
                await deleteGroupActorsByIds(activePage, createdIds);
            }

            const afterCleanupIds = await getGroupActorIdsForSource(activePage, BASE_ACTOR_NAME);
            const remainingCreatedIds = afterCleanupIds.filter((id) => !baselineIdSet.has(id));
            expect(remainingCreatedIds.length).toBe(0);
        }
    });

    test("split dialog respects explicit counts when split-into-individuals is disabled", async ({ page }) =>
    {
        const activePage = await loginToFoundry(page);
        await dismissQuickStartPromptIfPresent(activePage);
        await openActorsSidebar(activePage);
        await ensureActorDirectoryEntry(activePage, BASE_ACTOR_NAME);

        const baselineIds = await getGroupActorIdsForSource(activePage, BASE_ACTOR_NAME);
        const baselineIdSet = new Set(baselineIds);

        try
        {
            await openActorContextAction(activePage, BASE_ACTOR_NAME, "Create Group");

            const createDialog = activePage.locator(".window-app.dialog").filter({ hasText: "Create Group" }).last();
            await createDialog.locator("[data-ag='create-creature-count']").fill("3");
            await createDialog.locator("button").filter({ hasText: "Create" }).first().click({ force: true });

            const splitTargetId = await waitForNewGroupActorId(activePage, BASE_ACTOR_NAME, baselineIds, 3);
            expect(splitTargetId).toBeTruthy();

            await openActorContextActionById(activePage, splitTargetId, "Split Group");

            const splitDialog = activePage.locator(".window-app.dialog").filter({ hasText: "Split Group" }).last();
            await setSplitIndividualsMode(splitDialog, false);

            await splitDialog.locator("[data-ag='split-group-count']").fill("2");
            await splitDialog.locator("[data-ag='split-counts']").fill("1,2");
            await splitDialog.locator("button").filter({ hasText: "Split" }).first().click({ force: true });

            await activePage.waitForFunction(({ splitActorId, baseline, sourceName }) =>
            {
                const flagsKey = "mob-tokens";
                const splitActor = game.actors.get(splitActorId);
                const splitRemaining = Number(splitActor?.flags?.[flagsKey]?.remainingCount || 0);

                const hasCreatedX2 = game.actors.some((actor) =>
                {
                    if (!actor.flags?.[flagsKey]?.isGroupActor) return false;
                    if (baseline.includes(actor.id)) return false;
                    if (actor.id === splitActorId) return false;
                    if ((actor.flags?.[flagsKey]?.sourceActorName || "") !== sourceName) return false;
                    return Number(actor.flags?.[flagsKey]?.creatureCount || 0) === 2;
                });

                return splitRemaining === 1 && hasCreatedX2;
            }, { splitActorId: splitTargetId, baseline: baselineIds, sourceName: BASE_ACTOR_NAME }, { timeout: 120000 });
        }
        finally
        {
            const currentIds = await getGroupActorIdsForSource(activePage, BASE_ACTOR_NAME);
            const createdIds = currentIds.filter((id) => !baselineIdSet.has(id));
            if (createdIds.length > 0)
            {
                await deleteGroupActorsByIds(activePage, createdIds);
            }
        }
    });

    test("split dialog can break a group into individual actors", async ({ page }) =>
    {
        const activePage = await loginToFoundry(page);
        await dismissQuickStartPromptIfPresent(activePage);
        await openActorsSidebar(activePage);
        await ensureActorDirectoryEntry(activePage, BASE_ACTOR_NAME);

        const baselineIds = await getGroupActorIdsForSource(activePage, BASE_ACTOR_NAME);
        const baselineIdSet = new Set(baselineIds);

        try
        {
            await openActorContextAction(activePage, BASE_ACTOR_NAME, "Create Group");

            const createDialog = activePage.locator(".window-app.dialog").filter({ hasText: "Create Group" }).last();
            await createDialog.locator("[data-ag='create-creature-count']").fill("4");
            await createDialog.locator("button").filter({ hasText: "Create" }).first().click({ force: true });

            const splitTargetId = await waitForNewGroupActorId(activePage, BASE_ACTOR_NAME, baselineIds, 4);
            expect(splitTargetId).toBeTruthy();

            await openActorContextActionById(activePage, splitTargetId, "Split Group");

            const splitDialog = activePage.locator(".window-app.dialog").filter({ hasText: "Split Group" }).last();
            await setSplitIndividualsMode(splitDialog, true);

            await splitDialog.locator("button").filter({ hasText: "Split" }).first().click({ force: true });

            const splitOk = await waitForCondition(async () =>
            {
                const state = await activePage.evaluate(({ splitActorId, baseline, sourceName }) =>
                {
                    const flagsKey = "mob-tokens";
                    const splitActor = game.actors.get(splitActorId);
                    const splitRemaining = Number(splitActor?.flags?.[flagsKey]?.remainingCount || 0);

                    const createdOnes = game.actors.filter((actor) =>
                    {
                        if (!actor.flags?.[flagsKey]?.isGroupActor) return false;
                        if (baseline.includes(actor.id)) return false;
                        if (actor.id === splitActorId) return false;
                        if ((actor.flags?.[flagsKey]?.sourceActorName || "") !== sourceName) return false;
                        return Number(actor.flags?.[flagsKey]?.creatureCount || 0) === 1;
                    }).length;

                    return { splitRemaining, createdOnes };
                }, { splitActorId: splitTargetId, baseline: baselineIds, sourceName: BASE_ACTOR_NAME });

                return state.splitRemaining === 1 && state.createdOnes >= 3;
            }, 120000, 500);

            expect(splitOk).toBe(true);
        }
        finally
        {
            const currentIds = await getGroupActorIdsForSource(activePage, BASE_ACTOR_NAME);
            const createdIds = currentIds.filter((id) => !baselineIdSet.has(id));
            if (createdIds.length > 0)
            {
                await deleteGroupActorsByIds(activePage, createdIds);
            }
        }
    });

    test("shows regroup HUD button for selected split-group tokens from same source", async ({ page }) =>
    {
        const activePage = await loginToFoundry(page);
        await dismissQuickStartPromptIfPresent(activePage);

        let artifacts = null;
        try
        {
            artifacts = await setupGroupedTokensForHudTest(activePage, BASE_ACTOR_NAME);

            await activePage.waitForFunction(() =>
            {
                const button = document.querySelector(".control-icon.mob-tokens-create-group");
                return Boolean(button && button.offsetParent !== null);
            }, null, { timeout: 15000 });

            const hudButton = activePage.locator(".control-icon.mob-tokens-create-group").first();
            await expect(hudButton).toBeVisible();
        }
        finally
        {
            await cleanupHudTestArtifacts(activePage, artifacts);
        }
    });
});

test.describe("Party Proxy group UI flow", () =>
{
    test("creates, moves, and splits a party proxy group from HUD", async ({ page }) =>
    {
        const activePage = await loginToFoundry(page);
        await dismissQuickStartPromptIfPresent(activePage);
        await waitForWorldAndCanvasReady(activePage);

        let artifacts = null;
        try
        {
            artifacts = await setupPartyTokensForProxyTest(activePage);

            await activePage.waitForFunction(() =>
            {
                const button = document.querySelector(".control-icon.mob-tokens-create-party-group");
                return Boolean(button && button.offsetParent !== null);
            }, null, { timeout: 60000 });

            await activePage.evaluate(() =>
            {
                const button = document.querySelector(".control-icon.mob-tokens-create-party-group");
                button?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            });

            await activePage.waitForFunction(() =>
                Boolean(document.querySelector(".window-app.dialog [data-ag='create-party-group-name']"))
                , null, { timeout: 60000 });

            const createDialog = activePage.locator(".window-app.dialog [data-ag='create-party-group-name']").last();

            const proxyName = `Party Proxy Test ${Date.now()}`;
            await createDialog.fill(proxyName);
            await activePage.evaluate(() =>
            {
                const dialogs = Array.from(document.querySelectorAll(".window-app.dialog"));
                const dialog = dialogs.find((entry) => entry.querySelector("[data-ag='create-party-group-name']"));
                const createButton = dialog?.querySelector("button.default, button[type='submit'], button");
                createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            });

            const created = await activePage.waitForFunction((payload) =>
            {
                const flagsKey = "mob-tokens";
                const memberSet = new Set(payload.memberActorIds || []);
                const actor = game.actors.find((candidate) =>
                {
                    const flags = candidate.flags?.[flagsKey];
                    if (!flags?.isGroupActor) return false;
                    if (flags.groupMode !== "partyProxy") return false;
                    if (candidate.name !== payload.proxyName) return false;

                    const members = Array.isArray(flags.memberTokens) ? flags.memberTokens : [];
                    if (members.length !== memberSet.size) return false;
                    return members.every((member) => memberSet.has(String(member?.actorId ?? "")));
                });

                if (!actor) return null;
                const token = canvas?.scene?.tokens?.find((tokenDoc) => String(tokenDoc.actorId ?? "") === actor.id);
                return token
                    ? { actorId: actor.id, tokenId: token.id }
                    : null;
            }, {
                memberActorIds: artifacts.memberActorIds,
                proxyName
            }, { timeout: 30000 });

            const createdData = await created.jsonValue();
            expect(createdData?.actorId).toBeTruthy();
            expect(createdData?.tokenId).toBeTruthy();

            await activePage.waitForFunction((ids) =>
            {
                const docs = canvas?.scene?.tokens ?? [];
                return ids.every((id) => !docs.get(id));
            }, artifacts.memberTokenIds, { timeout: 20000 });

            const movedPosition = await activePage.evaluate(async (tokenId) =>
            {
                const tokenDoc = canvas?.scene?.tokens?.get(tokenId);
                if (!tokenDoc) return null;

                const beforeX = Number(tokenDoc.x);
                const beforeY = Number(tokenDoc.y);
                const nextX = Number(tokenDoc.x) + 200;
                const nextY = Number(tokenDoc.y) + 100;
                await tokenDoc.update({ x: nextX, y: nextY });
                return {
                    beforeX,
                    beforeY,
                    afterX: Number(tokenDoc.x),
                    afterY: Number(tokenDoc.y)
                };
            }, createdData.tokenId);

            expect(movedPosition).toBeTruthy();

            const bound = await bindTokenHudById(activePage, createdData.tokenId);
            expect(bound).toBe(true);

            await activePage.waitForFunction(() =>
            {
                const button = document.querySelector(".control-icon.mob-tokens-split-party-group");
                return Boolean(button && button.offsetParent !== null);
            }, null, { timeout: 60000 });

            await activePage.evaluate(() =>
            {
                const button = document.querySelector(".control-icon.mob-tokens-split-party-group");
                button?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            });

            await activePage.waitForFunction((payload) =>
            {
                const actor = game.actors?.get(payload.proxyActorId);
                if (actor) return false;

                const proxyToken = canvas?.scene?.tokens?.get(payload.proxyTokenId);
                if (proxyToken) return false;

                const memberTokens = (canvas?.scene?.tokens?.contents || []).filter((tokenDoc) =>
                    payload.memberActorIds.includes(String(tokenDoc.actorId ?? ""))
                );
                if (memberTokens.length !== payload.memberActorIds.length) return false;

                return true;
            }, {
                proxyActorId: createdData.actorId,
                proxyTokenId: createdData.tokenId,
                memberActorIds: artifacts.memberActorIds
            }, { timeout: 30000 });
        }
        finally
        {
            await cleanupPartyProxyTestArtifacts(activePage, artifacts);
        }
    });

    test("split warns when one party proxy member actor is missing", async ({ page }) =>
    {
        const activePage = await loginToFoundry(page);
        await dismissQuickStartPromptIfPresent(activePage);
        await waitForWorldAndCanvasReady(activePage);

        let artifacts = null;
        try
        {
            artifacts = await setupPartyTokensForProxyTest(activePage);
            await installNotificationCapture(activePage);

            await activePage.waitForFunction(() =>
            {
                const button = document.querySelector(".control-icon.mob-tokens-create-party-group");
                return Boolean(button && button.offsetParent !== null);
            }, null, { timeout: 60000 });

            await activePage.evaluate(() =>
            {
                const button = document.querySelector(".control-icon.mob-tokens-create-party-group");
                button?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            });
            await activePage.waitForFunction(() =>
                Boolean(document.querySelector(".window-app.dialog [data-ag='create-party-group-name']"))
                , null, { timeout: 60000 });
            await activePage.evaluate(() =>
            {
                const dialogs = Array.from(document.querySelectorAll(".window-app.dialog"));
                const dialog = dialogs.find((entry) => entry.querySelector("[data-ag='create-party-group-name']"));
                const createButton = dialog?.querySelector("button.default, button[type='submit'], button");
                createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            });

            const created = await activePage.waitForFunction((memberActorIds) =>
            {
                const flagsKey = "mob-tokens";
                const memberSet = new Set(memberActorIds || []);
                const actor = game.actors.find((candidate) =>
                {
                    const flags = candidate.flags?.[flagsKey];
                    if (!flags?.isGroupActor) return false;
                    if (flags.groupMode !== "partyProxy") return false;

                    const members = Array.isArray(flags.memberTokens) ? flags.memberTokens : [];
                    if (members.length !== memberSet.size) return false;
                    return members.every((member) => memberSet.has(String(member?.actorId ?? "")));
                });

                if (!actor) return null;
                const token = canvas?.scene?.tokens?.find((tokenDoc) => String(tokenDoc.actorId ?? "") === actor.id);
                return token
                    ? { actorId: actor.id, tokenId: token.id }
                    : null;
            }, artifacts.memberActorIds, { timeout: 30000 });

            const createdData = await created.jsonValue();
            expect(createdData?.actorId).toBeTruthy();
            expect(createdData?.tokenId).toBeTruthy();

            await activePage.evaluate(async (missingActorId) =>
            {
                const actor = game.actors?.get(missingActorId);
                if (actor) await actor.delete();
            }, artifacts.memberActorIds[0]);

            const bound = await bindTokenHudById(activePage, createdData.tokenId);
            expect(bound).toBe(true);

            await activePage.waitForFunction(() =>
            {
                const button = document.querySelector(".control-icon.mob-tokens-split-party-group");
                return Boolean(button && button.offsetParent !== null);
            }, null, { timeout: 60000 });

            await activePage.evaluate(() =>
            {
                const button = document.querySelector(".control-icon.mob-tokens-split-party-group");
                button?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            });

            await activePage.waitForFunction((payload) =>
            {
                const actor = game.actors?.get(payload.proxyActorId);
                if (actor) return false;
                const proxyToken = canvas?.scene?.tokens?.get(payload.proxyTokenId);
                if (proxyToken) return false;
                return true;
            }, {
                proxyActorId: createdData.actorId,
                proxyTokenId: createdData.tokenId
            }, { timeout: 30000 });

            const warningSeen = await activePage.evaluate(() =>
            {
                const entries = Array.isArray(window.__mobTokensCapturedNotifications)
                    ? window.__mobTokensCapturedNotifications
                    : [];
                return entries.some((entry) =>
                    entry.level === "warn"
                    && String(entry.message || "").toLowerCase().includes("missing")
                );
            });

            expect(warningSeen).toBe(true);
        }
        finally
        {
            await restoreNotificationCapture(activePage);
            await cleanupPartyProxyTestArtifacts(activePage, artifacts);
        }
    });

    test.fixme("creates a party proxy group from Actor Directory searchable picker", async ({ page }) =>
    {
        const activePage = await loginToFoundry(page);
        await dismissQuickStartPromptIfPresent(activePage);
        await openActorsSidebar(activePage);

        const seed = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        const actorNames = [
            `Party Picker Alpha ${seed}`,
            `Party Picker Bravo ${seed}`
        ];

        let createdActorIds = [];
        let createdProxyActorId = null;
        try
        {
            createdActorIds = await activePage.evaluate(async (names) =>
            {
                const actorType = game.system?.documentTypes?.Actor?.[0] ?? "character";
                const ids = [];
                for (const name of names)
                {
                    const actor = await Actor.create({ name, type: actorType }, { renderSheet: false });
                    ids.push(actor.id);
                }
                return ids;
            }, actorNames);

            const openedFromApi = await activePage.evaluate(async (actorId) =>
            {
                const actor = game.actors?.get(actorId);
                if (!(actor instanceof Actor)) return false;

                const api = game.modules?.get("mob-tokens")?.api;
                if (typeof api?.openCreatePartyGroupFromActorsDialog === "function")
                {
                    await api.openCreatePartyGroupFromActorsDialog(actor);
                    return true;
                }

                const options = [];
                Hooks.call("getActorContextOptions", null, options);
                const label = game.i18n.localize("MOBTOKENS.ContextCreatePartyGroup");
                const option = options.find((entry) => entry?.label === label || entry?.name === label);
                if (!option || typeof option.onClick !== "function") return false;

                const li = document.createElement("li");
                li.dataset.documentId = actor.id;
                if (typeof option.visible === "function" && !option.visible(li)) return false;

                await option.onClick(new MouseEvent("contextmenu"), li);
                return true;
            }, createdActorIds[0]);
            expect(openedFromApi).toBe(true);

            const dialog = activePage.locator(".window-app.dialog").filter({ hasText: "Create Party Group" }).last();
            await expect(dialog).toBeVisible();

            await dialog.locator("[data-ag='party-actor-filter']").fill("party picker");

            await activePage.evaluate((names) =>
            {
                const dialogs = Array.from(document.querySelectorAll(".window-app.dialog"));
                const root = dialogs.find((entry) => entry.querySelector("[data-ag='party-actor-list']"));
                if (!root) return;

                const checkboxes = Array.from(root.querySelectorAll("input[name='memberActorIds']"));
                for (const input of checkboxes)
                {
                    const row = input.closest("[data-ag='party-actor-option']");
                    const rowText = String(row?.textContent ?? "");
                    input.checked = names.some((name) => rowText.includes(name));
                    input.dispatchEvent(new Event("change", { bubbles: true }));
                }
            }, actorNames);

            await dialog.locator("button").filter({ hasText: "Create" }).first().click({ force: true });

            const handle = await activePage.waitForFunction((memberIds) =>
            {
                const flagsKey = "mob-tokens";
                const memberSet = new Set(memberIds || []);

                const match = game.actors.find((actor) =>
                {
                    const flags = actor.flags?.[flagsKey];
                    if (!flags?.isGroupActor) return false;
                    if (flags.groupMode !== "partyProxy") return false;

                    const members = Array.isArray(flags.memberTokens) ? flags.memberTokens : [];
                    if (members.length !== memberSet.size) return false;
                    return members.every((member) => memberSet.has(String(member?.actorId ?? "")));
                });

                if (!match) return null;
                const token = canvas?.scene?.tokens?.find((tokenDoc) => String(tokenDoc.actorId ?? "") === match.id);
                return {
                    actorId: match.id,
                    hasSceneToken: Boolean(token)
                };
            }, createdActorIds, { timeout: 30000 });

            const created = await handle.jsonValue();
            expect(created?.actorId).toBeTruthy();
            expect(created?.hasSceneToken).toBe(false);
            createdProxyActorId = created.actorId;
        }
        finally
        {
            await activePage.evaluate(async ({ actorIds, proxyActorId }) =>
            {
                const ids = Array.from(new Set([...(actorIds || []), proxyActorId].filter(Boolean)));
                for (const id of ids)
                {
                    const actor = game.actors?.get(id);
                    if (actor) await actor.delete();
                }
            }, {
                actorIds: createdActorIds,
                proxyActorId: createdProxyActorId
            });
        }
    });
});
