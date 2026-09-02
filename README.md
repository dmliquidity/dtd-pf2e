# DTD PF2e

Deathtrap Dungeons homebrew content for Pathfinder 2e in Foundry VTT.

Currently ships the custom weapon property runes used in the **Seven Dooms for Sandpoint**
game, with full automation for the `sectioned` rune.

## Install

**In Foundry:** *Add-on Modules → Install Module*, and paste this manifest URL:

```
https://github.com/dmliquidity/dtd-pf2e/releases/latest/download/module.json
```

**Local (development):** symlink or copy this folder into your Foundry data directory, then enable it in
*Manage Modules*.

```bash
ln -s /home/michael/Documents/7dosp/modules/dtd-pf2e \
      ~/.local/share/FoundryVTT/Data/modules/dtd-pf2e
```

**Forge:** zip the `dtd-pf2e` folder and upload it through the Forge's *Install Module →
Upload* option. The folder name must stay `dtd-pf2e`, matching the `id` in `module.json`.

On first load in a world, a GM gets the module's items in a **DTD PF2e** item folder, a
**DTD Homebrew Runes** journal, and a **Sectioned: Unfold / Refold** macro. It runs again
after a module update so new content reaches worlds that already have it installed. Turn
that off with the *Install content automatically* setting, or re-run it any time:

```js
game.modules.get("dtd-pf2e").api.install();
```

Re-running is safe — items are matched on slug, so nothing duplicates or gets overwritten.

## Restocking shops at the table

`/inventory 5` rolls a fresh, level-appropriate stock list for the selected shop and writes it
onto the actor — no prep, no editing item lists mid-session.

Select the shop's token (or have exactly one merchant sheet open) and type it in chat:

```
/inventory 5                  restock at level 5
/inventory                    restock at the level last used for this shop, else party level
/inventory 5 --add            keep what's on the shelves and add to it
/inventory 5 --replace -c 5   sell 5 items on, bring 5 new in, leave the rest
/inventory 5 --count 12       stock 12 items instead of the profile's default
/inventory 5 --profile smith  force a profile
/inventory undo               put the previous stock back
/inventory list               show every profile and the shops using it
```

Only a GM can run it. Each restock whispers a GM card listing what landed on the shelves, the
total value, and which profile it used.

`/inventory undo` reverses the last run either way — replacing *or* adding — restoring the shop
to exactly how it stood before the command.

`--replace` rotates the shelf instead of resetting it — the shop looks like a week has passed
rather than like it was rebuilt. `--count` sets how many items turn over (a quarter of the
profile's stock list if you don't say). What sells is chosen at random, what comes in is never
something the shop already had or has just sold, and anything in the profile's guaranteed stock is
never rotated out — a party that could buy healing yesterday can buy it today.

`--add` is a switch and takes no value. `/inventory 6 --add 5` reads that 5 as a **level**, not an
item count, so it quietly restocks at 5 — you'll now get a warning when two levels are given. For a
count, say so: `/inventory 6 --add --count 5`.

Flags tolerate the chat box's smart typography: it rewrites `--` as an em dash as you type, so
`--add`, `—add`, `–add` and `-a` are all accepted. Anything the parser doesn't recognise is
reported rather than silently ignored.

`--profile lootcache` stocks homebrew items that live in no compendium, matched on a slug
prefix rather than on type and traits. That is how the Runewatchers sell the Thassilonian
oddments: fifty world items whose slugs all start `oddment-`, ten on the shelf at a time.

### What each shop sells

`data/shop-profiles.json` maps every Sandpoint shop to a stocking profile — an armory draws arms,
ammunition and runes; a tavern draws drink; a tannery draws leather and never anything magical.
Shops match on name, so `16. The Pillbug's Pantry (Aliver Podiker)` still resolves to the
premium-alchemist profile. Pin a profile to an actor permanently with:

```js
actor.setFlag("dtd-pf2e", "shopProfile", "alchemist_premium");
```

The level you pass is a ceiling. Profiles can cap lower — a tannery stays at level 1 whatever you
type, because nobody sells a level-9 belt. Staple goods (rope at the general store, healing potions
at the alchemist) are always stocked; a few top-end pieces are guaranteed so the level shows; the
rest is weighted toward the cheap end, because a shop is mostly rope.

Any shop that could plausibly sell healing — both alchemists, Hannah's and the cathedral —
**always stocks every grade of healing potion at or below the level**, guaranteed, ahead of
everything else and not subject to the item count. At level 7 that is Minor, Lesser and Moderate;
at level 3, Minor and Lesser. The alchemists carry Elixirs of Life on the same terms. A party
should never be unable to buy healing because the dice didn't offer any.

A shop that carries a graded item carries the **best grade it can get**: stock Elixir of Life
(Minor) at 7th level and the (Lesser) comes with it, because level weighting alone buries the
upgrades — level 5 is three times less likely to be drawn than level 1, so the expensive shelf
never appeared. Grades recognised: minor, lesser, moderate, greater, major, true.

Stock comes from the compendia named in the module settings (`pf2e.equipment-srd` by default) and,
unless you turn it off, this world's own Items directory — which is how the homebrew food and drink
reach the taverns.

The profile file is generated from the campaign database:

```bash
source .venv/bin/activate && cd app && python build_shop_profiles.py
```

### From a macro

```js
const api = game.modules.get("dtd-pf2e").api;
await api.restock(api.resolveShop(), { level: 5 });
```

`restock(actor, options)` takes `level`, `count`, `add`, `profile` and `quiet`. Pass `quiet: true`
to skip the per-shop chat card — worth it when restocking more than one shop at once.

**Shuffle every selected shop.** Select the shop tokens on the scene and run:

```js
const api = game.modules.get("dtd-pf2e").api;
const level = 6;

const shops = canvas.tokens.controlled.map(t => t.actor).filter(a => a?.type === "loot");
if (!shops.length) return ui.notifications.warn("Select one or more shop tokens first.");

const done = [];
for (const shop of shops) {
    const created = await api.restock(shop, { level, quiet: true });
    done.push(`${shop.name} — ${created?.length ?? 0} items`);
}

ChatMessage.create({
    whisper: ChatMessage.getWhisperRecipients("GM").map(u => u.id),
    content: `<h3>Restocked at level ${level}</h3><p>${done.join("<br>")}</p>`,
});
```

Each shop still picks its own profile by name, so one run restocks the armory with arms and the
tavern with drink. `/inventory undo` works per shop afterwards, on whichever token you select.

## The runes

Eleven homebrew weapon property runes, item level 3–7. Full text lives in the
**DTD Homebrew Runes** journal the module installs; they're also stocked as runestones at
the Sandpoint Boutique (Murkal) loot actor.

None of them exist in the PF2e system's rune dropdown — the system's rune tables aren't
exposed on `CONFIG.PF2E`, so registering new ones would mean patching system internals and
breaking on every update. Etch a rune by renaming the weapon
(*+1 striking reeling longsword*) and adding a rule element to its Rules tab:

| Rune | Implementation |
|---|---|
| Tolling, Waltzing, Reeling, Addling, Greater Reeling, Stilling | `Note` RE, selector `{item|_id}-damage`, outcome `criticalSuccess` |
| Guarding | `AdjustStrike`, property `weapon-traits`, value `parry` |
| Sectioned | Handled by this module — see below |
| Wedging, Shrouded, Truing | GM adjudication, no rule element |

Example `Note` for *reeling*:

```json
{
  "key": "Note",
  "selector": "{item|_id}-damage",
  "outcome": ["criticalSuccess"],
  "title": "Reeling",
  "text": "The target is off-guard to you until the end of your next turn."
}
```

## Magic items

| Item | Level | Price | Runes | Spells |
|---|---|---|---|---|
| Flicker's Staff | 6 | 230 gp | — | Cantrips *telekinetic hand*, *telekinetic rend*; *soothe* 1st–2nd |
| Flicker's Staff (Sectioned) | 8 | 735 gp | +1 *sectioned* | adds *soothe* 3rd |
| Flicker's Staff (Striking) | 10 | 1,250 gp | +1 striking *sectioned* | adds *breathe fire*, *blazing bolt*, *fireball*, *ice storm* |
| Flicker's Staff (Flaming) | 12 | 3,550 gp | +2 striking *flaming* *sectioned* | adds *howling blizzard* |

FlickerStitch's signature item, as an upgrade path. Ranked spells follow The Oscillating Wave's granted list, so
everything on the staves is already on his spell list. Prices are the official staff curve for the highest spell
rank, plus rune costs.


Staff spell lists are read from the item description's `@UUID` list — the same format the
official staves use — so the [PF2e Staves](https://github.com/reonZ/pf2e-staves) module picks
them up automatically if you use it.

## Sectioned

The one rune with moving parts. The weapon unfolds into chain-linked segments: it gains
**reach**, takes a −2 circumstance penalty against adjacent creatures, and deals 1d4
persistent bleed on a critical hit.

Use the **Sectioned: Unfold / Refold** macro with a token selected, or call:

```js
game.modules.get("dtd-pf2e").api.toggleSectioned();   // controlled token or assigned character
game.modules.get("dtd-pf2e").api.toggleSectioned(actor);
```

Adding the effect prompts for which weapon it applies to. From there the four rule elements
on `Effect: Sectioned (Unfolded)` do the work:

- `ChoiceSet` — stores the chosen weapon's id in a flag
- `AdjustStrike` — adds the `reach` trait to that weapon only
- `FlatModifier` — −2 circumstance to attack rolls, predicated on `target:distance ≤ 5`
  (the same mechanism the system uses for the volley trait)
- `DamageDice` — 1d4 persistent bleed, `critical: true`, so it only lands on a crit

The adjacent-target penalty needs a **targeted token** to evaluate the distance. Without a
target, PF2e can't measure range and the penalty won't apply — same caveat as volley.

## Layout

```
dtd-pf2e/
├── module.json
├── README.md
├── data/
│   ├── items.json      Effect: Sectioned (Unfolded), Unfold Sectioned Weapon,
│   │                   Flicker's Staff
│   └── journal.json    DTD Homebrew Runes reference
└── scripts/
    └── dtd-pf2e.js     install() + toggleSectioned()
```

Adding more content: drop it into `data/items.json` with a unique `system.slug` and it gets
picked up on the next `install()` call.

## Legal

Unofficial homebrew content. Not published, endorsed, or specifically approved by Paizo.
Pathfinder and Seven Dooms for Sandpoint are trademarks of Paizo Inc.; this module contains
no Paizo rules text, only original homebrew that references it. Module code is MIT
licensed — see `LICENSE`.
