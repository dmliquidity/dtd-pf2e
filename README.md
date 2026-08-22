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

| Item | Level | Price | Notes |
|---|---|---|---|
| Flicker's Staff | 6 | 230 gp | Uncommon staff. Cantrips *telekinetic hand* and *telekinetic rend*; *soothe* at 1st and 2nd rank |
| Flicker's Staff (Sectioned) | 8 | 700 gp | The same staff after Murkal's work: adds 3rd-rank *soothe* and the *sectioned* rune |

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
