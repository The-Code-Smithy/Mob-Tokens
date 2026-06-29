import { MORALE_PATH_CANDIDATES } from "../core/constants.js";

const AC_PATH_CANDIDATES = [
    "system.attributes.ac.value",
    "system.attributes.ac.current",
    "system.ac.value",
    "system.ac.current",
    "system.ac",
    "system.armorClass.value",
    "system.armorClass.current",
    "system.defense.ac.value"
];

const OSRIC_MORALE_PATHS = [
    "system.morale",
    "system.morale.value",
    "system.attributes.morale",
    "system.attributes.morale.value"
];

const OSRIC_AC_PATHS = [
    "system.ac",
    "system.ac.value",
    "system.attributes.ac.value",
    ...AC_PATH_CANDIDATES
];

const ADAPTERS = {
    generic: {
        id: "generic",
        moraleEnabledByDefault: true,
        moralePathCandidates: MORALE_PATH_CANDIDATES,
        acPathCandidates: AC_PATH_CANDIDATES,
        defaultMoraleValue: 50,
        defaultArmorClassValue: 10,
        shouldShowMoraleUI: (enabledSetting) => Boolean(enabledSetting)
    },
    dnd5e: {
        id: "dnd5e",
        moraleEnabledByDefault: false,
        moralePathCandidates: MORALE_PATH_CANDIDATES,
        acPathCandidates: AC_PATH_CANDIDATES,
        defaultMoraleValue: 50,
        defaultArmorClassValue: 10,
        shouldShowMoraleUI: (enabledSetting) => Boolean(enabledSetting)
    },
    osric: {
        id: "osric",
        moraleEnabledByDefault: true,
        moralePathCandidates: [...OSRIC_MORALE_PATHS, ...MORALE_PATH_CANDIDATES],
        acPathCandidates: OSRIC_AC_PATHS,
        defaultMoraleValue: 50,
        defaultArmorClassValue: 10,
        shouldShowMoraleUI: (enabledSetting) => Boolean(enabledSetting)
    }
};

export function getCurrentSystemId()
{
    return String(game.system?.id ?? "").trim().toLowerCase();
}

export function getSystemAdapter()
{
    const systemId = getCurrentSystemId();
    return ADAPTERS[systemId] ?? ADAPTERS.generic;
}
