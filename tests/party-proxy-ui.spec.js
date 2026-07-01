const { test, expect } = require("@playwright/test");
const {
    dismissQuickStartPromptIfPresent,
    loginToFoundry,
    openActorsSidebar
} = require("./helpers/foundry-ui");
const {
    waitForWorldAndCanvasReady,
    setupPartyTokensForProxyTest,
    cleanupPartyProxyTestArtifacts,
    bindTokenHudById,
    createFolderPartyProxyFixture,
    createPartyPanelFixture,
    openActorSheetForActorId,
    getOpenActorSheetActorIds,
    cleanupActorsAndFolders,
    clickHudControl
} = require("./helpers/actor-grouper-test-utils");

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

            await clickHudControl(activePage, ".control-icon.mob-tokens-create-party-group");

            const createDialog = activePage
                .locator("dialog, .window-app.dialog")
                .filter({ has: activePage.locator("[data-ag='create-party-group-name']") })
                .last();
            await expect(createDialog).toBeVisible({ timeout: 60000 });
            await expect(createDialog.locator("[data-ag='create-party-group-name']").first()).toBeVisible();

            const proxyName = `Party Proxy Test ${Date.now()}`;
            await createDialog.locator("[data-ag='create-party-group-name']").fill(proxyName);
            await createDialog.locator("button").filter({ hasText: "Create" }).first().click({ force: true });

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

            await clickHudControl(activePage, ".control-icon.mob-tokens-split-party-group");

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

    test("[gate] registers folder context action and shows it only for folders with at least two eligible actors", async ({ page }) =>
    {
        const activePage = await loginToFoundry(page);
        await dismissQuickStartPromptIfPresent(activePage);
        await openActorsSidebar(activePage);

        let fixture = null;
        let singleFolderActorId = null;
        let singleFolderId = null;
        try
        {
            fixture = await createFolderPartyProxyFixture(activePage, {
                folderMemberCount: 3,
                outsideMemberCount: 1
            });

            const singleFolderData = await activePage.evaluate(async () =>
            {
                const actorType = game.system?.documentTypes?.Actor?.[0] ?? "character";
                const stamp = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
                const folder = await Folder.create({
                    name: `Party Folder Single ${stamp}`,
                    type: "Actor"
                });
                const actor = await Actor.create({
                    name: `Single Folder Member ${stamp}`,
                    type: actorType,
                    folder: folder.id
                }, { renderSheet: false });

                return {
                    folderId: folder.id,
                    actorId: actor.id
                };
            });
            singleFolderId = singleFolderData?.folderId ?? null;
            singleFolderActorId = singleFolderData?.actorId ?? null;

            const contextActionResult = await activePage.evaluate(({ validFolderId, invalidFolderId }) =>
            {
                const options = [];
                Hooks.call("getActorDirectoryFolderContext", null, options);
                Hooks.call("getDocumentDirectoryFolderContext", null, options);
                Hooks.call("getFolderContextOptions", { collection: game.actors, documentName: "Actor" }, options);

                const label = game.i18n.localize("MOBTOKENS.ContextCreatePartyGroupFromFolder");
                const option = options.find((entry) => entry?.label === label || entry?.name === label);
                if (!option) return { opened: false, reason: "missing-option" };

                const liValid = document.createElement("li");
                liValid.dataset.folderId = validFolderId;

                const liInvalid = document.createElement("li");
                liInvalid.dataset.folderId = invalidFolderId;

                const validVisible = typeof option.visible === "function" ? option.visible(liValid) : true;
                const invalidVisible = typeof option.visible === "function" ? option.visible(liInvalid) : true;

                return {
                    hasOption: true,
                    validVisible: Boolean(validVisible),
                    invalidVisible: Boolean(invalidVisible)
                };
            }, {
                validFolderId: fixture.folderId,
                invalidFolderId: singleFolderId
            });

            expect(contextActionResult?.hasOption).toBe(true);
            expect(contextActionResult?.validVisible).toBe(true);
            expect(contextActionResult?.invalidVisible).toBe(false);
        }
        finally
        {
            await cleanupActorsAndFolders(activePage, {
                actorIds: [
                    ...(fixture?.folderMemberIds ?? []),
                    ...(fixture?.outsideMemberIds ?? []),
                    singleFolderActorId
                ],
                folderIds: [fixture?.folderId, singleFolderId]
            });
        }
    });

    test("[gate] adds a party member via drag and drop without opening another actor sheet", async ({ page }) =>
    {
        const activePage = await loginToFoundry(page);
        await dismissQuickStartPromptIfPresent(activePage);

        let fixture = null;
        try
        {
            fixture = await createPartyPanelFixture(activePage, {
                memberCount: 2,
                reserveCount: 1
            });

            const openedSheet = await openActorSheetForActorId(activePage, fixture.proxyActorId);
            expect(openedSheet?.actorId).toBeTruthy();

            await activePage.waitForFunction(() =>
                Boolean(document.querySelector(".mob-tokens-party-panel"))
                , null, { timeout: 30000 });

            const beforeOpenActorSheetIds = await getOpenActorSheetActorIds(activePage);

            await activePage.evaluate((actorIdToDrop) =>
            {
                const panel = document.querySelector(".mob-tokens-party-panel");
                const dropZone = panel?.querySelector("[data-ag-section='party-members']")
                    ?? panel?.querySelector("[data-ag-section='party-dropzone']");
                if (!dropZone) return;

                const dropEvent = new Event("drop", { bubbles: true, cancelable: true });
                const payload = JSON.stringify({ type: "Actor", id: String(actorIdToDrop) });
                Object.defineProperty(dropEvent, "dataTransfer", {
                    value: {
                        getData: (mime) => (mime === "text/plain" || mime === "application/json") ? payload : "",
                        dropEffect: "copy"
                    }
                });

                dropZone.dispatchEvent(dropEvent);
            }, fixture.reserveActorIds[0]);

            await activePage.waitForFunction(({ proxyActorId, addedActorId }) =>
            {
                const actor = game.actors?.get(proxyActorId);
                const members = Array.isArray(actor?.flags?.["mob-tokens"]?.memberTokens)
                    ? actor.flags["mob-tokens"].memberTokens
                    : [];
                return members.some((member) => String(member?.actorId ?? "") === String(addedActorId));
            }, {
                proxyActorId: fixture.proxyActorId,
                addedActorId: fixture.reserveActorIds[0]
            }, { timeout: 30000 });

            const afterOpenActorSheetIds = await getOpenActorSheetActorIds(activePage);
            expect(new Set(afterOpenActorSheetIds)).toEqual(new Set(beforeOpenActorSheetIds));
            expect(afterOpenActorSheetIds.includes(String(fixture.reserveActorIds[0]))).toBe(false);
        }
        finally
        {
            await cleanupActorsAndFolders(activePage, {
                actorIds: [
                    fixture?.proxyActorId,
                    ...(fixture?.memberActorIds ?? []),
                    ...(fixture?.reserveActorIds ?? [])
                ]
            });
        }
    });

    test("[gate] removes a party member without opening member sheets or reverting dedicated party layout", async ({ page }) =>
    {
        const activePage = await loginToFoundry(page);
        await dismissQuickStartPromptIfPresent(activePage);

        let fixture = null;
        try
        {
            fixture = await createPartyPanelFixture(activePage, {
                memberCount: 3,
                reserveCount: 0
            });

            const removedActorId = String(fixture.memberActorIds[0]);

            const openedSheet = await openActorSheetForActorId(activePage, fixture.proxyActorId);
            expect(openedSheet?.actorId).toBeTruthy();

            await activePage.waitForFunction(() =>
                Boolean(document.querySelector(".mob-tokens-party-panel"))
                , null, { timeout: 30000 });

            const beforeOpenActorSheetIds = await getOpenActorSheetActorIds(activePage);

            await activePage.evaluate((targetActorId) =>
            {
                const row = document.querySelector(`[data-ag-party-member-row='${targetActorId}']`);
                const button = row?.querySelector("[data-ag-action='remove-party-member']");
                button?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            }, removedActorId);

            await activePage.waitForFunction(({ proxyActorId, removedId }) =>
            {
                const actor = game.actors?.get(proxyActorId);
                const members = Array.isArray(actor?.flags?.["mob-tokens"]?.memberTokens)
                    ? actor.flags["mob-tokens"].memberTokens
                    : [];
                return members.every((member) => String(member?.actorId ?? "") !== String(removedId));
            }, {
                proxyActorId: fixture.proxyActorId,
                removedId: removedActorId
            }, { timeout: 30000 });

            const afterOpenActorSheetIds = await getOpenActorSheetActorIds(activePage);
            expect(new Set(afterOpenActorSheetIds)).toEqual(new Set(beforeOpenActorSheetIds));
            expect(afterOpenActorSheetIds.includes(removedActorId)).toBe(false);

            const layoutState = await activePage.evaluate(() =>
            {
                const host = Array.from(document.querySelectorAll(".window-app, .application"))
                    .find((entry) => entry.querySelector(".mob-tokens-party-panel"))
                    ?? document.querySelector(".window-app, .application");
                if (!host) return null;
                return {
                    hasPartyLayoutClass: host.classList.contains("mob-tokens-party-sheet-layout"),
                    partyPanelCount: host.querySelectorAll(".mob-tokens-party-panel").length,
                    genericPanelCount: host.querySelectorAll(".mob-tokens-panel").length
                };
            });

            expect(layoutState?.hasPartyLayoutClass).toBe(true);
            expect(layoutState?.partyPanelCount).toBe(1);
            expect(layoutState?.genericPanelCount).toBe(1);
        }
        finally
        {
            await cleanupActorsAndFolders(activePage, {
                actorIds: [
                    fixture?.proxyActorId,
                    ...(fixture?.memberActorIds ?? []),
                    ...(fixture?.reserveActorIds ?? [])
                ]
            });
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
