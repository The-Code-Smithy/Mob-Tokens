const { test, expect } = require("@playwright/test");
const {
    deleteGroupActorsByIds,
    dismissQuickStartPromptIfPresent,
    ensureActorDirectoryEntry,
    getGroupActorIdsForSource,
    loginToFoundry,
    openActorContextAction,
    openActorsSidebar
} = require("./helpers/foundry-ui");
const {
    BASE_ACTOR_NAME,
    openActorContextActionById,
    waitForNewGroupActorId,
    setSplitIndividualsMode,
    setupGroupedTokensForHudTest,
    cleanupHudTestArtifacts
} = require("./helpers/actor-grouper-test-utils");

test.describe("Actor Group module UI", () =>
{
    test("opens the Create Group dialog from actor directory context menu", async ({ page }) =>
    {
        const activePage = await loginToFoundry(page);
        await dismissQuickStartPromptIfPresent(activePage);
        await openActorsSidebar(activePage);
        await ensureActorDirectoryEntry(activePage, BASE_ACTOR_NAME);

        await openActorContextAction(activePage, BASE_ACTOR_NAME, "Create Group");

        const createDialog = activePage.locator("dialog, .window-app.dialog").filter({ hasText: "Create Group" }).last();
        await expect(createDialog).toBeVisible();
        await expect(createDialog.locator("[data-ag='create-creature-count']")).toBeVisible();
        await expect(createDialog.locator("[data-ag='create-hp-per-creature']")).toBeVisible();

        const cancelButton = createDialog.locator("button").filter({ hasText: "Cancel" }).first();
        await cancelButton.click();
    });

    test("[gate] creates and splits a group from UI dialogs", async ({ page }) =>
    {
        const activePage = await loginToFoundry(page);
        await dismissQuickStartPromptIfPresent(activePage);
        await openActorsSidebar(activePage);
        const sourceActorName = `Playwright Split Source ${Date.now()}`;
        const sourceActorId = await ensureActorDirectoryEntry(activePage, sourceActorName);

        try
        {
            await openActorContextAction(activePage, sourceActorName, "Create Group");

            const createDialog = activePage.locator("dialog, .window-app.dialog").filter({ hasText: "Create Group" }).last();
            await expect(createDialog).toBeVisible();
            const createCountInput = createDialog.locator("[data-ag='create-creature-count']");
            await createCountInput.fill("7");
            await expect(createCountInput).toHaveValue("7");

            const createButton = createDialog.locator("button").filter({ hasText: "Create" }).first();
            await createButton.click({ force: true });

            await activePage.waitForFunction((sourceName) =>
            {
                const flagsKey = "mob-tokens";
                return game.actors.some((actor) =>
                    actor.flags?.[flagsKey]?.isGroupActor
                    && (actor.flags?.[flagsKey]?.sourceActorName || "") === sourceName
                );
            }, sourceActorName, { timeout: 45000 });

            const splitTargetId = await activePage.evaluate((sourceName) =>
            {
                const flagsKey = "mob-tokens";
                const actor = game.actors.find((candidate) =>
                    candidate.flags?.[flagsKey]?.isGroupActor
                    && (candidate.flags?.[flagsKey]?.sourceActorName || "") === sourceName
                );
                return actor?.id ?? null;
            }, sourceActorName);
            expect(splitTargetId).toBeTruthy();

            const createdCount = await activePage.evaluate((actorId) =>
            {
                const flagsKey = "mob-tokens";
                const actor = game.actors.get(actorId);
                return Number(actor?.flags?.[flagsKey]?.creatureCount || 0);
            }, splitTargetId);
            expect(createdCount).toBe(7);

            await openActorContextActionById(activePage, splitTargetId, "Split Group");

            const splitDialog = activePage.locator("dialog, .window-app.dialog").filter({ hasText: "Split Group" }).last();
            await expect(splitDialog).toBeVisible();
            await setSplitIndividualsMode(splitDialog, false);
            await splitDialog.locator("[data-ag='split-group-count']").fill("2");
            await splitDialog.locator("[data-ag='split-counts']").fill("4,3");

            const splitButton = splitDialog.locator("button").filter({ hasText: "Split" }).first();
            await splitButton.click({ force: true });

            await activePage.waitForFunction(({ splitActorId, sourceName }) =>
            {
                const flagsKey = "mob-tokens";
                const splitActor = game.actors.get(splitActorId);
                const splitRemaining = Number(splitActor?.flags?.[flagsKey]?.remainingCount || 0);

                const hasCreatedX3 = game.actors.some((actor) =>
                {
                    if (!actor.flags?.[flagsKey]?.isGroupActor) return false;
                    if (actor.id === splitActorId) return false;
                    if ((actor.flags?.[flagsKey]?.sourceActorName || "") !== sourceName) return false;
                    return Number(actor.flags?.[flagsKey]?.creatureCount || 0) === 3;
                });

                return splitRemaining === 4 && hasCreatedX3;
            }, { splitActorId: splitTargetId, sourceName: sourceActorName }, { timeout: 120000 });
        }
        finally
        {
            await activePage.evaluate(async ({ sourceName, sourceId }) =>
            {
                const flagsKey = "mob-tokens";
                const groupActors = game.actors.filter((actor) =>
                    actor.flags?.[flagsKey]?.isGroupActor
                    && (actor.flags?.[flagsKey]?.sourceActorName || "") === sourceName
                );

                for (const actor of groupActors)
                {
                    await actor.delete();
                }

                const sourceActor = game.actors.get(sourceId);
                if (sourceActor) await sourceActor.delete();
            }, {
                sourceName: sourceActorName,
                sourceId: sourceActorId
            });
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

            const createDialog = activePage.locator("dialog, .window-app.dialog").filter({ hasText: "Create Group" }).last();
            await expect(createDialog).toBeVisible();
            await createDialog.locator("[data-ag='create-creature-count']").fill("3");
            await createDialog.locator("button").filter({ hasText: "Create" }).first().click({ force: true });

            const splitTargetId = await waitForNewGroupActorId(activePage, BASE_ACTOR_NAME, baselineIds, 3);
            expect(splitTargetId).toBeTruthy();

            await openActorContextActionById(activePage, splitTargetId, "Split Group");

            const splitDialog = activePage.locator("dialog, .window-app.dialog").filter({ hasText: "Split Group" }).last();
            await expect(splitDialog).toBeVisible();
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

            const createDialog = activePage.locator("dialog, .window-app.dialog").filter({ hasText: "Create Group" }).last();
            await expect(createDialog).toBeVisible();
            await createDialog.locator("[data-ag='create-creature-count']").fill("4");
            await createDialog.locator("button").filter({ hasText: "Create" }).first().click({ force: true });

            const splitTargetId = await waitForNewGroupActorId(activePage, BASE_ACTOR_NAME, baselineIds, 4);
            expect(splitTargetId).toBeTruthy();

            await openActorContextActionById(activePage, splitTargetId, "Split Group");

            const splitDialog = activePage.locator("dialog, .window-app.dialog").filter({ hasText: "Split Group" }).last();
            await expect(splitDialog).toBeVisible();
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


