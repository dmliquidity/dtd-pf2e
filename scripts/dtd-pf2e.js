/**
 * DTD PF2e — Deathtrap Dungeons homebrew content for Pathfinder 2e.
 *
 * Installs the homebrew rune support items into the world and provides a toggle
 * for the `sectioned` rune's unfolded state.
 */

const MODULE_ID = "dtd-pf2e";
const FOLDER_NAME = "DTD PF2e";
const EFFECT_SLUG = "effect-sectioned-unfolded";
const MACRO_NAME = "Sectioned: Unfold / Refold";

/** Pull the item templates shipped with the module. */
async function loadItemData() {
    const response = await fetch(`modules/${MODULE_ID}/data/items.json`);
    if (!response.ok) throw new Error(`${MODULE_ID} | could not read data/items.json`);
    return (await response.json()).items;
}

/** Pull the rune reference journal shipped with the module. */
async function loadJournalData() {
    const response = await fetch(`modules/${MODULE_ID}/data/journal.json`);
    if (!response.ok) throw new Error(`${MODULE_ID} | could not read data/journal.json`);
    return response.json();
}

/** Find (or create) the folder the module's items live in. */
async function getFolder() {
    const existing = game.folders.find((f) => f.name === FOLDER_NAME && f.type === "Item");
    if (existing) return existing;
    return Folder.create({ name: FOLDER_NAME, type: "Item", color: "#5b2333" });
}

/**
 * Create any of the module's items that aren't in the world yet. Safe to re-run:
 * items are matched on their slug, so nothing is duplicated or overwritten.
 */
async function install({ notify = true } = {}) {
    if (!game.user.isGM) return ui.notifications.warn("Only a GM can install DTD PF2e content.");

    const templates = await loadItemData();
    const folder = await getFolder();
    const present = new Set(game.items.map((i) => i.system.slug));
    const toCreate = templates
        .filter((t) => !present.has(t.system.slug))
        .map((t) => ({ ...t, folder: folder.id }));

    if (toCreate.length) await Item.createDocuments(toCreate);

    const journalData = await loadJournalData();
    let journalCreated = false;
    if (!game.journal.getName(journalData.name)) {
        await JournalEntry.create(journalData);
        journalCreated = true;
    }

    let macro = game.macros.find((m) => m.name === MACRO_NAME);
    if (!macro) {
        macro = await Macro.create({
            name: MACRO_NAME,
            type: "script",
            img: "icons/commodities/treasure/token-runed-mem-red.webp",
            command: `game.modules.get("${MODULE_ID}").api.toggleSectioned();`,
        });
    }

    await game.settings.set(MODULE_ID, "installed", true);
    await game.settings.set(MODULE_ID, "installedVersion", game.modules.get(MODULE_ID).version);
    if (notify) {
        ui.notifications.info(
            toCreate.length || journalCreated
                ? `DTD PF2e: ${toCreate.length} item(s) installed into the "${FOLDER_NAME}" folder` +
                  (journalCreated ? ", plus the rune reference journal." : ".")
                : "DTD PF2e: content already up to date."
        );
    }
    return { created: toCreate.length, journal: journalCreated, macro: macro?.name };
}

/** Resolve the actor to act on: the controlled token first, then the assigned character. */
function resolveActor(actor) {
    const resolved = actor ?? canvas.tokens?.controlled[0]?.actor ?? game.user.character;
    if (!resolved) ui.notifications.warn("Select a token or assign a character first.");
    return resolved ?? null;
}

/**
 * Unfold or refold a sectioned weapon: adds the effect if absent, removes it if present.
 * The effect prompts for which weapon it applies to when it's added.
 */
async function toggleSectioned(actor) {
    const target = resolveActor(actor);
    if (!target) return;

    const existing = target.itemTypes.effect.find((e) => e.system.slug === EFFECT_SLUG);
    if (existing) {
        await existing.delete();
        ui.notifications.info(`${target.name} refolds the sectioned weapon.`);
        return;
    }

    const source = game.items.find((i) => i.system.slug === EFFECT_SLUG);
    if (!source) {
        ui.notifications.error(
            'DTD PF2e: the "Effect: Sectioned (Unfolded)" item is missing — run game.modules.get("dtd-pf2e").api.install().'
        );
        return;
    }

    await target.createEmbeddedDocuments("Item", [source.toObject()]);
    ui.notifications.info(`${target.name} unfolds the sectioned weapon.`);
}

Hooks.once("init", () => {
    game.settings.register(MODULE_ID, "installed", {
        name: "Content installed",
        scope: "world",
        config: false,
        type: Boolean,
        default: false,
    });

    game.settings.register(MODULE_ID, "installedVersion", {
        name: "Installed content version",
        scope: "world",
        config: false,
        type: String,
        default: "",
    });

    game.settings.register(MODULE_ID, "autoInstall", {
        name: "Install content automatically",
        hint: "Create the DTD PF2e content in this world on first load, and add anything new after a module update.",
        scope: "world",
        config: true,
        type: Boolean,
        default: true,
    });
});

Hooks.once("ready", async () => {
    const module = game.modules.get(MODULE_ID);
    module.api = { ...(module.api ?? {}), install, toggleSectioned };

    if (!game.user.isGM) return;
    if (!game.settings.get(MODULE_ID, "autoInstall")) return;

    // Re-runs after a module update so new content lands in existing worlds.
    // Nothing is duplicated: install() skips items already present by slug.
    const version = game.modules.get(MODULE_ID).version;
    if (game.settings.get(MODULE_ID, "installedVersion") === version) return;

    await install({ notify: true });
});
