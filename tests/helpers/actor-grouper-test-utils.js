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

        const clickedFromDom = await page.evaluate((label) =>
        {
            const items = Array.from(document.querySelectorAll("#context-menu li, nav#context-menu li, .context li"));
            const target = items.find((item) => String(item.textContent ?? "").trim() === String(label));
            if (!target) return false;
            target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
            return true;
        }, actionLabel).catch(() => false);

        if (clickedFromDom) return;

        const contextItem = page.locator("#context-menu li, nav#context-menu li, .context li")
            .filter({ hasText: actionLabel })
            .first();

        if (await contextItem.isVisible().catch(() => false))
        {
            await contextItem.click({ force: true }).catch(() => undefined);
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

        let scene = null;
        let createdSceneId = null;
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

async function createFolderPartyProxyFixture(page, { folderMemberCount = 3, outsideMemberCount = 1 } = {})
{
    return page.evaluate(async ({ folderMemberCount: requestedFolderCount, outsideMemberCount: requestedOutsideCount }) =>
    {
        const folderMemberCount = Math.max(Number(requestedFolderCount) || 0, 2);
        const outsideMemberCount = Math.max(Number(requestedOutsideCount) || 0, 0);
        const actorType = game.system?.documentTypes?.Actor?.[0] ?? "character";
        const stamp = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;

        const folder = await Folder.create({
            name: `Party Folder ${stamp}`,
            type: "Actor"
        });

        const folderMemberIds = [];
        const outsideMemberIds = [];

        for (let index = 0; index < folderMemberCount; index++)
        {
            const actor = await Actor.create({
                name: `Folder Party Member ${index + 1} ${stamp}`,
                type: actorType,
                folder: folder.id
            }, { renderSheet: false });
            folderMemberIds.push(actor.id);
        }

        for (let index = 0; index < outsideMemberCount; index++)
        {
            const actor = await Actor.create({
                name: `Outside Party Member ${index + 1} ${stamp}`,
                type: actorType
            }, { renderSheet: false });
            outsideMemberIds.push(actor.id);
        }

        return {
            folderId: folder.id,
            folderMemberIds,
            outsideMemberIds
        };
    }, {
        folderMemberCount,
        outsideMemberCount
    });
}

async function createPartyPanelFixture(page, { memberCount = 2, reserveCount = 1 } = {})
{
    return page.evaluate(async ({ requestedMemberCount, requestedReserveCount }) =>
    {
        const memberCount = Math.max(Number(requestedMemberCount) || 0, 2);
        const reserveCount = Math.max(Number(requestedReserveCount) || 0, 0);
        const actorType = game.system?.documentTypes?.Actor?.[0] ?? "character";
        const flagsKey = "mob-tokens";
        const stamp = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;

        const createActor = async (name) => Actor.create({ name, type: actorType }, { renderSheet: false });

        const memberActors = [];
        for (let index = 0; index < memberCount; index++)
        {
            memberActors.push(await createActor(`Party Panel Member ${index + 1} ${stamp}`));
        }

        const reserveActors = [];
        for (let index = 0; index < reserveCount; index++)
        {
            reserveActors.push(await createActor(`Party Panel Reserve ${index + 1} ${stamp}`));
        }

        const sourceActor = memberActors[0];
        const actorData = sourceActor.toObject();
        delete actorData._id;
        actorData.name = `Party Panel Proxy ${stamp}`;
        actorData.prototypeToken ??= {};
        actorData.prototypeToken.name = actorData.name;
        actorData.prototypeToken.actorLink = true;

        actorData.flags ??= {};
        actorData.flags[flagsKey] = {
            ...(actorData.flags[flagsKey] ?? {}),
            isGroupActor: true,
            groupMode: "partyProxy",
            sourceActorId: sourceActor.id,
            sourceActorName: sourceActor.name,
            creatureCount: memberActors.length,
            remainingCount: memberActors.length,
            hpPerCreature: 0,
            maxGroupHP: 0,
            currentGroupHP: 0,
            moraleCheckedHalf: false,
            moraleRollTotal: null,
            moralePassed: null,
            isRouting: false,
            memberTokens: memberActors.map((actor) => ({
                actorId: actor.id,
                actorName: actor.name,
                tokenId: "",
                sceneId: String(canvas?.scene?.id ?? "")
            }))
        };

        const createdProxy = await Actor.create(actorData, { renderSheet: false });

        return {
            proxyActorId: createdProxy.id,
            memberActorIds: memberActors.map((actor) => actor.id),
            reserveActorIds: reserveActors.map((actor) => actor.id)
        };
    }, {
        requestedMemberCount: memberCount,
        requestedReserveCount: reserveCount
    });
}

async function openActorSheetForActorId(page, actorId)
{
    return page.evaluate(async (id) =>
    {
        const actor = game.actors?.get(id);
        if (!(actor instanceof Actor)) return null;

        actor.sheet.render(true);
        return {
            actorId: String(actor.id ?? "")
        };
    }, actorId);
}

async function getOpenActorSheetActorIds(page)
{
    return page.evaluate(() =>
    {
        return Object.values(ui?.windows ?? {})
            .map((app) => app?.actor ?? app?.document)
            .filter((actor) => actor instanceof Actor)
            .map((actor) => String(actor.id ?? ""));
    });
}

async function cleanupActorsAndFolders(page, { actorIds = [], folderIds = [] } = {})
{
    if (page?.isClosed?.()) return;

    await page.evaluate(async ({ rawActorIds, rawFolderIds }) =>
    {
        const actorIds = Array.from(new Set(rawActorIds || [])).filter(Boolean);
        const folderIds = Array.from(new Set(rawFolderIds || [])).filter(Boolean);

        for (const actorId of actorIds)
        {
            const actor = game.actors?.get(actorId);
            if (actor) await actor.delete();
        }

        for (const folderId of folderIds)
        {
            const folder = game.folders?.get(folderId);
            if (folder) await folder.delete({ deleteSubfolders: true, deleteContents: true });
        }
    }, {
        rawActorIds: actorIds,
        rawFolderIds: folderIds
    });
}

async function clickHudControl(page, selector)
{
    const control = page.locator(selector).first();
    const clicked = await control.click({ force: true }).then(() => true).catch(() => false);
    if (clicked) return;

    const clickedFromDom = await page.evaluate((targetSelector) =>
    {
        const target = document.querySelector(targetSelector);
        if (!target) return false;
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        return true;
    }, selector);

    if (!clickedFromDom)
    {
        throw new Error(`Unable to click HUD control '${selector}'.`);
    }
}

module.exports = {
    BASE_ACTOR_NAME,
    getGroupNameCounts,
    openActorContextActionById,
    waitForNewGroupActorId,
    setSplitIndividualsMode,
    waitForCondition,
    waitForWorldAndCanvasReady,
    setupGroupedTokensForHudTest,
    cleanupHudTestArtifacts,
    setupPartyTokensForProxyTest,
    cleanupPartyProxyTestArtifacts,
    bindTokenHudById,
    createFolderPartyProxyFixture,
    createPartyPanelFixture,
    openActorSheetForActorId,
    getOpenActorSheetActorIds,
    cleanupActorsAndFolders,
    clickHudControl
};
