/**
 * DTD PF2e — table-side shop restocking.
 *
 * `/inventory 5` rolls a fresh, level-appropriate stock list for the selected
 * merchant and writes it straight onto the actor. What each shop carries comes
 * from data/shop-profiles.json, generated from the campaign database, so
 * Savah's Armory stocks arms and the Rusty Dragon stocks drink.
 *
 * The stock it replaces is kept on the actor, so `/inventory undo` puts it back.
 */

const MODULE_ID = "dtd-pf2e";
const FLAG_BACKUP = "stockBackup";
const FLAG_PROFILE = "shopProfile";
const FLAG_LEVEL = "lastLevel";
const DEFAULT_PACKS = "pf2e.equipment-srd";
const MAX_BACKUP_ITEMS = 200;

/** data/shop-profiles.json, loaded once. */
let CATALOG = null;

/* ------------------------------------------------------------------ data -- */

async function loadCatalog() {
    if (CATALOG) return CATALOG;
    const response = await fetch(`modules/${MODULE_ID}/data/shop-profiles.json`);
    if (!response.ok) throw new Error(`${MODULE_ID} | could not read data/shop-profiles.json`);
    CATALOG = await response.json();
    return CATALOG;
}

/** "16. The Pillbug's Pantry (Aliver Podiker)" -> "thepillbugspantry" */
function normalizeName(name) {
    return String(name ?? "")
        .replace(/^\s*\d+[.)]\s*/, "")
        .replace(/\([^)]*\)/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "");
}

/**
 * Which stocking profile this actor uses: an explicit flag wins, then a name
 * match against the shop directory, then the general store as a fallback.
 */
function resolveProfile(actor, requested) {
    const { profiles, shops } = CATALOG;
    if (requested) {
        if (!profiles[requested]) return { error: `Unknown profile "${requested}".` };
        return { key: requested, profile: profiles[requested], source: "requested" };
    }

    const flagged = actor.getFlag(MODULE_ID, FLAG_PROFILE);
    if (flagged && profiles[flagged]) {
        return { key: flagged, profile: profiles[flagged], source: "actor flag" };
    }

    const key = normalizeName(actor.name);
    const shop = shops.find((s) => s.match === key)
        ?? shops.find((s) => s.match && (key.includes(s.match) || s.match.includes(key)));
    if (shop && profiles[shop.profile]) {
        return { key: shop.profile, profile: profiles[shop.profile], source: shop.name };
    }

    return { key: "general", profile: profiles.general, source: "no match — fell back" };
}

/* --------------------------------------------------------------- matching -- */

function itemLevel(entry) {
    return entry.system?.level?.value ?? 0;
}

function priceGp(entry) {
    const p = entry.system?.price?.value ?? {};
    return (p.pp ?? 0) * 10 + (p.gp ?? 0) + (p.sp ?? 0) / 10 + (p.cp ?? 0) / 100;
}

/** Ported from the Python shop builder: cheap things pile up, dear things don't. */
function defaultQuantity(entry) {
    const gp = priceGp(entry);
    const level = itemLevel(entry);
    if (gp <= 1) return 6;
    if (level === 0) return 3;
    return level <= 2 ? 2 : 1;
}

/** One filter clause: types, categories, traits and a name pattern. */
function matchesClause(entry, clause) {
    const sys = entry.system ?? {};
    if (clause.types && !clause.types.includes(entry.type)) return false;

    // Homebrew stock that lives in no compendium is matched on its slug prefix.
    if (clause.slugPrefix && !String(sys.slug ?? "").startsWith(clause.slugPrefix)) return false;

    const category = sys.category ?? null;
    if (clause.excludeCategories?.includes(category)) return false;

    const byType = clause.categoriesByType?.[entry.type];
    if (byType && !byType.includes(category)) return false;

    const traits = new Set(sys.traits?.value ?? []);
    if (clause.traitsNone?.some((t) => traits.has(t))) return false;

    const tests = [];
    if (clause.traitsAny) tests.push(clause.traitsAny.some((t) => traits.has(t)));
    if (clause.categories) tests.push(clause.categories.includes(category));
    if (clause.namePattern) tests.push(new RegExp(clause.namePattern, "i").test(entry.name));
    if (!tests.length) return true;
    return clause.matchAny ? tests.some(Boolean) : tests.every(Boolean);
}

/**
 * Level and rarity gate everything; then either the profile's own clause, or —
 * for shops that sell two unrelated things, like a smith with weapons and runes
 * — any one of its `anyOf` clauses.
 */
function matchesProfile(entry, profile, cap) {
    if (itemLevel(entry) > cap) return false;
    const rarity = entry.system?.traits?.rarity ?? "common";
    if (profile.rarity && !profile.rarity.includes(rarity)) return false;

    if (profile.anyOf) return profile.anyOf.some((clause) => matchesClause(entry, clause));
    return matchesClause(entry, profile);
}

/* ----------------------------------------------------------------- pools -- */

const INDEX_FIELDS = [
    "system.level.value",
    "system.price.value",
    "system.traits.value",
    "system.traits.rarity",
    "system.category",
    "system.slug",
];

/** Every candidate the configured packs (and optionally the world) can offer. */
async function buildPool(profile, cap, packIds) {
    const pool = [];
    const seen = new Set();

    const push = (entry, source) => {
        const slug = entry.system?.slug ?? normalizeName(entry.name);
        if (seen.has(slug)) return;
        if (!matchesProfile(entry, profile, cap)) return;
        seen.add(slug);
        pool.push({ ...entry, slug, source });
    };

    for (const id of packIds) {
        const pack = game.packs.get(id);
        if (!pack) {
            ui.notifications.warn(`DTD PF2e: compendium "${id}" not found — skipping it.`);
            continue;
        }
        const index = await pack.getIndex({ fields: INDEX_FIELDS });
        for (const entry of index) push(entry, id);
    }

    if (game.settings.get(MODULE_ID, "inventoryWorldItems")) {
        for (const item of game.items) {
            if (item.system?.quantity === undefined) continue; // not a physical item
            push(item.toObject(), "world");
        }
    }

    return pool;
}

/** Grade suffixes PF2e uses for tiered consumables and items. */
const GRADES = ["minor", "lesser", "moderate", "greater", "major", "true"];
const GRADE_RGX = new RegExp(`-(${GRADES.join("|")})$`);

/** "elixir-of-life-minor" -> "elixir-of-life"; null when the slug isn't graded. */
function familyOf(slug) {
    const match = GRADE_RGX.exec(slug ?? "");
    return match ? slug.slice(0, match.index) : null;
}

/**
 * Families the shop always carries in full: every grade at or below the level
 * cap, guaranteed ahead of everything else and not subject to the item count.
 * A party should never be unable to buy healing because the weighting happened
 * not to offer any.
 */
function addFullLadders(pool, take, families) {
    for (const family of families ?? []) {
        for (const entry of pool) {
            if (familyOf(entry.slug) === family) take(entry);
        }
    }
}

/**
 * A shop that carries a graded item carries the best grade it can get hold of.
 * Without this the level weighting buries the upgrades: a 7th-level alchemist
 * stocks Elixir of Life (Minor) and never the Lesser sitting right beside it in
 * the pool, because level 5 is three times less likely to be drawn than level 1.
 */
function addBestTiers(pool, chosen, take, count) {
    const best = new Map();
    for (const entry of pool) {
        const family = familyOf(entry.slug);
        if (!family) continue;
        const held = best.get(family);
        if (!held || itemLevel(entry) > itemLevel(held)) best.set(family, entry);
    }
    for (const entry of [...chosen.values()]) {
        if (chosen.size >= count) break;
        const family = familyOf(entry.slug);
        if (family) take(best.get(family));
    }
}

/**
 * Choose the stock. Staples always make it, a handful of top-end pieces are
 * guaranteed so the level actually shows on the shelf, and the rest is weighted
 * toward the cheap end — a shop is mostly rope.
 */
function chooseStock(pool, profile, count, cap) {
    const bias = profile.levelBias ?? 1;
    const chosen = new Map();
    const take = (entry) => {
        if (entry && !chosen.has(entry.slug)) chosen.set(entry.slug, entry);
    };

    addFullLadders(pool, take, profile.alwaysStock);

    for (const slug of profile.staples ?? []) {
        if (chosen.size >= count) break;
        take(pool.find((e) => e.slug === slug));
    }
    addBestTiers(pool, chosen, take, count);

    const floor = Math.max(1, Math.ceil(cap * 0.6));
    const showcase = pool
        .filter((e) => itemLevel(e) >= floor && !chosen.has(e.slug))
        .sort((a, b) => itemLevel(b) - itemLevel(a));
    const showcaseCount = Math.max(1, Math.round(count * 0.15));
    for (let i = 0; i < showcaseCount && showcase.length; i++) {
        take(showcase.splice(Math.floor(Math.random() * Math.min(6, showcase.length)), 1)[0]);
    }
    addBestTiers(pool, chosen, take, count);

    const rest = pool.filter((e) => !chosen.has(e.slug));
    const weights = rest.map((e) => 1 / (1 + itemLevel(e) * bias));
    let total = weights.reduce((a, b) => a + b, 0);

    while (chosen.size < count && rest.length) {
        let roll = Math.random() * total;
        let i = 0;
        while (i < rest.length - 1 && (roll -= weights[i]) > 0) i++;
        total -= weights[i];
        take(rest[i]);
        rest.splice(i, 1);
        weights.splice(i, 1);
    }

    return [...chosen.values()];
}

/** Fetch full documents for the chosen index entries, one call per pack. */
async function hydrate(entries) {
    const out = [];
    const byPack = new Map();

    for (const entry of entries) {
        if (entry.source === "world") {
            const item = game.items.get(entry._id);
            if (item) out.push({ entry, data: item.toObject() });
            continue;
        }
        if (!byPack.has(entry.source)) byPack.set(entry.source, []);
        byPack.get(entry.source).push(entry);
    }

    for (const [packId, list] of byPack) {
        const pack = game.packs.get(packId);
        const ids = list.map((e) => e._id);
        let docs = [];
        try {
            docs = await pack.getDocuments({ _id__in: ids });
        } catch {
            docs = (await Promise.all(ids.map((id) => pack.getDocument(id)))).filter(Boolean);
        }
        const byId = new Map(docs.map((d) => [d.id, d]));
        for (const entry of list) {
            const doc = byId.get(entry._id);
            if (doc) out.push({ entry, data: doc.toObject() });
        }
    }

    return out;
}

/* ------------------------------------------------------------------ acts -- */

function packSetting() {
    return String(game.settings.get(MODULE_ID, "inventoryPacks") ?? DEFAULT_PACKS)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

function partyLevel() {
    const levels = game.actors
        .filter((a) => a.type === "character" && a.hasPlayerOwner)
        .map((a) => a.system?.details?.level?.value ?? 0);
    return levels.length ? Math.max(...levels) : 1;
}

/** Fisher-Yates, so a shop sells from all over the shelf, not just the front. */
function shuffled(list) {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

/** Everything sellable on the shop — on a loot actor that is all of it. */
function stockOf(actor) {
    return actor.items.filter((i) => i.system?.quantity !== undefined);
}

async function restock(actor, { level, count, add = false, replace = false, quiet = false,
                              profile: requested } = {}) {
    if (!game.user.isGM) {
        ui.notifications.warn("Only a GM can restock a shop.");
        return null;
    }
    await loadCatalog();

    const resolved = resolveProfile(actor, requested);
    if (resolved.error) {
        ui.notifications.error(`DTD PF2e: ${resolved.error} Try /inventory list.`);
        return null;
    }
    const profile = resolved.profile;

    const asked = Number.isFinite(level)
        ? level
        : (actor.getFlag(MODULE_ID, FLAG_LEVEL) ?? partyLevel());
    const cap = Math.max(0, Math.min(asked, profile.levelCap ?? asked));

    // In rotation mode the count is how much of the shelf turns over, so it
    // defaults to a quarter of it rather than the profile's full stock list.
    const wanted = count ?? (replace
        ? Math.max(1, Math.round((profile.count ?? 24) * 0.25))
        : profile.count ?? 24);

    // Pick what sells on. Families the shop always carries are never rotated
    // out — a party that could buy healing yesterday can buy it today.
    const previous = stockOf(actor);
    let removing = [];
    let keep = previous;
    if (replace && previous.length) {
        const promised = new Set(profile.alwaysStock ?? []);
        const rotatable = previous.filter((i) => !promised.has(familyOf(i.system?.slug)));
        removing = shuffled(rotatable).slice(0, wanted);
        const out = new Set(removing.map((i) => i.id));
        keep = previous.filter((i) => !out.has(i.id));
    }

    let pool = await buildPool(profile, cap, packSetting());
    if (replace) {
        // Never restock what is still on the shelf (that would just make second
        // copies), nor what has this moment sold — the point of a rotation is
        // that the shelf looks different afterwards.
        const held = new Set(previous.map((i) => i.system?.slug).filter(Boolean));
        pool = pool.filter((e) => !held.has(e.slug));
    }
    if (!pool.length) {
        ui.notifications.warn(
            `DTD PF2e: nothing matched the "${resolved.key}" profile at level ${cap}. ` +
            "Check the stock compendia in the module settings."
        );
        return null;
    }

    const picked = chooseStock(pool, profile, wanted, cap);
    const hydrated = await hydrate(picked);

    // Back up whatever is on the shelves whichever mode ran: undo restores the
    // shop to how it stood before the command.
    if (previous.length <= MAX_BACKUP_ITEMS) {
        await actor.setFlag(MODULE_ID, FLAG_BACKUP, {
            at: Date.now(),
            items: previous.map((i) => i.toObject()),
        });
    } else {
        await actor.unsetFlag(MODULE_ID, FLAG_BACKUP);
    }

    if (replace) {
        if (removing.length) {
            await actor.deleteEmbeddedDocuments("Item", removing.map((i) => i.id));
        }
    } else if (!add && previous.length) {
        await actor.deleteEmbeddedDocuments("Item", previous.map((i) => i.id));
    }

    const creates = hydrated.map(({ entry, data }, i) => {
        delete data._id;
        data.folder = null;
        data.sort = (i + 1) * 100000;
        data.system = data.system ?? {};
        data.system.quantity = defaultQuantity(entry);
        data.system.containerId = null;
        return data;
    });
    const created = await actor.createEmbeddedDocuments("Item", creates);

    await actor.setFlag(MODULE_ID, FLAG_LEVEL, asked);

    if (quiet) return created;

    await postCard(actor, {
        created,
        entries: hydrated.map((h) => h.entry),
        profileKey: resolved.key,
        profileLabel: profile.label,
        source: resolved.source,
        cap,
        asked,
        add,
        replace,
        rotated: removing.length,
        kept: keep.length,
        replaced: add || replace ? 0 : previous.length,
        replacedCount: previous.length,
        pool: pool.length,
    });

    return created;
}

async function undo(actor) {
    if (!game.user.isGM) {
        ui.notifications.warn("Only a GM can restock a shop.");
        return null;
    }
    const backup = actor.getFlag(MODULE_ID, FLAG_BACKUP);
    if (!Array.isArray(backup?.items)) {
        ui.notifications.warn(`DTD PF2e: no previous stock saved for ${actor.name}.`);
        return null;
    }

    const current = stockOf(actor);
    if (current.length) await actor.deleteEmbeddedDocuments("Item", current.map((i) => i.id));
    const restored = backup.items.length
        ? await actor.createEmbeddedDocuments("Item", backup.items.map((i) => {
            const data = foundry.utils.deepClone(i);
            delete data._id;
            return data;
        }))
        : [];
    await actor.unsetFlag(MODULE_ID, FLAG_BACKUP);
    ui.notifications.info(`DTD PF2e: restored ${restored.length} item(s) to ${actor.name}.`);
    return restored;
}

/* ------------------------------------------------------------------- ui --- */

const coin = (gp) => (gp >= 1 ? `${Math.round(gp * 10) / 10} gp` : `${Math.round(gp * 100) / 10} sp`);

async function postCard(actor, info) {
    const entryFor = (item, i) =>
        info.entries.find((e) => e.name === item.name) ?? info.entries[i];

    const rows = info.created
        .map((item, i) => {
            const entry = entryFor(item, i);
            const qty = item.system?.quantity ?? 1;
            return `<tr><td>${item.name}${qty > 1 ? ` <em>&times;${qty}</em>` : ""}</td>` +
                `<td style="text-align:right;opacity:.7">L${itemLevel(entry)}</td>` +
                `<td style="text-align:right;opacity:.7">${coin(priceGp(entry))}</td></tr>`;
        })
        .join("");

    const value = info.created.reduce(
        (sum, item, i) => sum + priceGp(entryFor(item, i)) * (item.system?.quantity ?? 1), 0);

    const capNote = info.cap < info.asked ? ` <em>(profile caps at ${info.cap})</em>` : "";
    const replacedNote = info.replace
        ? `${info.rotated} sold on, ${info.created.length} new in, ${info.kept} left on the shelf ` +
          "— <code>/inventory undo</code> puts it back"
        : info.add
        ? `added to ${info.replacedCount} item(s) already on the shelves — <code>/inventory undo</code> puts it back`
        : info.replaced
            ? `replaced ${info.replaced} item(s) — <code>/inventory undo</code> puts them back`
            : "shelves were empty";

    await ChatMessage.create({
        whisper: ChatMessage.getWhisperRecipients("GM").map((u) => u.id),
        speaker: { alias: actor.name },
        content: `
            <div class="dtd-inventory">
                <h3 style="margin:0">${actor.name} — restocked</h3>
                <p style="margin:.25em 0;font-size:.9em">
                    <strong>${info.profileLabel}</strong><br>
                    level ${info.asked}${capNote} ·
                    ${info.created.length} of ${info.pool} candidates ·
                    ${coin(value)} on the shelves<br>
                    <span style="opacity:.7">profile <code>${info.profileKey}</code>
                    (${info.source}) · ${replacedNote}</span>
                </p>
                <table style="width:100%;font-size:.85em">${rows}</table>
            </div>`,
    });
}

/** The shop to act on: a selected token, else a single open loot sheet. */
function resolveShop() {
    const selected = (canvas.tokens?.controlled ?? [])
        .map((t) => t.actor)
        .filter((a) => a?.type === "loot");
    if (selected.length === 1) return selected[0];
    if (selected.length > 1) {
        ui.notifications.warn("DTD PF2e: select a single shop token.");
        return null;
    }

    const open = new Set();
    for (const app of Object.values(ui.windows ?? {})) {
        if (app?.actor?.type === "loot") open.add(app.actor);
    }
    for (const app of foundry.applications?.instances?.values() ?? []) {
        if (app?.actor?.type === "loot") open.add(app.actor);
    }
    if (open.size === 1) return [...open][0];

    ui.notifications.warn(
        open.size
            ? "DTD PF2e: more than one shop sheet is open — select the shop's token instead."
            : "DTD PF2e: select the shop's token (or open its sheet) first."
    );
    return null;
}

async function listProfiles() {
    await loadCatalog();
    const rows = Object.entries(CATALOG.profiles)
        .map(([key, p]) => {
            const shops = CATALOG.shops.filter((s) => s.profile === key).map((s) => s.name);
            return `<tr><td><code>${key}</code></td><td>${p.label}<br>` +
                `<span style="opacity:.6;font-size:.9em">${shops.join(", ") || "&mdash;"}</span></td></tr>`;
        })
        .join("");
    await ChatMessage.create({
        whisper: [game.user.id],
        content: `<h3>Shop profiles</h3><table style="width:100%;font-size:.85em">${rows}</table>
            <p style="font-size:.85em;opacity:.7">Force one with
            <code>/inventory 5 --profile alchemist</code>, or make it stick with
            <code>actor.setFlag("dtd-pf2e", "shopProfile", "alchemist")</code>.</p>`,
    });
}

/* --------------------------------------------------------------- command -- */

/**
 * The chat box applies smart typography as you type, so "--add" arrives as
 * "—add". Map every unicode dash back to a plain hyphen before parsing.
 */
function normalizeDashes(text) {
    return String(text ?? "").replace(/[\u2010-\u2015\u2212]/g, "-");
}

function parse(argString) {
    const opts = { add: false, replace: false, unknown: [] };
    const tokens = normalizeDashes(cleanArgs(argString)).split(/\s+/).filter(Boolean);

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];

        // Any number of leading hyphens, so "-a", "--add" and a smart-dashed
        // "—add" (now "-add") all land here.
        const flag = /^-+([a-z]+)$/i.exec(token);
        if (flag) {
            switch (flag[1].toLowerCase()) {
                case "a": case "add": opts.add = true; break;
                case "r": case "replace": opts.replace = true; break;
                case "c": case "count": opts.count = Number(tokens[++i]); break;
                case "p": case "profile": opts.profile = tokens[++i]; break;
                default: opts.unknown.push(token);
            }
            continue;
        }

        if (/^undo$/i.test(token)) opts.undo = true;
        else if (/^(list|profiles)$/i.test(token)) opts.list = true;
        else if (/^\d+$/.test(token)) {
            // A second bare number is nearly always "--add 5" meant as a count.
            // Silently overwriting the level is the worst possible reading.
            if (opts.level !== undefined) opts.extraNumbers = true;
            opts.level = Number(token);
        } else opts.unknown.push(token);
    }

    if (opts.count !== undefined && !Number.isFinite(opts.count)) delete opts.count;
    return opts;
}

async function handle(argString) {
    const opts = parse(argString);
    if (opts.unknown.length) {
        ui.notifications.warn(
            `DTD PF2e: ignored ${opts.unknown.join(", ")}. Flags are --add, --count N, --profile KEY.`);
    }
    if (opts.add && opts.replace) {
        ui.notifications.warn("DTD PF2e: --add and --replace are different modes; using --replace.");
        opts.add = false;
    }
    if (opts.extraNumbers) {
        ui.notifications.warn(
            `DTD PF2e: more than one level given — using ${opts.level}. ` +
            "--add takes no value; for an item count use --count N.");
    }
    if (opts.list) return listProfiles();

    const actor = resolveShop();
    if (!actor) return;
    if (opts.undo) return undo(actor);

    try {
        await restock(actor, opts);
    } catch (error) {
        console.error(`${MODULE_ID} | restock failed`, error);
        ui.notifications.error(`DTD PF2e: restock failed — ${error.message}`);
    }
}

Hooks.once("init", () => {
    game.settings.register(MODULE_ID, "inventoryPacks", {
        name: "Shop stock compendia",
        hint: "Comma-separated compendium ids that /inventory draws stock from.",
        scope: "world",
        config: true,
        type: String,
        default: DEFAULT_PACKS,
    });

    game.settings.register(MODULE_ID, "inventoryWorldItems", {
        name: "Stock shops from world items too",
        hint: "Also draw on this world's Items directory — the homebrew food, drink and gear.",
        scope: "world",
        config: true,
        type: Boolean,
        default: true,
    });
});

Hooks.once("ready", () => {
    const module = game.modules.get(MODULE_ID);
    module.api = { ...(module.api ?? {}), restock, undoRestock: undo, listProfiles, resolveShop };

    if (game.user.isGM) loadCatalog().catch((e) => console.error(`${MODULE_ID} |`, e));
});

/**
 * Strip the wrapper the ProseMirror chat input adds, the same way core's
 * ChatLog.parse does — in v14 a typed command arrives as "<p>/inventory 5</p>".
 */
function unwrap(message) {
    return cleanArgs(String(message ?? ""));
}

/**
 * Strip the chat editor's markup out of a command's arguments.
 *
 * A typed command can arrive as "<p>/inventory 5</p><p></p>" or with a stray
 * <br>, and without this the tags end up inside the argument string — a profile
 * key of "alchemist</p><p>" matches nothing and reports nothing useful.
 */
function cleanArgs(text) {
    return String(text ?? "")
        .replace(/&nbsp;|\u00a0/gi, " ")
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<\/?[a-z][^>]*>/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#0*39;|&apos;/gi, "'")
        .replace(/\s{2,}/g, " ")
        .trim();
}

// The separator has to tolerate a literal &nbsp; entity: the chat editor
// serialises some spaces that way, and \s does not match a six-character
// HTML entity — which made "/inventory 5" fall through to chat while
// "/inventory 5 --count 6" matched fine.
const COMMAND_RGX = /^(\/inv(?:entory)?)(?:(?:\s|&nbsp;)+([^]*))?$/i;

/** True once the command is registered on ChatLog, so the hook stands down. */
let commandRegistered = false;

/**
 * Register /inventory as a first-class chat command (Foundry v13+). Falls back
 * to the chatMessage hook below on builds that don't expose CHAT_COMMANDS.
 */
function registerChatCommand() {
    const ChatLogClass = foundry.applications?.sidebar?.tabs?.ChatLog;
    const commands = ChatLogClass?.CHAT_COMMANDS;
    if (!commands || commands.dtdInventory) return false;

    commands.dtdInventory = {
        rgx: COMMAND_RGX,
        fn: (_command, match) => {
            if (!game.user.isGM) {
                ui.notifications.warn("Only a GM can restock a shop.");
                return false;
            }
            handle(match?.[2] ?? "");
            return false; // never create a chat message for the command itself
        },
    };
    return true;
}

Hooks.once("ready", () => {
    commandRegistered = registerChatCommand();
    if (!commandRegistered) {
        console.warn(`${MODULE_ID} | ChatLog.CHAT_COMMANDS unavailable; using the chatMessage hook.`);
    }
});

Hooks.on("chatMessage", (_log, message) => {
    if (commandRegistered) return true; // the registered command handles it
    const match = COMMAND_RGX.exec(unwrap(message));
    if (!match) return true;
    if (!game.user.isGM) {
        ui.notifications.warn("Only a GM can restock a shop.");
        return false;
    }
    handle(match[2] ?? "");
    return false;
});
