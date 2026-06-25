export const MODULE_ID = "mob-tokens";
export const FLAG_SCOPE = "mob-tokens";
export const UPDATE_GUARD = `${MODULE_ID}.syncing`;
export const BADGE_KEY = `${MODULE_ID}.badge`;

export const HP_PATH_CANDIDATES = [
    { current: "system.attributes.hp.value", max: "system.attributes.hp.max" },
    { current: "system.attributes.hp.current", max: "system.attributes.hp.max" },
    { current: "system.hp.value", max: "system.hp.max" },
    { current: "system.hp.current", max: "system.hp.max" },
    { current: "system.hitPoints.value", max: "system.hitPoints.max" },
    { current: "system.hitPoints.current", max: "system.hitPoints.max" },
    { current: "system.health.value", max: "system.health.max" },
    { current: "system.health.current", max: "system.health.max" }
];

export const MORALE_PATH_CANDIDATES = [
    "system.morale",
    "system.morale.value",
    "system.attributes.morale",
    "system.attributes.morale.value",
    "system.combat.morale",
    "system.combat.morale.value",
    "system.details.morale",
    "system.details.morale.value",
    "system.stats.morale",
    "system.stats.morale.value"
];
