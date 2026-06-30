function getGridSize()
{
    return Number(canvas?.grid?.size) || 100;
}

function getSceneRect()
{
    const dimensions = canvas?.dimensions;
    if (!dimensions) return null;

    const x = Number(dimensions.sceneX) || 0;
    const y = Number(dimensions.sceneY) || 0;
    const width = Number(dimensions.sceneWidth) || 0;
    const height = Number(dimensions.sceneHeight) || 0;

    return {
        minX: x,
        minY: y,
        maxX: x + width,
        maxY: y + height
    };
}

function getTokenPixelSize(tokenDoc, gridSize)
{
    const widthUnits = Math.max(Number(tokenDoc?.width) || 1, 1);
    const heightUnits = Math.max(Number(tokenDoc?.height) || 1, 1);
    return {
        width: widthUnits * gridSize,
        height: heightUnits * gridSize
    };
}

function isInSceneBounds(x, y, tokenDoc, sceneRect, gridSize)
{
    if (!sceneRect) return true;

    const size = getTokenPixelSize(tokenDoc, gridSize);
    return x >= sceneRect.minX
        && y >= sceneRect.minY
        && (x + size.width) <= sceneRect.maxX
        && (y + size.height) <= sceneRect.maxY;
}

function hasWallCollision(origin, destination)
{
    const RayCtor = foundry?.canvas?.geometry?.Ray ?? globalThis.Ray;
    if (typeof RayCtor !== "function") return false;

    const ray = new RayCtor(origin, destination);

    try
    {
        const wallCollision = canvas?.walls?.checkCollision?.(ray, { type: "move", mode: "any" });
        if (Array.isArray(wallCollision)) return wallCollision.length > 0;
        if (wallCollision !== undefined) return Boolean(wallCollision);
    }
    catch (_error)
    {
        // Fall through to backend check.
    }

    try
    {
        const collision = CONFIG?.Canvas?.polygonBackends?.move?.testCollision?.(origin, destination, {
            type: "move",
            mode: "any"
        });
        if (Array.isArray(collision)) return collision.length > 0;
        if (collision !== undefined) return Boolean(collision);
    }
    catch (_error)
    {
        return false;
    }

    return false;
}

function getPointKey(point)
{
    return `${point.x}:${point.y}`;
}

function buildSpiralOffsets(maxRings)
{
    const offsets = [];
    for (let ring = 1; ring <= maxRings; ring++)
    {
        for (let x = -ring; x <= ring; x++)
        {
            offsets.push({ x, y: -ring });
            offsets.push({ x, y: ring });
        }

        for (let y = (-ring + 1); y <= (ring - 1); y++)
        {
            offsets.push({ x: -ring, y });
            offsets.push({ x: ring, y });
        }
    }

    return offsets;
}

function getAnchorCenter(anchorDocument, gridSize)
{
    const anchorX = Number(anchorDocument?.x) || 0;
    const anchorY = Number(anchorDocument?.y) || 0;
    const anchorWidth = Math.max(Number(anchorDocument?.width) || 1, 1) * gridSize;
    const anchorHeight = Math.max(Number(anchorDocument?.height) || 1, 1) * gridSize;

    return {
        x: anchorX + (anchorWidth / 2),
        y: anchorY + (anchorHeight / 2)
    };
}

function getTokenCenter(position, tokenDoc, gridSize)
{
    const size = getTokenPixelSize(tokenDoc, gridSize);
    return {
        x: position.x + (size.width / 2),
        y: position.y + (size.height / 2)
    };
}

function clampToScene(position, tokenDoc, sceneRect, gridSize)
{
    if (!sceneRect) return position;

    const size = getTokenPixelSize(tokenDoc, gridSize);
    const minX = sceneRect.minX;
    const minY = sceneRect.minY;
    const maxX = sceneRect.maxX - size.width;
    const maxY = sceneRect.maxY - size.height;

    return {
        x: Math.max(minX, Math.min(position.x, maxX)),
        y: Math.max(minY, Math.min(position.y, maxY))
    };
}

function pickPositionForToken({
    tokenDoc,
    baseX,
    baseY,
    anchorCenter,
    gridSize,
    includeAnchorSlot,
    usedPositions,
    sceneRect,
    candidateOffsets
})
{
    const initial = { x: baseX, y: baseY };
    if (includeAnchorSlot
        && isInSceneBounds(initial.x, initial.y, tokenDoc, sceneRect, gridSize)
        && !usedPositions.has(getPointKey(initial)))
    {
        return initial;
    }

    for (const offset of candidateOffsets)
    {
        const candidate = {
            x: baseX + (offset.x * gridSize),
            y: baseY + (offset.y * gridSize)
        };

        if (usedPositions.has(getPointKey(candidate))) continue;
        if (!isInSceneBounds(candidate.x, candidate.y, tokenDoc, sceneRect, gridSize)) continue;

        const destinationCenter = getTokenCenter(candidate, tokenDoc, gridSize);
        if (hasWallCollision(anchorCenter, destinationCenter)) continue;

        return candidate;
    }

    for (const offset of candidateOffsets)
    {
        const fallback = {
            x: baseX + (offset.x * gridSize),
            y: baseY + (offset.y * gridSize)
        };

        if (usedPositions.has(getPointKey(fallback))) continue;
        if (!isInSceneBounds(fallback.x, fallback.y, tokenDoc, sceneRect, gridSize)) continue;
        return fallback;
    }

    const clamped = clampToScene(initial, tokenDoc, sceneRect, gridSize);
    return clamped;
}

export async function createWallAwareTokenDataForActors(actors, {
    anchorDocument,
    includeAnchorSlot = false,
    maxRings = 20
} = {})
{
    if (!Array.isArray(actors) || actors.length < 1) return [];
    if (!anchorDocument) return [];

    const gridSize = getGridSize();
    const baseX = Number(anchorDocument.x) || 0;
    const baseY = Number(anchorDocument.y) || 0;
    const sceneRect = getSceneRect();
    const anchorCenter = getAnchorCenter(anchorDocument, gridSize);
    const candidateOffsets = buildSpiralOffsets(Math.max(Number(maxRings) || 1, 1));

    const usedPositions = new Set();
    const tokenData = [];

    for (let index = 0; index < actors.length; index++)
    {
        const actor = actors[index];
        if (!(actor instanceof Actor)) continue;

        const tokenDoc = await actor.getTokenDocument({
            x: baseX,
            y: baseY
        });

        const position = pickPositionForToken({
            tokenDoc,
            baseX,
            baseY,
            anchorCenter,
            gridSize,
            includeAnchorSlot: includeAnchorSlot && index === 0,
            usedPositions,
            sceneRect,
            candidateOffsets
        });

        usedPositions.add(getPointKey(position));
        const tokenObject = tokenDoc.toObject();
        tokenObject.x = position.x;
        tokenObject.y = position.y;
        tokenData.push(tokenObject);
    }

    return tokenData;
}
