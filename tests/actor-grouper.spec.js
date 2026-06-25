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
        const flagsKey = "actor-group";
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
        const flagsKey = "actor-group";

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

async function setupGroupedTokensForHudTest(page, baseActorName)
{
    return page.evaluate(async (sourceName) =>
    {
        const flagsKey = "actor-group";
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
                    const flagsKey = "actor-group";
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
                const flagsKey = "actor-group";
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
                    const flagsKey = "actor-group";
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
